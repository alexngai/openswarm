/**
 * IPC protocol — wire format for orchestrator ↔ worker communication.
 *
 * Every frame is one line of JSON on stdio (newline-delimited).
 * SDK types MUST NOT appear here — the protocol is provider-agnostic.
 *
 * Methods used in requests (orchestrator → worker OR worker → orchestrator):
 *   - "run"           (orchestrator → worker; params: TaskPacket; result: { accepted: boolean })
 *   - "spawn"         (worker → orchestrator; params: SpawnRequestParams; result: AgentHandleRef)
 *   - "task.create"   (worker → orchestrator; params: Omit<TaskPacket,"id">; result: TaskRecord)
 *   - "task.update"   (worker → orchestrator; params: { id, patch }; result: void)
 *   - "task.get"      (worker → orchestrator; params: { id }; result: TaskRecord | null)
 *   - "task.list"     (worker → orchestrator; params: TaskFilter; result: readonly TaskRecord[])
 *   - "shutdown"      (orchestrator → worker; params: {}; result: { acknowledged: true })
 *   - "message.send"  (worker → orchestrator; params: MessageSendParams; result: SendResult)
 *     M3a Phase 3: worker proxies send_message tool calls to orchestrator for routing.
 *   - "message.recv"  (orchestrator → worker; params: MessageRecvParams; result: AgentMessage[])
 *     M3a Phase 3: worker requests queued messages from orchestrator inbox.
 *   - "task.stop"     (worker → orchestrator; params: { taskId: string }; result: void)
 *     M3a Phase 4: worker requests task cancellation (ancestry-checked).
 *   - "task.output"   (worker → orchestrator; params: { taskId: string }; result: TaskOutputResult)
 *     M3a Phase 4: worker polls partial or final output of a task.
 *   - "run_more"      (orchestrator → worker; params: { prompt, taskId? }; result: { accepted: boolean })
 *     v0.4 stage 4D: long-lived worker accepts another prompt. Result is ack-only;
 *     final result still arrives via the `task_result` notification.
 *   - "drain"         (orchestrator → worker; params: {}; result: { acknowledged: true })
 *     v0.4 stage 4D: long-lived worker drains gracefully. Worker exits after the
 *     current task completes (or immediately when idle).
 *   - "team.members"  (worker → orchestrator; params: {}; result: TeamMembersResult)
 *     v0.4 stage 4E.1: worker requests the list of members in its team scope.
 *
 * Notifications (one-way, no correlation id match needed):
 *   - "worker_ready"      (worker → orchestrator; params: { agentId, depth, pid })
 *   - "lane_event"        (worker → orchestrator; params: LaneEvent)
 *   - "heartbeat"         (worker → orchestrator; params: { agentId, ts })
 *   - "task_result"       (worker → orchestrator; params: AgentResult)
 *   - "worker_idle"       (worker → orchestrator; params: { agentId, readyForRunMoreAt })
 *     v0.4 stage 4D: long-lived worker finished a task and is awaiting the next prompt.
 *   - "worker_drained"    (worker → orchestrator; params: { agentId })
 *     v0.4 stage 4D: long-lived worker has gracefully drained; subprocess exit follows.
 *   - "sub_agent_event"   (orchestrator → worker; params: SubAgentEventParams)
 *     NOW LOAD-BEARING for inbox delivery (M3a Phase 3). When params.eventKind === "inbox_delivery",
 *     params carries the AgentMessage payload. Backward-compat: eventKind discriminant extends
 *     the original LaneEvent shape — existing stub callers pass through unmodified.
 *     Future M3b use of sub_agent_event MUST extend eventKind rather than changing params shape.
 *   - "sub_agent_result"  (orchestrator → worker; params: AgentResult) — M1 future; stub only
 *   - "task_stop_signal"  (orchestrator → worker; params: { taskId: string; reason?: string })
 *     M3a Phase 4: orchestrator signals a worker to stop a running task.
 */

export type IpcFrame = IpcRequest | IpcResponse | IpcNotification;

export interface IpcRequest {
  readonly kind: "request";
  readonly id: string;
  readonly method: IpcRequestMethod;
  readonly params: unknown;
}

export type IpcRequestMethod =
  | "run"
  | "spawn"
  | "task.create"
  | "task.update"
  | "task.get"
  | "task.list"
  | "shutdown"
  | "message.send"
  | "message.recv"
  | "task.stop"
  | "task.output"
  | "task.owner_of"
  | "ancestry.is_ancestor_of"
  | "ask_user_question"
  | "run_more"
  | "drain"
  | "team.members";

export type IpcResponse = IpcOk | IpcErr;

export interface IpcOk {
  readonly kind: "response";
  readonly id: string;
  readonly ok: true;
  readonly result: unknown;
}

export interface IpcErr {
  readonly kind: "response";
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export interface IpcNotification {
  readonly kind: "notification";
  readonly method: IpcNotificationMethod;
  readonly params: unknown;
}

export type IpcNotificationMethod =
  | "worker_ready"
  | "lane_event"
  | "heartbeat"
  | "task_result"
  | "sub_agent_event"
  | "sub_agent_result"
  | "task_stop_signal"
  | "worker_idle"
  | "worker_drained";

/** Well-known error codes used in IpcErr.error.code. */
export const IPC_ERROR_CODES = {
  TRANSPORT_CLOSED: "transport_closed",
  REQUEST_TIMEOUT: "request_timeout",
  MALFORMED_FRAME: "malformed_frame",
  UNKNOWN_METHOD: "unknown_method",
  INVALID_PARAMS: "invalid_params",
  INTERNAL_ERROR: "internal_error",
} as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[keyof typeof IPC_ERROR_CODES];

/**
 * Type guards to safely narrow an IpcFrame by kind. Prefer these over raw
 * `if (frame.kind === "request")` checks in transport code.
 */
export function isRequest(f: IpcFrame): f is IpcRequest {
  return f.kind === "request";
}

export function isResponse(f: IpcFrame): f is IpcResponse {
  return f.kind === "response";
}

export function isNotification(f: IpcFrame): f is IpcNotification {
  return f.kind === "notification";
}

// ---------------------------------------------------------------------------
// M3a Phase 0.4 — param schemas for new request/notification methods
// ---------------------------------------------------------------------------

import { z } from "zod";

/** params for "message.send" request (worker → orchestrator). */
export const MessageSendParamsSchema = z.object({
  to: z.string().min(1),
  content: z.string(),
  from: z.string(),
  timestamp: z.number(),
  correlationId: z.string().optional(),
});
export type MessageSendParams = z.infer<typeof MessageSendParamsSchema>;

/** params for "message.recv" request (worker polls orchestrator inbox). */
export const MessageRecvParamsSchema = z.object({
  max: z.number().int().positive().optional().default(10),
});
export type MessageRecvParams = z.infer<typeof MessageRecvParamsSchema>;

/**
 * params for "task.stop" request.
 *
 * `by` carries the caller's agentId so the orchestrator can persist it on
 * the TaskRegistry record (surfaces in the cancelled results.jsonl line).
 * Optional for backward compatibility; when absent the orchestrator
 * defaults to "orchestrator".
 */
export const TaskStopParamsSchema = z.object({
  taskId: z.string(),
  by: z.string().optional(),
});
export type TaskStopParams = z.infer<typeof TaskStopParamsSchema>;

/** params for "task.output" request. */
export const TaskOutputParamsSchema = z.object({
  taskId: z.string(),
});
export type TaskOutputParams = z.infer<typeof TaskOutputParamsSchema>;

/** params for "task.get" request (worker → orchestrator). */
export const TaskGetParamsSchema = z.object({
  taskId: z.string(),
});
export type TaskGetParams = z.infer<typeof TaskGetParamsSchema>;

/**
 * params for "task.list" request (worker → orchestrator).
 *
 * `filter` is permissive (z.unknown()) for now; the orchestrator's
 * TaskRegistry.list ignores unknown fields and the schema can be tightened
 * once worker callers stabilise.
 */
export const TaskListParamsSchema = z.object({
  filter: z.unknown().optional(),
});
export type TaskListParams = z.infer<typeof TaskListParamsSchema>;

/**
 * params for "task.create" request (worker → orchestrator).
 *
 * `packet` is `Omit<TaskPacket, "id">`. We accept the shape permissively here
 * — the orchestrator's TaskRegistry.create constructs the record from the
 * fields it knows about. A tighter schema can replace this later.
 */
export const TaskCreateParamsSchema = z.object({
  packet: z.record(z.string(), z.unknown()),
});
export type TaskCreateParams = z.infer<typeof TaskCreateParamsSchema>;

/** params for "task.update" request (worker → orchestrator). */
export const TaskUpdateParamsSchema = z.object({
  taskId: z.string(),
  patch: z.record(z.string(), z.unknown()),
});
export type TaskUpdateParams = z.infer<typeof TaskUpdateParamsSchema>;

/** params for "task_stop_signal" notification (orchestrator → worker). */
export const TaskStopSignalParamsSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
});
export type TaskStopSignalParams = z.infer<typeof TaskStopSignalParamsSchema>;

/** params for "task.owner_of" request (worker → orchestrator). */
export const TaskOwnerOfParamsSchema = z.object({
  taskId: z.string(),
});
export type TaskOwnerOfParams = z.infer<typeof TaskOwnerOfParamsSchema>;

/** params for "ancestry.is_ancestor_of" request (worker → orchestrator). */
export const AncestryIsAncestorOfParamsSchema = z.object({
  ancestor: z.string(),
  descendant: z.string(),
});
export type AncestryIsAncestorOfParams = z.infer<typeof AncestryIsAncestorOfParamsSchema>;

// ---------------------------------------------------------------------------
// M3b Phase 0.3 — ask_user_question
// ---------------------------------------------------------------------------

/**
 * params for "ask_user_question" request (worker → orchestrator).
 *
 * Response (ok: true): { answer: string }
 * Response (ok: false): { code: "timeout" | "transport_closed" | "no_operator"; message: string }
 *
 * Error codes:
 *   - "timeout"          — operator did not respond within timeoutMs
 *   - "transport_closed" — IPC channel closed before a response arrived
 *   - "no_operator"      — orchestrator has no operator attached (non-interactive mode)
 */
export const AskUserQuestionParamsSchema = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type AskUserQuestionParams = z.infer<typeof AskUserQuestionParamsSchema>;

// ---------------------------------------------------------------------------
// v0.4 stage 4D — long-lived worker frames
// ---------------------------------------------------------------------------

/**
 * params for "run_more" request (orchestrator → worker).
 *
 * Sent to a long-lived worker that's currently in `idle` to start the next
 * turn without respawning. Response is ack-only; the final result still
 * arrives asynchronously via the `task_result` notification.
 */
export const RunMoreParamsSchema = z.object({
  prompt: z.string().min(1),
  taskId: z.string().optional(),
});
export type RunMoreParams = z.infer<typeof RunMoreParamsSchema>;

/**
 * params for "drain" request (orchestrator → worker).
 *
 * Sent to a long-lived worker to request graceful exit. If the worker is
 * idle it transitions straight to drained; if it's running it transitions
 * to draining and exits after the current task completes.
 */
export const DrainParamsSchema = z.object({}).strict();
export type DrainParams = z.infer<typeof DrainParamsSchema>;

/** params for "worker_idle" notification (worker → orchestrator). */
export const WorkerIdleParamsSchema = z.object({
  agentId: z.string(),
  readyForRunMoreAt: z.number(),
});
export type WorkerIdleParams = z.infer<typeof WorkerIdleParamsSchema>;

/** params for "worker_drained" notification (worker → orchestrator). */
export const WorkerDrainedParamsSchema = z.object({
  agentId: z.string(),
});
export type WorkerDrainedParams = z.infer<typeof WorkerDrainedParamsSchema>;

// ---------------------------------------------------------------------------
// v0.4 stage 4M.6 — spawn (worker → orchestrator)
// ---------------------------------------------------------------------------

/**
 * params for "spawn" request (worker → orchestrator).
 *
 * The protocol comment header has listed `spawn` since M1, but the
 * StandaloneHost handler did not exist until 4M.6. This schema locks the
 * params shape that WorkerHost.spawn sends.
 *
 * `task` is permissive (z.record) since TaskPacket has a deeper shape that
 * is enforced upstream by the worker-side caller (the agent tool builds the
 * record via host.task.create before calling spawn).
 */
export const SpawnRequestParamsSchema = z.object({
  task: z.record(z.string(), z.unknown()),
  permissionMode: z.enum([
    "read-only",
    "workspace-write",
    "danger-full-access",
  ]),
  model: z.string().optional(),
  /** v0.4 stage 4M.6: forwarded from SpawnRequest.framework. */
  framework: z.enum(["claude-agent-sdk", "codex-chatgpt"]).optional(),
  /**
   * v0.4 stage 4M.7: forwarded from SpawnRequest.teamScope. When set, the
   * spawn handler injects this scope on the spawned child (peer-spawn). When
   * undefined, child gets the orchestrator's default scope.
   */
  teamScope: z.string().optional(),
  parentAgentId: z.string(),
  parentToolUseId: z.string().optional(),
  taskId: z.string().optional(),
});
export type SpawnRequestParams = z.infer<typeof SpawnRequestParamsSchema>;

/**
 * result for "spawn" — the spawned child's identity + final AgentResult.
 *
 * Shape mirrors what WorkerHost.spawn unpacks (lines 273-291): the IPC
 * spawn handler awaits the child's terminal state before replying, so the
 * worker-side proxy returns a synchronously-resolved AgentHandle.
 */
export const SpawnResultSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  result: z.record(z.string(), z.unknown()),
});
export type SpawnResult = z.infer<typeof SpawnResultSchema>;

// ---------------------------------------------------------------------------
// v0.4 stage 4E.1 — team.members
// ---------------------------------------------------------------------------

/**
 * params for "team.members" request (worker → orchestrator).
 *
 * Empty object — orchestrator resolves the caller's scope from `from` (the
 * worker's agentId) and returns peers in that scope. Worker cannot specify
 * an arbitrary scope.
 */
export const TeamMembersParamsSchema = z.object({}).strict();
export type TeamMembersParams = z.infer<typeof TeamMembersParamsSchema>;

/** result for "team.members" — array of `{memberId, role, agentId}` peers. */
export const TeamMembersResultSchema = z.array(
  z.object({
    memberId: z.string(),
    role: z.string(),
    agentId: z.string(),
  }),
);
export type TeamMembersResult = z.infer<typeof TeamMembersResultSchema>;
