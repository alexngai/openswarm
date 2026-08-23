/**
 * escalation-gate.ts — the parametric escalation cascade (docs/50 §6 G3 v1).
 *
 * A cascade runs an ordered sequence of model TIERS (cheap → expensive), keeping
 * work on the cheapest tier that clears a quality GATE and escalating only when it
 * doesn't. The gate is a single tunable threshold τ ∈ [0,1] over a normalized
 * confidence signal: escalate when `confidence < τ` (or the attempt hard-failed and
 * a higher tier remains). Sweeping τ traces the cost/quality Pareto curve — low τ
 * rarely escalates (cheap, lower quality), high τ escalates often (costly, approaches
 * the top tier). The escalation count per run is the compute-allocation lever the
 * whole thesis rests on (docs/50 §2 escalation ROI).
 *
 * This is the pure decision + control-flow core — the analog of retry-policy.ts. It
 * is generic over an opaque tier payload `T` (model/role/etc, carried by the caller)
 * and an attempt result `A`, and takes the "run one tier" step as an async function,
 * so it unit-tests without any SwarmHost. A `CascadeTopology` drives real model spawns
 * through `runCascade`; the escalation SIGNAL (test pass-rate, cross-validation
 * verdict — docs/50 §9.3) is derived by the helpers below and handed in as confidence.
 */

/** The escalation gate: escalate when an attempt's confidence is below τ. */
export interface CascadeGate {
  /** Threshold in [0,1]. τ=0 never escalates on quality; τ=1 escalates unless perfect. */
  readonly tau: number;
}

/** Normalized confidence in [0,1] that an attempt is correct/complete. */
export type Confidence = number;

function clamp01(x: number): Confidence {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Confidence from a test / checkpoint pass rate. No tests (`total <= 0`) → 0: absence
 * of evidence reads as low confidence, so an ungated attempt escalates rather than
 * being trusted. (docs/50 §9.3 — the TEX-style cross-validation signal.)
 */
export function confidenceFromTests(passed: number, total: number): Confidence {
  if (total <= 0) return 0;
  return clamp01(passed / total);
}

/** Confidence from a binary critic / cross-validation verdict (approved ⇒ 1, else 0). */
export function confidenceFromVerdict(approved: boolean): Confidence {
  return approved ? 1 : 0;
}

/**
 * Combine confidence signals conservatively (weakest link). Used to require that BOTH
 * the tests pass AND a cross-validator agrees before trusting a cheap tier. Empty → 0.
 */
export function combineConfidence(...signals: Confidence[]): Confidence {
  if (signals.length === 0) return 0;
  return clamp01(Math.min(...signals));
}

/** The pure gate decision: escalate on quality when confidence is strictly below τ. */
export function shouldEscalate(confidence: Confidence, gate: CascadeGate): boolean {
  return confidence < gate.tau;
}

// ---------------------------------------------------------------------------
// Cascade control flow
// ---------------------------------------------------------------------------

/** One tier of the cascade. `payload` (model/role/…) is opaque to the core. */
export interface CascadeTier<T> {
  readonly id: string;
  readonly payload: T;
}

/** The result of attempting one tier. */
export interface AttemptOutcome<A> {
  readonly confidence: Confidence;
  readonly value: A;
  /** Hard failure (crash/timeout): always escalates if a higher tier remains, regardless of τ. */
  readonly failed?: boolean;
}

/** A recorded tier attempt within a cascade run. */
export interface CascadeAttempt<A> {
  readonly tierId: string;
  readonly index: number;
  readonly outcome: AttemptOutcome<A>;
  /** Whether the cascade escalated AFTER this attempt. */
  readonly escalated: boolean;
}

/** The outcome of a whole cascade run — everything cost/ROI analysis needs. */
export interface CascadeRun<A> {
  /** Index of the tier whose value was accepted. */
  readonly acceptedIndex: number;
  readonly acceptedTierId: string;
  readonly value: A;
  readonly confidence: Confidence;
  /** Number of escalations (0 ⇒ solved on the cheapest tier). */
  readonly escalations: number;
  /** A non-final tier cleared the gate — the cascade stopped before the top tier. */
  readonly stoppedEarly: boolean;
  /** Reached the top tier still failing / below τ — the cascade could not clear the gate. */
  readonly exhausted: boolean;
  readonly attempts: readonly CascadeAttempt<A>[];
}

/** Run one tier. Receives the tier and the attempts so far (for a resume/escalation preamble). */
export type AttemptFn<T, A> = (
  tier: CascadeTier<T>,
  ctx: { readonly index: number; readonly priorAttempts: readonly CascadeAttempt<A>[] },
) => Promise<AttemptOutcome<A>>;

/**
 * Run the cascade: attempt each tier in order, escalating to the next when the current
 * attempt hard-fails or its confidence is below τ, until a tier clears the gate or the
 * tiers are exhausted (then the top tier's result is taken). Deterministic given `attempt`.
 */
export async function runCascade<T, A>(
  tiers: readonly CascadeTier<T>[],
  gate: CascadeGate,
  attempt: AttemptFn<T, A>,
): Promise<CascadeRun<A>> {
  if (tiers.length === 0) {
    throw new Error("runCascade: at least one tier is required");
  }
  const attempts: CascadeAttempt<A>[] = [];
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    const outcome = await attempt(tier, { index: i, priorAttempts: attempts });
    const hasNext = i < tiers.length - 1;
    const escalate =
      hasNext && (outcome.failed === true || shouldEscalate(outcome.confidence, gate));
    attempts.push({ tierId: tier.id, index: i, outcome, escalated: escalate });
    if (!escalate) {
      return {
        acceptedIndex: i,
        acceptedTierId: tier.id,
        value: outcome.value,
        confidence: outcome.confidence,
        escalations: i,
        stoppedEarly: hasNext,
        exhausted:
          !hasNext && (outcome.failed === true || outcome.confidence < gate.tau),
        attempts,
      };
    }
  }
  // Unreachable: the final iteration has hasNext=false ⇒ escalate=false ⇒ returns above.
  throw new Error("runCascade: exhausted tiers without terminating");
}
