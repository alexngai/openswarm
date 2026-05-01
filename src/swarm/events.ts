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
import type { CommandIntent } from "../tools/tier0/bash-validation/intent.js";
import type { WorkerLifecycleChangedPayload } from "./worker-lifecycle.js";

export type { WorkerLifecycleChangedPayload };

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
  | "worker_lifecycle_changed"
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
  // ---------------- M4a NativeEngine ----------------
  /** A user alias in settings.json shadowed a built-in alias. */
  | "alias_shadowed"
  /** NativeEngine sent a request to Provider.stream(); useful for observability. */
  | "provider_request_sent"
  /** Provider.stream() yielded an error event. */
  | "provider_stream_error"
  /** Compactor walked the keep boundary back to preserve a tool_use/tool_result pair. */
  | "native_compaction_boundary_walked"
  /** NativeEngine refused a resume because the snapshot's engineId did not match. */
  | "native_resume_rejected"
  // ---------------- Plugin lifecycle ----------------
  /** A plugin was skipped because it is disabled in PluginStateStore. */
  | "plugin_disabled"
  // ---------------- Phase 5 — runtime hardening ----------------
  /** Bash command blocked by the bash-validation pipeline. */
  | "bash_validation_blocked"
  /** Bash command flagged as potentially dangerous; user made a decision. */
  | "bash_validation_warned"
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

// ---------------------------------------------------------------------------
// M4a Phase 0.5 — payload interfaces for NativeEngine lane events
// ---------------------------------------------------------------------------

export interface AliasShadowedPayload {
  readonly alias: string;
  readonly builtInTarget: string;
  readonly userTarget: string;
}

export interface ProviderRequestSentPayload {
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount: number;
  readonly toolCount: number;
}

export interface ProviderStreamErrorPayload {
  readonly providerId: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface NativeCompactionBoundaryWalkedPayload {
  readonly originalKeepFrom: number;
  readonly walkedKeepFrom: number;
  readonly reason: "tool_result_first" | "orphan";
}

export interface NativeResumeRejectedPayload {
  readonly snapshotEngineId: string;
  readonly attemptedBy: "native";
}

// ---------------------------------------------------------------------------
// M4b Phase 3 — plugin lifecycle payload interfaces
// ---------------------------------------------------------------------------

export interface PluginDisabledPayload {
  readonly pluginId: string;
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

// ---------------------------------------------------------------------------
// Phase 5 Stage A — bash-validation payload interfaces
// ---------------------------------------------------------------------------

/** Payload for `bash_validation_blocked` events. */
export interface BashValidationBlockedPayload {
  readonly command: string;
  readonly submodule: string;
  readonly reason: string;
  readonly intent: CommandIntent;
}

/** Payload for `bash_validation_warned` events. */
export interface BashValidationWarnedPayload {
  readonly command: string;
  readonly submodule: string;
  readonly message: string;
  readonly decision: "approved" | "denied";
  readonly intent: CommandIntent;
}

// ---------------------------------------------------------------------------
// Phase 5 Stage C — TypedLaneEvent discriminated union (P5.Q9)
// ---------------------------------------------------------------------------

/**
 * Typed lane-event discriminated union — Phase 5 stage C (P5.Q9).
 *
 * Migration policy: NEW lane event variants get strictly-typed payloads
 * via this union. The existing 70+ LaneEventType variants stay
 * LaneEventPayload = unknown for now; tighten case-by-case as they're
 * touched. Big-bang migration would be a multi-day diff with no
 * acceptance-criterion benefit.
 *
 * Adding a new TypedLaneEvent variant without updating the
 * `assertNeverEvent` consumer below is a compile error — that IS the
 * exhaustiveness gate doc 16's Phase 5 acceptance criterion #3 calls for.
 */
export type TypedLaneEvent =
  | { readonly type: "bash_validation_blocked"; readonly payload: BashValidationBlockedPayload }
  | { readonly type: "bash_validation_warned"; readonly payload: BashValidationWarnedPayload }
  | { readonly type: "worker_lifecycle_changed"; readonly payload: WorkerLifecycleChangedPayload };

/**
 * Narrow a generic LaneEvent to a TypedLaneEvent if its `type` is one of
 * the new typed variants. Returns undefined otherwise — caller falls back
 * to the loose `LaneEventPayload = unknown` interpretation.
 *
 * The `as Foo` casts below are safe because we control event emission for
 * the typed variants. If a future stage adds runtime validation (e.g. Zod)
 * on the payload, this is the place to plug it in.
 * TODO(phase-5-future): add Zod parse here when runtime schema validation
 * is introduced for typed lane events.
 */
export function narrowLaneEvent(event: LaneEvent): TypedLaneEvent | undefined {
  switch (event.type) {
    case "bash_validation_blocked":
      return { type: event.type, payload: event.payload as BashValidationBlockedPayload };
    case "bash_validation_warned":
      return { type: event.type, payload: event.payload as BashValidationWarnedPayload };
    case "worker_lifecycle_changed":
      return { type: event.type, payload: event.payload as WorkerLifecycleChangedPayload };
    default:
      return undefined;
  }
}

/**
 * Compile-time exhaustiveness helper. Use in switch statements that
 * branch on TypedLaneEvent.type — adding a new variant without a case
 * here becomes a tsc error.
 */
export function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled TypedLaneEvent: ${JSON.stringify(event)}`);
}
