/**
 * IPC protocol — wire format for orchestrator ↔ worker communication.
 *
 * Every frame is one line of JSON on stdio (newline-delimited).
 * SDK types MUST NOT appear here — the protocol is provider-agnostic.
 *
 * Methods used in requests (orchestrator → worker OR worker → orchestrator):
 *   - "run"         (orchestrator → worker; params: TaskPacket; result: { accepted: boolean })
 *   - "spawn"       (worker → orchestrator; params: SpawnRequestParams; result: AgentHandleRef)
 *   - "task.create" (worker → orchestrator; params: Omit<TaskPacket,"id">; result: TaskRecord)
 *   - "task.update" (worker → orchestrator; params: { id, patch }; result: void)
 *   - "task.get"    (worker → orchestrator; params: { id }; result: TaskRecord | null)
 *   - "task.list"   (worker → orchestrator; params: TaskFilter; result: readonly TaskRecord[])
 *   - "shutdown"    (orchestrator → worker; params: {}; result: { acknowledged: true })
 *
 * Notifications (one-way, no correlation id match needed):
 *   - "worker_ready"     (worker → orchestrator; params: { agentId, depth, pid })
 *   - "lane_event"       (worker → orchestrator; params: LaneEvent)
 *   - "heartbeat"        (worker → orchestrator; params: { agentId, ts })
 *   - "task_result"      (worker → orchestrator; params: AgentResult)
 *   - "sub_agent_event"  (orchestrator → worker; params: LaneEvent) — M1 future; stub only
 *   - "sub_agent_result" (orchestrator → worker; params: AgentResult) — M1 future; stub only
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
  | "shutdown";

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
  | "sub_agent_result";

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
