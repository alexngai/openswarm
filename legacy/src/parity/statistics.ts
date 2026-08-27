/**
 * statistics.ts — the paired non-inferiority machinery `DDP-EVAL-01` preregisters.
 *
 * docs/67 commits to a specific test: "task success passes only when the paired 95% bootstrap lower
 * confidence bound for `OpenSwarm − comparator` is above −5 percentage points", with median wall time
 * at most 1.25× and median model cost at most 1.15× the comparator.
 *
 * Preregistration only means something if the procedure is fixed before the data exists, so this is
 * implemented at `WP-01` rather than at `WP-28` where it is first used. Two choices are worth stating
 * because both could otherwise be quietly relaxed later to make a result pass:
 *
 *   - The bound is the 2.5th percentile of the bootstrap distribution, the lower end of a two-sided
 *     95% interval. A one-sided 95% bound (the 5th percentile) is the weaker and more common choice
 *     for non-inferiority; we take the conservative one.
 *   - Resampling is over *pairs*, not over each arm independently, because the arms share tasks and
 *     seeds. Resampling independently would discard the pairing and overstate precision.
 *
 * The generator is seeded and deterministic, so a reported bound is reproducible from the recorded
 * seed and iteration count.
 */

/** One task run under both arms, at the same model, seed, and repository snapshot. */
export interface PairedOutcome {
  /** 1 for success, 0 for failure. Infrastructure failures are excluded upstream, not scored here. */
  readonly ours: number;
  readonly comparator: number;
}

export interface BootstrapOptions {
  /** Resamples. 10,000 is the preregistered value; more only narrows Monte Carlo noise. */
  readonly iterations?: number;
  readonly seed?: number;
  /** Two-sided significance level. 0.05 gives a 2.5th-percentile lower bound. */
  readonly alpha?: number;
}

export interface BootstrapResult {
  /** Observed difference in success rate, in percentage points. */
  readonly pointEstimatePp: number;
  readonly lowerBoundPp: number;
  readonly upperBoundPp: number;
  readonly iterations: number;
  readonly seed: number;
  readonly pairs: number;
}

/**
 * Deterministic PRNG (mulberry32). Chosen over `Math.random` because a bootstrap bound that cannot
 * be reproduced from a recorded seed is not evidence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function meanDiffPp(pairs: readonly PairedOutcome[]): number {
  let total = 0;
  for (const pair of pairs) total += pair.ours - pair.comparator;
  return (total / pairs.length) * 100;
}

/** Paired bootstrap of the success-rate difference, in percentage points. */
export function pairedBootstrap(
  pairs: readonly PairedOutcome[],
  options: BootstrapOptions = {},
): BootstrapResult {
  const iterations = options.iterations ?? 10_000;
  const seed = options.seed ?? 20260722;
  const alpha = options.alpha ?? 0.05;

  if (pairs.length === 0) {
    throw new Error("pairedBootstrap requires at least one paired outcome");
  }

  const random = mulberry32(seed);
  const diffs = new Float64Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    let total = 0;
    for (let j = 0; j < pairs.length; j += 1) {
      const pick = pairs[Math.floor(random() * pairs.length)]!;
      total += pick.ours - pick.comparator;
    }
    diffs[i] = (total / pairs.length) * 100;
  }
  diffs.sort();

  return {
    pointEstimatePp: meanDiffPp(pairs),
    lowerBoundPp: percentile(diffs, alpha / 2),
    upperBoundPp: percentile(diffs, 1 - alpha / 2),
    iterations,
    seed,
    pairs: pairs.length,
  };
}

/** Nearest-rank percentile over a sorted array. */
function percentile(sorted: Float64Array, p: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );
  return sorted[index]!;
}

/**
 * The non-inferiority decision. `inconclusive` is a distinct outcome rather than a failure: docs/67
 * requires the sample to expand under the power rule until the result resolves, and an inconclusive
 * result explicitly cannot support a parity claim.
 */
export type NonInferiorityVerdict = "non-inferior" | "inferior" | "inconclusive";

export function nonInferiority(
  result: BootstrapResult,
  marginPp: number,
  minimumPairs: number,
): NonInferiorityVerdict {
  if (result.pairs < minimumPairs) return "inconclusive";
  if (result.lowerBoundPp > -marginPp) return "non-inferior";
  if (result.upperBoundPp < -marginPp) return "inferior";
  return "inconclusive";
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty sample");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Median ratio of ours to the comparator's, for the latency and cost guardrails. Computed as a ratio
 * of medians rather than a median of ratios: the guardrails are stated as "median wall time is at
 * most 1.25× the comparator", which compares two medians.
 */
export function medianRatio(
  ours: readonly number[],
  comparator: readonly number[],
): number {
  const theirs = median(comparator);
  if (theirs === 0) throw new Error("comparator median is zero; ratio undefined");
  return median(ours) / theirs;
}

/**
 * Normal quantile function (Acklam's rational approximation, ~1e-9 absolute error). Needed by the
 * power rule; a lookup table would silently restrict which alpha and power values can be chosen.
 */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`normalQuantile requires 0 < p < 1 (got ${p})`);

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(
        ((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!
      ) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) *
      q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * Paired sample size for a given minimum detectable effect. Follows docs/50 §3.1, whose σ_d ≈ 0.3 and
 * MDE of 5 points yield roughly 280 instances — the figure docs/67's corpus sizing assumes.
 */
export function requiredPairs(
  sigmaD: number,
  mdeProportion: number,
  alpha = 0.05,
  power = 0.8,
): number {
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil((z * z * sigmaD * sigmaD) / (mdeProportion * mdeProportion));
}
