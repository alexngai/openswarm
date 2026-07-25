/**
 * humaneval-frontier.test.ts — oracle pre-check + FLOPs frontier over the flat
 * single-shot rows schema (docs/62). Companion to offline-frontier.test.ts.
 */
import { describe, it, expect } from "vitest";
import { analyzePair, attemptFlops, type Row } from "./humaneval-frontier.js";

// Registered params: 8B (C) and 70B (E). Equal tokens (in=out=100) ⇒ FLOPs ratio = 8/70.
const C = "awsbedrock/us.meta.llama3-1-8b-instruct-v1:0";
const E = "awsbedrock/us.meta.llama3-3-70b-instruct-v1:0";
const FC = 2 * 8e9 * 200; // 3.2e12
const FE = 2 * 70e9 * 200; // 2.8e13

const row = (model: string, task_id: string, correct: 0 | 1, sig: number | null = 1): Row => ({
  task_id, model, seed: 1, correct, sig_visible: sig, tok_in: 100, tok_out: 100, tok_total: 200,
});

describe("analyzePair — oracle pre-check + FLOPs frontier", () => {
  it("Goldilocks pair (both/small-only/large-only/neither): matches hand-computed values", () => {
    const rows: Row[] = [
      row(C, "t1", 1), row(E, "t1", 1), // both
      row(C, "t2", 0), row(E, "t2", 1), // large-only
      row(C, "t3", 1), row(E, "t3", 0), // small-only
      row(C, "t4", 0), row(E, "t4", 0), // neither
    ];
    const r = analyzePair(rows, C, E);
    expect(r.nTasks).toBe(4);
    expect(r.structure).toEqual({ both: 1, smallOnly: 1, largeOnly: 1, neither: 1 });
    expect(r.resolveC).toBeCloseTo(0.5);
    expect(r.resolveE).toBeCloseTo(0.5);
    // oracle: escalate iff C wrong (t2,t4). quality = (1 + E@t2 + 1 + E@t4)/4 = (1+1+1+0)/4.
    expect(r.oracle.quality).toBeCloseTo(0.75);
    // flops = fC always + fE on the escalated half (t2,t4) = fC + 0.5·fE.
    expect(r.oracle.flops).toBeCloseTo(FC + 0.5 * FE);
    // pre-check: fC(3.2e12) < resolveC(0.5)·fE(2.8e13)=1.4e13 → PASS.
    expect(r.precheck.pass).toBe(true);
    expect(r.precheck.lhs).toBeCloseTo(FC);
    expect(r.precheck.rhs).toBeCloseTo(0.5 * FE);
    expect(r.monoLargePareto).toBe(true);
  });

  it("dead pair: cheap tier solves nothing → pre-check fails, no expansion", () => {
    const rows: Row[] = [
      row(C, "t1", 0), row(E, "t1", 1),
      row(C, "t2", 0), row(E, "t2", 1),
    ];
    const r = analyzePair(rows, C, E);
    expect(r.resolveC).toBe(0);
    expect(r.precheck.rhs).toBe(0); // resolveC·cost(E) = 0
    expect(r.precheck.pass).toBe(false); // fC > 0 ≥ 0
    expect(r.monoLargePareto).toBe(false); // oracle FLOPs (fC+fE) > mono-E (fE)
  });

  it("attemptFlops throws (loudly) for an unregistered model — never blanks the axis silently", () => {
    expect(() => attemptFlops(row("azureoai/gpt-5.5", "t1", 1))).toThrow(/active-params/);
  });
});
