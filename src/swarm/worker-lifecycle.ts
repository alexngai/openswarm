import type { FailureClass } from "./events.js";

/**
 * Worker lifecycle states. Per docs/19-phase-5-plan.md P5.Q7:
 * - 8 states matching doc 16 verbatim.
 * - `trust_required` is RESERVED — Claude Agent SDK doesn't surface
 *   a trust callback, so this state is never visited in current
 *   swarm-harness. Documented as future-proofing for upstream SDK
 *   changes (P5.Q11).
 */
export type WorkerLifecycleState =
  | "spawning"
  | "trust_required"
  | "ready_for_prompt"
  | "prompt_accepted"
  | "running"
  | "blocked"
  | "finished"
  | "failed";

/**
 * Allowed transitions per state. Terminal states (finished, failed)
 * have empty transition lists.
 */
const TRANSITIONS: Record<
  WorkerLifecycleState,
  ReadonlyArray<WorkerLifecycleState>
> = {
  spawning: ["trust_required", "ready_for_prompt", "failed"],
  trust_required: ["ready_for_prompt", "failed"],
  ready_for_prompt: ["prompt_accepted", "failed", "finished"],
  prompt_accepted: ["running", "failed"],
  running: ["blocked", "finished", "failed"],
  blocked: ["running", "failed", "finished"],
  finished: [],
  failed: [],
};

export function isValidTransition(
  from: WorkerLifecycleState,
  to: WorkerLifecycleState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Payload for the `worker_lifecycle_changed` lane event.
 */
export interface WorkerLifecycleChangedPayload {
  readonly from: WorkerLifecycleState;
  readonly to: WorkerLifecycleState;
  readonly failureClass?: FailureClass;
  readonly reason?: string;
}

/** Initial state when a WorkerHost is constructed. */
export const INITIAL_LIFECYCLE_STATE: WorkerLifecycleState = "spawning";
