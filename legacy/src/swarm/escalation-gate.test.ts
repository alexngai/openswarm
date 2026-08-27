/**
 * escalation-gate.test.ts — unit tests for the parametric cascade core (docs/50 G3).
 *
 * Covers the confidence helpers, the τ gate, and the runCascade control flow:
 * accept-on-cheap-tier, escalate-on-low-confidence, hard-failure escalation, the
 * τ-sweep (same attempts → escalation count moves with τ), exhaustion, and the
 * prior-attempts threading a real escalation preamble needs.
 */
import { describe, it, expect } from "vitest";
import {
  confidenceFromTests,
  confidenceFromVerdict,
  combineConfidence,
  shouldEscalate,
  runCascade,
  type CascadeTier,
  type AttemptFn,
} from "./escalation-gate.js";

// A tiny tier list: cheap "8b" → expensive "30b" (payload carries the model id).
const T2: CascadeTier<string>[] = [
  { id: "8b", payload: "qwen3-8b" },
  { id: "30b", payload: "qwen3-30b" },
];
const T3: CascadeTier<string>[] = [
  { id: "4b", payload: "qwen3-4b" },
  { id: "8b", payload: "qwen3-8b" },
  { id: "30b", payload: "qwen3-30b" },
];

/** Build an attempt fn that returns a fixed confidence per tier index. */
function withConfidences(confs: number[], failed: boolean[] = []): AttemptFn<string, string> {
  return (tier, ctx) =>
    Promise.resolve({
      confidence: confs[ctx.index] ?? 0,
      value: `${tier.id}-out`,
      failed: failed[ctx.index] ?? false,
    });
}

describe("confidence helpers", () => {
  it("confidenceFromTests = pass rate; no tests → 0; clamps", () => {
    expect(confidenceFromTests(3, 4)).toBeCloseTo(0.75, 6);
    expect(confidenceFromTests(0, 0)).toBe(0);
    expect(confidenceFromTests(5, 4)).toBe(1);
  });
  it("confidenceFromVerdict is binary", () => {
    expect(confidenceFromVerdict(true)).toBe(1);
    expect(confidenceFromVerdict(false)).toBe(0);
  });
  it("combineConfidence takes the weakest link; empty → 0", () => {
    expect(combineConfidence(0.9, 0.3, 0.6)).toBeCloseTo(0.3, 6);
    expect(combineConfidence()).toBe(0);
  });
  it("shouldEscalate: confidence strictly below τ", () => {
    expect(shouldEscalate(0.4, { tau: 0.5 })).toBe(true);
    expect(shouldEscalate(0.5, { tau: 0.5 })).toBe(false);
  });
});

describe("runCascade", () => {
  it("accepts the cheap tier when it clears the gate (no escalation)", async () => {
    const run = await runCascade(T2, { tau: 0.5 }, withConfidences([0.9, 0.0]));
    expect(run.acceptedTierId).toBe("8b");
    expect(run.escalations).toBe(0);
    expect(run.stoppedEarly).toBe(true);
    expect(run.exhausted).toBe(false);
    expect(run.value).toBe("8b-out");
    expect(run.attempts).toHaveLength(1);
  });

  it("escalates when the cheap tier is below τ, accepts the next tier", async () => {
    const run = await runCascade(T2, { tau: 0.6 }, withConfidences([0.5, 0.95]));
    expect(run.acceptedTierId).toBe("30b");
    expect(run.escalations).toBe(1);
    expect(run.stoppedEarly).toBe(false); // 30b is the top tier
    expect(run.exhausted).toBe(false); // top tier cleared the gate (0.95 ≥ 0.6)
    expect(run.attempts.map((a) => a.escalated)).toEqual([true, false]);
  });

  it("τ-sweep: identical attempts, escalation count moves with τ", async () => {
    const confs = [0.5, 0.9]; // cheap tier confidence = 0.5
    const lo = await runCascade(T2, { tau: 0.4 }, withConfidences(confs)); // 0.5 ≥ 0.4 → keep cheap
    const hi = await runCascade(T2, { tau: 0.6 }, withConfidences(confs)); // 0.5 < 0.6 → escalate
    expect(lo.escalations).toBe(0);
    expect(lo.acceptedTierId).toBe("8b");
    expect(hi.escalations).toBe(1);
    expect(hi.acceptedTierId).toBe("30b");
  });

  it("τ=0 never escalates on quality (pure cheap tier)", async () => {
    const run = await runCascade(T2, { tau: 0 }, withConfidences([0.01, 1.0]));
    expect(run.escalations).toBe(0);
    expect(run.acceptedTierId).toBe("8b");
  });

  it("a hard failure escalates regardless of τ (if a tier remains)", async () => {
    const run = await runCascade(T2, { tau: 0 }, withConfidences([0.9, 0.9], [true, false]));
    expect(run.acceptedTierId).toBe("30b");
    expect(run.escalations).toBe(1);
  });

  it("exhausts all tiers when none clear the gate; flags exhausted", async () => {
    const run = await runCascade(T3, { tau: 0.9 }, withConfidences([0.2, 0.3, 0.4]));
    expect(run.acceptedTierId).toBe("30b");
    expect(run.acceptedIndex).toBe(2);
    expect(run.escalations).toBe(2);
    expect(run.stoppedEarly).toBe(false);
    expect(run.exhausted).toBe(true); // reached top tier still below τ
    expect(run.attempts).toHaveLength(3);
  });

  it("threads prior attempts into each escalated tier (for the resume preamble)", async () => {
    const seen: number[] = [];
    const attempt: AttemptFn<string, string> = (tier, ctx) => {
      seen.push(ctx.priorAttempts.length);
      return Promise.resolve({ confidence: 0.1, value: `${tier.id}` }); // always below τ
    };
    await runCascade(T3, { tau: 0.5 }, attempt);
    expect(seen).toEqual([0, 1, 2]); // tier i sees i prior attempts
  });

  it("a single-tier cascade always accepts tier 0 (nowhere to escalate)", async () => {
    const run = await runCascade([T2[0]!], { tau: 1 }, withConfidences([0.1]));
    expect(run.acceptedTierId).toBe("8b");
    expect(run.escalations).toBe(0);
    expect(run.exhausted).toBe(true); // below τ and no higher tier
  });

  it("throws on an empty tier list", async () => {
    await expect(runCascade([], { tau: 0.5 }, withConfidences([]))).rejects.toThrow(/at least one tier/);
  });
});
