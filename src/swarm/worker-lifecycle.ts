import type { FailureClass } from "./events.js";

/**
 * Worker lifecycle states. Per docs/19-phase-5-plan.md P5.Q7:
 * - 8 base states matching doc 16 verbatim.
 * - `trust_required` is RESERVED — Claude Agent SDK doesn't surface
 *   a trust callback, so this state is never visited in current
 *   openswarm. Documented as future-proofing for upstream SDK
 *   changes (P5.Q11).
 *
 * v0.4 stage 4D adds three states for long-lived workers:
 * - `idle`     — task completed, awaiting `run_more` or `drain`.
 * - `draining` — drain requested while a task is still running.
 * - `drained`  — graceful long-lived exit (vs the generic `finished`).
 *
 * Default (non-long-lived) workers keep using `running → finished`;
 * they never enter idle/draining/drained.
 */
export type WorkerLifecycleState =
  | "spawning"
  | "trust_required"
  | "ready_for_prompt"
  | "prompt_accepted"
  | "running"
  | "blocked"
  | "idle"
  | "draining"
  | "drained"
  | "finished"
  | "failed";

/**
 * Allowed transitions per state. Terminal states (finished, failed, drained)
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
  running: ["blocked", "idle", "finished", "failed"],
  blocked: ["running", "failed", "finished"],
  idle: ["prompt_accepted", "draining", "drained", "failed"],
  draining: ["drained", "failed"],
  drained: [],
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
