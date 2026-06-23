import { describe, it, expect } from "vitest";
import {
  buildMastJudgePrompt,
  parseMastResponse,
  judgeTrace,
  aggregateMast,
  renderMastHistogram,
  type LlmComplete,
  type MastTraceInput,
} from "./judge.js";
import { MAST_MODE_CODES } from "./taxonomy.js";

const input: MastTraceInput = {
  id: "cell-1",
  task: "Fix the failing test in foo.py",
  transcript: "builder: edited foo.py\nverifier: looks fine (did not run tests)\ncoordinator: done",
  outcome: "failure",
};

describe("buildMastJudgePrompt", () => {
  it("enumerates all 14 modes and includes task + outcome", () => {
    const p = buildMastJudgePrompt(input);
    for (const code of MAST_MODE_CODES) expect(p).toContain(code);
    expect(p).toContain("Fix the failing test");
    expect(p).toContain("failure");
  });
});

describe("parseMastResponse", () => {
  it("parses a clean full verdict", () => {
    const modes = MAST_MODE_CODES.map((code) => ({ code, present: code === "FM-3.2", evidence: code === "FM-3.2" ? "verifier did not run tests" : "" }));
    const r = parseMastResponse("c", "failure", JSON.stringify({ modes }));
    expect(r.modes).toHaveLength(14);
    expect(r.modes.find((m) => m.code === "FM-3.2")!.present).toBe(true);
    expect(r.modes.find((m) => m.code === "FM-3.2")!.category).toBe("FC3");
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Here is my assessment:\n```json\n{"modes":[{"code":"FM-2.5","present":true,"evidence":"ignored verifier"}]}\n```\nDone.';
    const r = parseMastResponse("c", "failure", raw);
    expect(r.modes.find((m) => m.code === "FM-2.5")!.present).toBe(true);
  });

  it("defaults omitted modes to not-present and fills all 14", () => {
    const r = parseMastResponse("c", "success", '{"modes":[{"code":"FM-1.3","present":true,"evidence":"re-grepped"}]}');
    expect(r.modes).toHaveLength(14);
    expect(r.modes.filter((m) => m.present)).toHaveLength(1);
  });

  it("ignores unknown codes", () => {
    const r = parseMastResponse("c", "failure", '{"modes":[{"code":"FM-9.9","present":true,"evidence":"x"},{"code":"FM-1.1","present":true,"evidence":"y"}]}');
    expect(r.modes.find((m) => m.code === "FM-1.1")!.present).toBe(true);
    expect(r.modes.some((m) => m.code === "FM-9.9")).toBe(false);
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseMastResponse("c", "failure", "no json here")).toThrow();
  });
});

describe("judgeTrace + aggregateMast", () => {
  it("judges traces and rolls up a per-category histogram", async () => {
    // Mock judge: flags FC3 (no/incorrect verification) — the classic verifier-rubber-stamp.
    const llm: LlmComplete = async () =>
      JSON.stringify({ modes: [{ code: "FM-3.2", present: true, evidence: "verifier did not run tests" }] });

    const reports = await Promise.all(
      [input, { ...input, id: "cell-2" }].map((i) => judgeTrace(i, llm)),
    );
    const h = aggregateMast(reports);
    expect(h.n).toBe(2);
    expect(h.byMode["FM-3.2"]).toBe(2);
    expect(h.byCategory.FC3).toBe(2);
    expect(h.categoryShare.FC3).toBe(1); // only FC3 flagged
    expect(renderMastHistogram(h)).toContain("FC3");
  });
});
