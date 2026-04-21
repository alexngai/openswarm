/**
 * Lane event schema — the wire format between a worker and its orchestrator.
 *
 * Ported near-verbatim from claw-code's `rust/crates/runtime/src/lane_events.rs`
 * (docs/research/05-swarm.md §5). Keeping names and failure classes aligned
 * preserves interop with claw-ecosystem observers.
 *
 * Transport: JSONL over stdio in the default subprocess topology.
 * One event per line. Events are strictly additive — never remove or rename.
 */

import type { AgentId } from "../core/types.js";

export interface LaneEvent {
  /** Epoch milliseconds at emission. */
  readonly ts: number;
  readonly agentId: AgentId;
  readonly type: LaneEventType;
  readonly payload: LaneEventPayload;
  /** Opaque fingerprint for dedup across retries. */
  readonly fingerprint?: string;
  /** Which subsystem emitted this event. */
  readonly provenance?: string;
}

export type LaneEventType =
  // ---------------- Lifecycle ----------------
  | "worker_spawned"
  | "worker_ready"
  | "worker_exited"
  | "worker_crashed"
  // ---------------- Turn ----------------
  | "turn_start"
  | "turn_end"
  | "message_stop"
  // ---------------- Text / tool ----------------
  | "text_delta"
  | "tool_use_start"
  | "tool_use_input"
  | "tool_use_end"
  | "tool_result"
  // ---------------- Task ----------------
  | "task_created"
  | "task_updated"
  | "task_completed"
  | "task_failed"
  | "task_stopped"
  // ---------------- Permission ----------------
  | "permission_prompt"
  | "permission_granted"
  | "permission_denied"
  // ---------------- Coordination ----------------
  | "branch_locked"
  | "branch_unlocked"
  | "stale_base_detected"
  | "message_sent"
  | "message_received"
  // ---------------- User loop ----------------
  | "question_asked"
  | "answer_received"
  // ---------------- Error ----------------
  | "error";

/**
 * Payload shape varies by event type. Consumers should narrow on `type`.
 * Payloads are unknown at this layer; concrete shapes live in feature modules.
 */
export type LaneEventPayload = unknown;

/** Structured failure classes for `error` events. */
export type FailureClass =
  | "transport"
  | "provider"
  | "permission"
  | "tool"
  | "timeout"
  | "panic";

export interface ErrorPayload {
  readonly class: FailureClass;
  readonly message: string;
  readonly retryable: boolean;
  /** Opaque cause chain — stringified, not structured, to survive JSONL. */
  readonly cause?: string;
}
