/**
 * offline-frontier.test.ts — the oracle-cascade pre-check math (docs/58).
 */
import { describe, it, expect } from "vitest";
import { reconstructPair, type ModelStat } from "./offline-frontier.js";

const stat = (p: number, fresh: number): ModelStat => ({ p, fresh, total: fresh, n: 1 });

describe("reconstructPair — oracle-cascade pre-check", () => {
  it("Goldilocks pair: cheap tier is genuinely cheaper and owns tasks → oracle dominates", () => {
    // small solves 2/4 at 0.1M each; large solves all at 1.0M each.
    const small = new Map<string, ModelStat>([
      ["t1", stat(1, 0.1e6)],
      ["t2", stat(1, 0.1e6)],
      ["t3", stat(0, 0.1e6)],
      ["t4", stat(0, 0.1e6)],
    ]);
    const large = new Map<string, ModelStat>([
      ["t1", stat(1, 1.0e6)],
      ["t2", stat(1, 1.0e6)],
      ["t3", stat(1, 1.0e6)],
      ["t4", stat(1, 1.0e6)],
    ]);
    const r = reconstructPair("small", "large", small, large)!;
    expect(r.n).toBe(4);
    expect(r.quality.oracle).toBeCloseTo(1.0); // union coverage
    expect(r.axes.fresh.oracle).toBeCloseTo(0.6e6); // 0.1 always + 1.0 on the escalated half
    expect(r.axes.fresh.small).toBeCloseTo(0.1e6);
    expect(r.axes.fresh.large).toBeCloseTo(1.0e6);
    expect(r.axes.fresh.savingsPossible).toBe(true); // 0.1M < 0.5·1.0M
    expect(r.axes.fresh.oracleDominates).toBe(true); // 0.6M < 1.0M at equal quality
    // structure: t1/t2 both-solve, t3/t4 large-only
    expect(r.structure).toEqual({ both: 2, smallOnly: 2 - 2, largeOnly: 2, neither: 0 });
  });

  it("dead pair: cheap tier costs more than the large it saves → structurally dead", () => {
    const small = new Map<string, ModelStat>([
      ["t1", stat(1, 2.0e6)],
      ["t2", stat(1, 2.0e6)],
      ["t3", stat(0, 2.0e6)],
      ["t4", stat(0, 2.0e6)],
    ]);
    const large = new Map<string, ModelStat>([
      ["t1", stat(1, 1.0e6)],
      ["t2", stat(1, 1.0e6)],
      ["t3", stat(1, 1.0e6)],
      ["t4", stat(1, 1.0e6)],
    ]);
    const r = reconstructPair("small", "large", small, large)!;
    expect(r.axes.fresh.savingsPossible).toBe(false); // 2.0M < 0.5·1.0M is false
    expect(r.axes.fresh.oracleDominates).toBe(false); // oracle cost 2.5M > 1.0M
  });

  it("returns undefined when the pair shares no instances", () => {
    const a = new Map<string, ModelStat>([["x", stat(1, 1)]]);
    const b = new Map<string, ModelStat>([["y", stat(1, 1)]]);
    expect(reconstructPair("a", "b", a, b)).toBeUndefined();
  });
});
