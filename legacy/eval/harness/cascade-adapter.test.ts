/**
 * cascade-adapter.test.ts — the runTopology --output ↔ CascadeAdapter contract (docs/51 B1).
 * Unit-tests the result/trace parsers with a fake workspace; the full run() is a Stage-0 smoke.
 */
import { describe, it, expect } from "vitest";
import { readTeamUsage, readEscalations } from "./cascade-adapter.js";

function fakeWs(files: Record<string, string>): { readFile(p: string): Promise<string | null> } {
  return { readFile: (p: string) => Promise.resolve(files[p] ?? null) };
}
const um = (t: number) => ({
  inputTokens: t,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  totalTokens: t,
  costUsd: 0,
});

describe("readTeamUsage", () => {
  it("extracts the team_usage line (byModel + team) from --output", async () => {
    const results = [
      JSON.stringify({ id: "tier-0", status: "succeeded", usage: { inputTokens: 1 } }),
      JSON.stringify({ type: "team_usage", byModel: { "qwen3-8b": um(110), "qwen3-30b": um(220) }, team: um(330) }),
    ].join("\n");
    const tu = await readTeamUsage(fakeWs({ "r.jsonl": results }), "r.jsonl");
    expect(tu?.team.totalTokens).toBe(330);
    expect(tu?.byModel["qwen3-8b"]?.totalTokens).toBe(110);
    expect(tu?.byModel["qwen3-30b"]?.totalTokens).toBe(220);
  });
  it("undefined when no team_usage line / missing file / garbage", async () => {
    expect(await readTeamUsage(fakeWs({}), "missing")).toBeUndefined();
    expect(await readTeamUsage(fakeWs({ r: "not json\n{oops\n" }), "r")).toBeUndefined();
  });
});

describe("readEscalations", () => {
  it("parses the count from the cascade team_note", async () => {
    const trace = [
      JSON.stringify({ ts: 1, type: "worker_spawned", payload: {} }),
      JSON.stringify({ ts: 2, type: "team_note", payload: { note: 'cascade: accepted tier "30b" after 1 escalation(s); cleared gate at τ=0.5' } }),
    ].join("\n");
    expect(await readEscalations(fakeWs({ t: trace }), "t")).toBe(1);
  });
  it("0 escalations (solved on the cheap tier)", async () => {
    const trace = JSON.stringify({ type: "team_note", payload: { note: 'cascade: accepted tier "8b" after 0 escalation(s); cleared gate at τ=0.5' } });
    expect(await readEscalations(fakeWs({ t: trace }), "t")).toBe(0);
  });
  it("undefined when no note / missing file", async () => {
    expect(await readEscalations(fakeWs({}), "missing")).toBeUndefined();
    expect(await readEscalations(fakeWs({ t: '{"type":"worker_spawned"}\n' }), "t")).toBeUndefined();
  });
});
