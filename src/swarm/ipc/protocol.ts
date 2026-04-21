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
 *
 * Notifications (one-way, no correlation id match needed):
 *   - "worker_ready"      (worker → orchestrator; params: { agentId, depth, pid })
 *   - "lane_event"        (worker → orchestrator; params: LaneEvent)
 *   - "heartbeat"         (worker → orchestrator; params: { agentId, ts })
 *   - "task_result"       (worker → orchestrator; params: AgentResult)
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
  | "ancestry.is_ancestor_of";

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
  | "task_stop_signal";

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
