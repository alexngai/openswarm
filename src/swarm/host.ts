/**
 * SwarmHost — the atomic agent's view of the world around it.
 *
 * Tier-2 tools (`agent`, `task_*`, `send_message`, `check_inbox`) dispatch
 * through this interface. The same tool code runs whether the agent is
 * standalone or a subprocess worker — the difference lives inside the host.
 *
 * Two implementations ship (docs/03-interfaces.md §3):
 *   - StandaloneHost: in-process event bus, local task store
 *   - WorkerHost: JSONL-over-stdio to an orchestrator parent
 *
 * When `mode === "standalone"`, Tier-2 tools degrade gracefully (spawn still
 * works, send/inbox operate on an in-process pub/sub). The tool SURFACE does
 * not change — the model sees the same tool list either way, so behavior
 * stays consistent.
 *
 * ---------------------------------------------------------------------------
 * Authoritative depth enforcement
 * ---------------------------------------------------------------------------
 * Recursion depth is computed by the orchestrator, never trusted from
 * incoming IPC. `StandaloneHost` maintains a `Map<AgentId, number>` of
 * live agent depths. When `SwarmHost.spawn()` is invoked (locally or via
 * IPC from a `WorkerHost`), the orchestrator looks up the requesting
 * agent's depth and passes `parentDepth + 1` to the child via env.
 * `SpawnRequest.depth` is output-only; any value on an incoming request
 * is ignored. This is defense-in-depth against malicious or hallucinating
 * workers — no worker, however buggy, can bypass MAX_DEPTH.
 *
 * The actual `Map` + enforcement lives in StandaloneHost (Phase 4);
 * this interface module only documents the contract.
 */

import type { AgentId, PermissionMode, SessionId, Usage } from "../core/types.js";
import type { LaneEvent } from "./events.js";

// ---------------------------------------------------------------------------
// AskUserResponse
// ---------------------------------------------------------------------------

export type AskUserResponse =
  | { readonly status: "answered"; readonly answer: string }
  | { readonly status: "cancelled" }
  | { readonly status: "timed-out" }
  | { readonly status: "error"; readonly message: string };

// ---------------------------------------------------------------------------
// SendResult
// ---------------------------------------------------------------------------

export interface SendResult {
  readonly ok: boolean;
  /** How many inboxes actually received the message. */
  readonly delivered: number;
  /** Number of messages dropped due to per-agent inbox overflow. */
  readonly dropped?: number;
  /** True when broadcast had some drops (delivered < total recipients). */
  readonly partial?: boolean;
  /**
   * Present when `ok === false`. Machine-readable discriminator:
   *   - "unknown_recipient" — direct `to` is not a live agent
   *   - "depth>1 messaging unsupported" — rev-2 Option A scope violation
   */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface SwarmHost {
  readonly mode: "standalone" | "worker";
  /**
   * Discriminator for ancestry / permission checks in tools.
   * "standalone" = root orchestrator (StandaloneHost); "worker" = subprocess (WorkerHost).
   */
  readonly kind: "standalone" | "worker";
  readonly agentId: AgentId;
  /**
   * This agent's own depth in the recursion tree.
   * 0 for the orchestrator's StandaloneHost; set authoritatively by the
   * orchestrator for WorkerHost instances (via `SWARM_CODER_DEPTH` env var).
   */
  readonly depth: number;
  /**
   * This host's permission mode. Sub-agents cannot escalate beyond this.
   * Set by the orchestrator; workers receive it via `SWARM_CODER_PERMISSION_MODE` env.
   */
  readonly permissionMode: PermissionMode;

  /**
   * Returns true if `ancestor` is the same as or a transitive ancestor of
   * `descendant` in the spawn tree. StandaloneHost walks its spawnParents map;
   * WorkerHost proxies the check to the orchestrator via IPC.
   */
  isAncestorOf(ancestor: AgentId, descendant: AgentId): Promise<boolean>;

  /** Emit a lane event. In standalone mode goes to local subscribers + log. */
  emit(event: Omit<LaneEvent, "ts" | "agentId">): void;

  /** Spawn a sub-agent. Resolves with a handle to the running agent. */
  spawn(request: SpawnRequest): Promise<AgentHandle>;

  /** Send an agent-to-agent message. Rejects if recipient is unknown. */
  send(
    to: AgentId | "*" | `role:${string}`,
    message: AgentMessage,
  ): Promise<SendResult>;

  /**
   * Async iterable over inbox events for this agent.
   * Includes incoming messages, permission responses, and user answers.
   * Iteration completes when the host shuts down.
   */
  inbox(): AsyncIterable<InboxEvent>;

  /**
   * Synchronously drain up to `max` queued messages for this host's own agent.
   * Used by the Tier 2 `check_inbox` tool — returns [] when nothing is queued,
   * never blocks. Introduced in M3a Phase 3.
   */
  drainInbox(max: number): AgentMessage[];

  /**
   * Ask the operator a question and wait for a response.
   * M3b Phase 6 implements the real transport; Phase 0 stubs throw.
   */
  askUser(question: string, options?: readonly string[]): Promise<AskUserResponse>;

  /** Task registry API — see below. */
  readonly task: TaskAPI;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface SpawnRequest {
  readonly task: TaskPacket;
  readonly permissionMode: PermissionMode;
  /** Model id or alias (e.g. "sonnet", "claude-sonnet-4-6", "gpt-4o"). */
  readonly model?: string;
  /** Opt into a FrameworkProvider mode (subscription auth). */
  readonly framework?: "claude-agent-sdk" | "codex-chatgpt";
  /**
   * Role overlay applied to the system prompt (M3+: architect/executor/reviewer).
   * M3a: wired end-to-end in Phase 6.
   */
  readonly role?: string;
  /**
   * Tool allowlist; overrides default tool set for this worker.
   * M3a: wired end-to-end in Phase 6.
   */
  readonly allowedTools?: readonly string[];
  /** Cooperative cancellation handle. */
  readonly abort?: AbortSignal;
  /**
   * Recursion depth of the spawned child agent.
   * Ignored on incoming IPC. Set by orchestrator when passing to child env.
   * See "Authoritative depth enforcement" in the module-level JSDoc.
   */
  readonly depth?: number;
  /** The immediate parent agent that invoked this spawn. Used for lane-event attribution and orchestrator bookkeeping. */
  readonly parentAgentId?: AgentId;
  /**
   * If provided, orchestrator registers the spawn under this task id;
   * otherwise creates a new TaskRecord.
   */
  readonly taskId?: string;
  /**
   * When spawned via the `agent` tool, the tool_use_id from the parent's
   * transcript. Orchestrator propagates to child via
   * `SWARM_CODER_PARENT_TOOL_USE_ID` env var. Child's event translator stamps
   * this id on every emitted NormalizedEvent / LaneEvent so the orchestrator's
   * merged stream can attribute sub-agent events back to the invoking tool_use
   * in the parent's transcript.
   */
  readonly parentToolUseId?: string;
}

export interface AgentHandle {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  /** Resolves with the agent's final result. */
  wait(): Promise<AgentResult>;
  /** Force-terminate the agent. */
  kill(): Promise<void>;
  /** Stream of lane events emitted by this agent (subset of the full bus). */
  events(): AsyncIterable<LaneEvent>;
}

export type AgentResult =
  | {
      readonly status: "success";
      readonly output: string;
      readonly usage: Usage;
      readonly wallClockMs: number;
    }
  | {
      readonly status: "failure";
      readonly error: string;
      readonly partialOutput?: string;
      readonly usage?: Usage;
      readonly wallClockMs: number;
    }
  | {
      readonly status: "timeout";
      readonly partialOutput?: string;
      readonly usage?: Usage;
      readonly wallClockMs: number;
    }
  | { readonly status: "killed"; readonly wallClockMs: number };

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * Structured task format. Claw ships policy fields as free-form strings;
 * ours are enums, runtime-enforced (docs/05-swarm-model.md).
 */
export interface TaskPacket {
  readonly id: string;
  readonly prompt: string;
  readonly branchPolicy: BranchPolicy;
  readonly commitPolicy: CommitPolicy;
  readonly escalationPolicy: EscalationPolicy;
  readonly budget?: TaskBudget;
  readonly context?: TaskContext;
  /**
   * Per-task role override. When set, the orchestrator looks it up in its
   * RoleRegistry and applies the role's systemPromptSuffix + allowedTools
   * to the worker that runs this task. Takes precedence over the
   * orchestrator's `--role` default.
   */
  readonly role?: string;
}

export type BranchPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "reuse"; readonly branch: string }
  | { readonly kind: "create"; readonly from: string; readonly name?: string };

export type CommitPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "auto"; readonly message?: string }
  | { readonly kind: "atomic" };

export type EscalationPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "retry"; readonly max: number; readonly backoff: "fixed" | "exponential" }
  | { readonly kind: "handoff"; readonly targetRole: string };

export interface TaskBudget {
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly maxWallClockMs?: number;
  /**
   * Per-attempt wall-clock ceiling. If a single attempt exceeds this value,
   * the orchestrator kills the worker and dead-letters the task immediately
   * with `lastStatus: "per_attempt_budget_exceeded"` — no further retries.
   */
  readonly maxWallClockMsPerAttempt?: number;
}

export interface TaskContext {
  readonly files?: readonly string[];
  readonly parentTaskId?: string;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timeout";

export interface TaskRecord extends TaskPacket {
  readonly status: TaskStatus;
  readonly owner?: AgentId;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly output?: string;
  readonly error?: string;
  /** Final token usage (populated when task reaches a terminal state). */
  readonly usage?: Usage;
  /** Wall-clock duration in ms (populated when task reaches a terminal state). */
  readonly wallClockMs?: number;
  /**
   * Populated by TaskRegistry.stop() when the task was cancelled via
   * `task_stop`. Value is the caller's agentId, or the string
   * "orchestrator" when the root StandaloneHost stopped the task.
   */
  readonly stoppedBy?: string;
}

export interface TaskFilter {
  readonly status?: TaskStatus;
  readonly owner?: AgentId;
  readonly parentTaskId?: string;
}

export interface TaskAPI {
  create(packet: Omit<TaskPacket, "id">): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | undefined>;
  list(filter?: TaskFilter): Promise<readonly TaskRecord[]>;
  update(
    id: string,
    patch: Partial<Pick<TaskRecord, "status" | "owner" | "output" | "error">>,
  ): Promise<void>;
  /**
   * Stop a running task. `by` is the agentId of the caller, or the string
   * "orchestrator" when the root StandaloneHost is stopping the task.
   * Persisted on the TaskRecord.stoppedBy field and surfaced in the
   * orchestrator's results.jsonl line.
   */
  stop(id: string, by?: AgentId | "orchestrator"): Promise<void>;
  /**
   * Look up which agentId "owns" (is running) a given taskId.
   * Returns undefined if the task is unknown.
   */
  ownerOf(taskId: string): Promise<AgentId | undefined>;
  /**
   * Append a chunk of text to the task's accumulated output.
   * Silently no-ops if the task is unknown (may have been stopped).
   */
  appendOutput(id: string, chunk: string): void;
  /** Append-only output stream; iteration completes when task reaches a terminal status. */
  output(id: string): AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// Messaging / inbox
// ---------------------------------------------------------------------------

export interface AgentMessage {
  readonly from: AgentId;
  readonly to: AgentId;
  readonly content: string;
  readonly timestamp: number;
  /** Correlation id for request/response flows (e.g. ask_user_question). */
  readonly correlationId?: string;
}

export type InboxEvent =
  | { readonly type: "message"; readonly message: AgentMessage }
  | {
      readonly type: "permission_response";
      readonly toolUseId: string;
      readonly decision: "allow" | "deny";
      readonly reason?: string;
    }
  | {
      readonly type: "answer";
      readonly correlationId: string;
      readonly answer: string;
    };
