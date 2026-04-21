import type { EscalationPolicy } from "./host.js";

export interface RetryPlan {
  readonly shouldRetry: boolean;
  readonly delayMs: number;
}

/**
 * Consult the escalation policy to decide whether to retry after a failed
 * attempt. `attempt` is 0-indexed — `attempt=0` means "first retry after
 * the initial failure".
 *
 * Delays:
 *   - kind "none": never retry (shouldRetry: false, delayMs: 0).
 *   - kind "retry": when attempt < max, shouldRetry = true.
 *       fixed backoff:       delayMs = 250.
 *       exponential backoff: delayMs = 250 * 2^attempt, capped at 30_000.
 *   - kind "handoff": shouldRetry: false (handoff dispatch handled by orchestrator).
 */
export function planRetry(policy: EscalationPolicy, attempt: number): RetryPlan {
  if (policy.kind === "none") {
    return { shouldRetry: false, delayMs: 0 };
  }

  if (policy.kind === "handoff") {
    return { shouldRetry: false, delayMs: 0 };
  }

  // kind === "retry"
  if (attempt >= policy.max) {
    return { shouldRetry: false, delayMs: 0 };
  }

  if (policy.backoff === "fixed") {
    return { shouldRetry: true, delayMs: 250 };
  }

  // exponential
  const delayMs = Math.min(30_000, 250 * 2 ** attempt);
  return { shouldRetry: true, delayMs };
}
