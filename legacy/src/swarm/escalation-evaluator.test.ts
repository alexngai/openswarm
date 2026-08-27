/**
 * escalation-evaluator.test.ts — pluggable escalation signals (docs/50 G3 v2).
 */
import { describe, it, expect } from "vitest";
import type { AgentResult } from "./host.js";
import type { EscalationContext, ExecResult, ExecFn } from "./escalation-evaluator.js";
import {
  parseSelfReportConfidence,
  SelfReportEvaluator,
  exitCodeGate,
  parsePytestPassRate,
  CommandEvaluator,
  CompositeEvaluator,
  ScoreEvaluator,
  EvaluatorRegistry,
  defaultEvaluatorRegistry,
} from "./escalation-evaluator.js";

function ok(output: string): AgentResult {
  return { status: "success", output, usage: { inputTokens: 1, outputTokens: 1 }, wallClockMs: 1 };
}
function ctx(output: string, exec?: ExecFn, cwd?: string): EscalationContext {
  return { result: ok(output), index: 0, ...(exec !== undefined && { exec }), ...(cwd !== undefined && { cwd }) };
}
function fakeExec(result: ExecResult): ExecFn {
  return () => Promise.resolve(result);
}
const exec = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({ exitCode, stdout, stderr });

describe("parseSelfReportConfidence", () => {
  it("SOLVED → 1, CONFIDENCE:n → n (clamped), none → 0", () => {
    expect(parseSelfReportConfidence("done\nCASCADE_SOLVED")).toBe(1);
    expect(parseSelfReportConfidence("CASCADE_CONFIDENCE: 0.7")).toBeCloseTo(0.7, 6);
    expect(parseSelfReportConfidence("CASCADE_CONFIDENCE: 2")).toBe(1);
    expect(parseSelfReportConfidence("nothing")).toBe(0);
  });
});

describe("SelfReportEvaluator", () => {
  it("scores from the tier output sentinel", async () => {
    expect(await new SelfReportEvaluator().evaluate(ctx("CASCADE_SOLVED"))).toBe(1);
    expect(await new SelfReportEvaluator().evaluate(ctx("meh"))).toBe(0);
  });
});

describe("exitCodeGate / parsePytestPassRate", () => {
  it("exitCodeGate: 0 → 1, nonzero → 0", () => {
    expect(exitCodeGate(exec(0))).toBe(1);
    expect(exitCodeGate(exec(1))).toBe(0);
  });
  it("pytest pass-rate is graded", () => {
    expect(parsePytestPassRate(exec(1, "3 passed, 1 failed"))).toBeCloseTo(0.75, 6);
    expect(parsePytestPassRate(exec(0, "5 passed"))).toBe(1);
    expect(parsePytestPassRate(exec(1, "2 passed, 1 failed, 1 error"))).toBeCloseTo(0.5, 6);
  });
  it("no recognizable counts → falls back to exit code", () => {
    expect(parsePytestPassRate(exec(0, "collected nothing"))).toBe(1);
    expect(parsePytestPassRate(exec(2, "boom"))).toBe(0);
  });
});

describe("CommandEvaluator", () => {
  it("runs the command and parses a graded pass-rate", async () => {
    const e = new CommandEvaluator({ name: "swe-pytest", command: "pytest -q tests/visible" });
    expect(await e.evaluate(ctx("", fakeExec(exec(1, "9 passed, 1 failed"))))).toBeCloseTo(0.9, 6);
  });
  it("no exec available → 0 (escalate)", async () => {
    const e = new CommandEvaluator({ name: "swe-pytest", command: "pytest" });
    expect(await e.evaluate(ctx("whatever"))).toBe(0);
  });
  it("honors a benchmark-specific parser", async () => {
    const e = new CommandEvaluator({
      name: "fixit-checkpoints",
      command: "grade.sh",
      parse: (r) => Number(/(\d+)\/(\d+)/.exec(r.stdout)?.[1] ?? 0) / Number(/(\d+)\/(\d+)/.exec(r.stdout)?.[2] ?? 1),
    });
    expect(await e.evaluate(ctx("", fakeExec(exec(0, "score 6/8"))))).toBeCloseTo(0.75, 6);
  });
});

describe("CompositeEvaluator", () => {
  const gate = (c: number): { name: string; evaluate: () => Promise<number> } => ({ name: `g${c}`, evaluate: () => Promise.resolve(c) });
  it("takes the weakest link (min)", async () => {
    const comp = new CompositeEvaluator("swe", [gate(1), gate(0.5), gate(0.9)]);
    expect(await comp.evaluate(ctx(""))).toBeCloseTo(0.5, 6);
  });
  it("a single 0 child (e.g. doesn't compile) → 0", async () => {
    const comp = new CompositeEvaluator("swe", [gate(0), gate(1)]);
    expect(await comp.evaluate(ctx(""))).toBe(0);
  });
  it("no children → 0", async () => {
    expect(await new CompositeEvaluator("empty", []).evaluate(ctx(""))).toBe(0);
  });
});

describe("ScoreEvaluator (swarmkit-eval bridge)", () => {
  it("confidence = Score.partial (the graded score / RLVR reward)", async () => {
    const e = new ScoreEvaluator("swe-visible", () => Promise.resolve({ partial: 0.75 }));
    expect(await e.evaluate(ctx(""))).toBeCloseTo(0.75, 6);
  });
  it("null score (can't grade) → 0, escalate", async () => {
    expect(await new ScoreEvaluator("x", () => Promise.resolve(null)).evaluate(ctx(""))).toBe(0);
  });
  it("clamps an out-of-range partial", async () => {
    expect(await new ScoreEvaluator("x", () => Promise.resolve({ partial: 2 })).evaluate(ctx(""))).toBe(1);
    expect(await new ScoreEvaluator("x", () => Promise.resolve({ partial: -0.5 })).evaluate(ctx(""))).toBe(0);
  });
  it("registers/selects like any other evaluator", () => {
    const reg = new EvaluatorRegistry().register(
      new ScoreEvaluator("swe-visible", () => Promise.resolve({ partial: 1 })),
    );
    expect(reg.select("swe-visible")?.name).toBe("swe-visible");
  });
});

describe("EvaluatorRegistry", () => {
  it("registers, selects, and lists benchmark evaluators", () => {
    const reg = new EvaluatorRegistry()
      .register(new CommandEvaluator({ name: "swe-pytest", command: "pytest" }))
      .register(new SelfReportEvaluator());
    expect(reg.select("swe-pytest")?.name).toBe("swe-pytest");
    expect(reg.select("nope")).toBeUndefined();
    expect(reg.select(undefined)).toBeUndefined();
    expect(reg.names().sort()).toEqual(["self-report", "swe-pytest"]);
  });
  it("defaultEvaluatorRegistry seeds self-report", () => {
    expect(defaultEvaluatorRegistry().select("self-report")).toBeInstanceOf(SelfReportEvaluator);
  });
});
