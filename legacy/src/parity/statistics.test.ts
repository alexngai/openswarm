/**
 * statistics.test.ts — part of `FX-EVAL-PLAN-001`.
 *
 * These tests are the preregistration: they fix the procedure's behaviour on known inputs so that a
 * later change to make a real result pass shows up as a failing test rather than as a nicer number.
 */
import { describe, expect, it } from "vitest";
import type { PairedOutcome } from "./statistics.js";
import {
  median,
  medianRatio,
  mulberry32,
  nonInferiority,
  normalQuantile,
  pairedBootstrap,
  requiredPairs,
} from "./statistics.js";

function pairs(ours: readonly number[], comparator: readonly number[]): PairedOutcome[] {
  return ours.map((value, i) => ({ ours: value, comparator: comparator[i]! }));
}

/** n identical pairs, for cases where the sampling distribution should be degenerate. */
function repeat(ours: number, comparator: number, n: number): PairedOutcome[] {
  return Array.from({ length: n }, () => ({ ours, comparator }));
}

describe("the seeded generator", () => {
  it("is reproducible from its seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("produces different streams for different seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  it("stays within the unit interval", () => {
    const random = mulberry32(7);
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("paired bootstrap", () => {
  it("reports a zero point estimate when the arms agree everywhere", () => {
    const result = pairedBootstrap(repeat(1, 1, 50), { iterations: 500 });
    expect(result.pointEstimatePp).toBe(0);
    expect(result.lowerBoundPp).toBe(0);
    expect(result.upperBoundPp).toBe(0);
  });

  it("measures the difference in percentage points", () => {
    // We solve 8 of 10, the comparator 6 of 10: a 20-point gap in our favour.
    const result = pairedBootstrap(
      pairs([1, 1, 1, 1, 1, 1, 1, 1, 0, 0], [1, 1, 1, 1, 1, 1, 0, 0, 0, 0]),
      { iterations: 2000 },
    );
    expect(result.pointEstimatePp).toBeCloseTo(20, 6);
  });

  it("brackets the point estimate", () => {
    const result = pairedBootstrap(
      pairs([1, 0, 1, 1, 0, 1, 1, 0, 1, 1], [1, 1, 0, 1, 0, 0, 1, 1, 0, 1]),
      { iterations: 2000 },
    );
    expect(result.lowerBoundPp).toBeLessThanOrEqual(result.pointEstimatePp);
    expect(result.upperBoundPp).toBeGreaterThanOrEqual(result.pointEstimatePp);
  });

  it("is reproducible for a given seed and widens with a smaller alpha", () => {
    const sample = pairs(
      [1, 0, 1, 1, 0, 1, 0, 0, 1, 1],
      [1, 1, 1, 0, 0, 0, 1, 0, 1, 0],
    );
    const first = pairedBootstrap(sample, { iterations: 2000, seed: 99 });
    const again = pairedBootstrap(sample, { iterations: 2000, seed: 99 });
    expect(again).toEqual(first);

    const wider = pairedBootstrap(sample, {
      iterations: 2000,
      seed: 99,
      alpha: 0.01,
    });
    expect(wider.lowerBoundPp).toBeLessThanOrEqual(first.lowerBoundPp);
  });

  it("narrows as the sample grows", () => {
    const small = pairedBootstrap(
      pairs([1, 1, 1, 0, 0, 0, 1, 1, 0, 1], [1, 0, 1, 0, 1, 0, 1, 0, 0, 1]),
      { iterations: 3000, seed: 5 },
    );
    const large = pairedBootstrap(
      Array.from({ length: 40 }, (_, i) => ({
        ours: [1, 1, 1, 0, 0, 0, 1, 1, 0, 1][i % 10]!,
        comparator: [1, 0, 1, 0, 1, 0, 1, 0, 0, 1][i % 10]!,
      })),
      { iterations: 3000, seed: 5 },
    );
    const width = (r: { lowerBoundPp: number; upperBoundPp: number }) =>
      r.upperBoundPp - r.lowerBoundPp;
    expect(width(large)).toBeLessThan(width(small));
  });

  it("resamples pairs rather than arms independently", () => {
    // Perfectly anti-correlated arms with equal totals: pairing means every
    // resample has a difference of exactly zero, so the interval collapses.
    // Independent resampling would produce a non-degenerate spread.
    const result = pairedBootstrap(
      pairs([1, 1, 1, 1], [1, 1, 1, 1]),
      { iterations: 1000 },
    );
    expect(result.upperBoundPp - result.lowerBoundPp).toBe(0);
  });

  it("refuses an empty sample instead of returning a bound", () => {
    expect(() => pairedBootstrap([])).toThrow(/at least one paired outcome/);
  });
});

describe("the non-inferiority decision", () => {
  const margin = 5;

  it("passes when the lower bound clears the margin", () => {
    const result = pairedBootstrap(repeat(1, 1, 300), { iterations: 500 });
    expect(nonInferiority(result, margin, 280)).toBe("non-inferior");
  });

  it("fails when the whole interval sits below the margin", () => {
    // We solve nothing the comparator solves: a 100-point deficit.
    const result = pairedBootstrap(repeat(0, 1, 300), { iterations: 500 });
    expect(nonInferiority(result, margin, 280)).toBe("inferior");
  });

  it("is inconclusive when the interval straddles the margin", () => {
    const sample = Array.from({ length: 300 }, (_, i) => ({
      ours: i % 20 === 0 ? 0 : 1,
      comparator: 1,
    }));
    const result = pairedBootstrap(sample, { iterations: 2000, seed: 3 });
    expect(nonInferiority(result, margin, 280)).toBe("inconclusive");
  });

  it("is inconclusive below the preregistered sample size, however good the bound", () => {
    // A perfect result on ten tasks cannot support a parity claim.
    const result = pairedBootstrap(repeat(1, 0, 10), { iterations: 500 });
    expect(result.lowerBoundPp).toBe(100);
    expect(nonInferiority(result, margin, 280)).toBe("inconclusive");
  });
});

describe("guardrail ratios", () => {
  it("takes the median of an odd and an even sample", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("compares medians rather than averaging per-task ratios", () => {
    // Medians are 20 and 16, so 1.25 — a median of ratios would give 1.35.
    expect(medianRatio([10, 20, 30], [4, 16, 28])).toBeCloseTo(1.25, 6);
  });

  it("refuses a zero comparator median rather than returning Infinity", () => {
    expect(() => medianRatio([1], [0])).toThrow(/median is zero/);
  });

  it("refuses an empty sample", () => {
    expect(() => median([])).toThrow(/empty sample/);
  });
});

describe("the power rule", () => {
  it("reproduces the normal quantiles the rule depends on", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
  });

  it("is symmetric about the median", () => {
    expect(normalQuantile(0.1)).toBeCloseTo(-normalQuantile(0.9), 8);
  });

  it("rejects probabilities outside the open unit interval", () => {
    expect(() => normalQuantile(0)).toThrow(/0 < p < 1/);
    expect(() => normalQuantile(1)).toThrow(/0 < p < 1/);
  });

  it("yields the ~280 paired instances docs/50 sizes the corpus against", () => {
    expect(requiredPairs(0.3, 0.05)).toBe(283);
  });

  it("demands more pairs for a smaller effect", () => {
    expect(requiredPairs(0.3, 0.025)).toBeGreaterThan(requiredPairs(0.3, 0.05));
  });
});
