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
  | "spawn_requested"
  | "spawn_completed"
  | "recursion_limit_hit"
  | "worker_stuck"
  | "heartbeat"
  // ---------------- Inbox ----------------
  /** Inbox drained when a worker exits; messages discarded (in-memory only). */
  | "inbox_drained_on_exit"
  /** Per-message event when a per-agent inbox overflows (oldest evicted). */
  | "inbox_overflow"
  // ---------------- Task stop ----------------
  /** Emitted when a stop request is received for a running task. */
  | "task_stop_requested"
  // task_stopped already in Task section above
  // ---------------- Retry / dead-letter ----------------
  /** A retry has been scheduled for a failed task. */
  | "retry_scheduled"
  /** A task has exhausted its retry budget; going to dead-letter. */
  | "retry_exhausted"
  /** A task record has been written to dead-letter.jsonl. */
  | "dead_letter_written"
  /** DeadLetterWriter encountered one or more write failures this run. */
  | "dead_letter_write_failure"
  // ---------------- Roles ----------------
  /** A role was registered in the RoleRegistry. */
  | "role_registered"
  /** A role was applied to a spawned worker. */
  | "role_applied"
  // ---------------- Policy no-ops (M3a advisory) ----------------
  /** BranchPolicy was advisory-only this run (git ops deferred to M3b). */
  | "branch_policy_noop"
  /** CommitPolicy was advisory-only this run (git ops deferred to M3b). */
  | "commit_policy_noop"
  // ---------------- User loop ----------------
  | "question_asked"
  | "answer_received"
  // ---------------- Branch lock ----------------
  | "branch_lock_acquired"
  | "branch_lock_released"
  | "branch_lock_reclaimed"
  | "branch_lock_timeout"
  // ---------------- Stale base ----------------
  | "stale_base_diverged"
  | "stale_base_ok"
  // ---------------- Cache ----------------
  | "cache_hit"
  | "cache_miss"
  | "prompt_cache_unavailable"
  // ---------------- Parallel tool batch ----------------
  | "parallel_tool_batch"
  // ---------------- Preflight ----------------
  | "preflight_degraded"
  | "preflight_disabled"
  // ---------------- Ask user ----------------
  | "ask_user_question_sent"
  | "ask_user_question_answered"
  | "ask_user_question_timeout"
  // ---------------- Error ----------------
  | "error";

/**
 * Payload shape varies by event type. Consumers should narrow on `type`.
 * Payloads are unknown at this layer; concrete shapes live in feature modules.
 */
export type LaneEventPayload = unknown;

// ---------------------------------------------------------------------------
// M3b Phase 0.2 — payload interfaces for new event types
// ---------------------------------------------------------------------------

export interface BranchLockAcquiredPayload {
  readonly branch: string;
  readonly laneId: string;
}

export interface BranchLockReleasedPayload {
  readonly branch: string;
  readonly laneId: string;
}

export interface BranchLockReclaimedPayload {
  readonly branch: string;
  readonly laneId: string;
  readonly previousOwner: string;
}

export interface BranchLockTimeoutPayload {
  readonly branch: string;
  readonly laneId: string;
  readonly waitedMs: number;
}

export interface StaleBaseDivergedPayload {
  readonly branch: string;
  readonly baseBranch: string;
  readonly behindBy: number;
}

export interface StaleBaseOkPayload {
  readonly branch: string;
  readonly baseBranch: string;
}

export interface CacheHitPayload {
  readonly fingerprint?: string;
  readonly savedTokens?: number;
}

export interface CacheMissPayload {
  readonly fingerprint?: string;
}

export interface ParallelToolBatchPayload {
  readonly toolNames: readonly string[];
  readonly batchSize: number;
}

export interface PreflightDegradedPayload {
  readonly reason: string;
}

export interface PreflightDisabledPayload {
  readonly reason: string;
}

export interface AskUserQuestionSentPayload {
  readonly correlationId: string;
  readonly question: string;
}

export interface AskUserQuestionAnsweredPayload {
  readonly correlationId: string;
  readonly answer: string;
}

export interface AskUserQuestionTimeoutPayload {
  readonly correlationId: string;
  readonly timeoutMs: number;
}

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
