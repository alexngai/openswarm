import type {
  SwarmHost,
  SpawnRequest,
  AgentHandle,
  AgentMessage,
  InboxEvent,
  TaskAPI,
  TaskRecord,
  TaskFilter,
} from "./host.js";
import type { AgentId, SessionId } from "../core/types.js";
import type { LaneEvent } from "./events.js";
import type { ParentTransport } from "./ipc/parent-transport.js";
import type { AgentResult } from "./host.js";

export class WorkerHost implements SwarmHost {
  readonly mode = "worker" as const;

  constructor(
    readonly agentId: AgentId,
    readonly depth: number,
    private readonly transport: ParentTransport,
    private readonly parentToolUseId?: string,
  ) {}

  readonly task: TaskAPI = {
    create: async (packet) =>
      (await this.transport.send<TaskRecord>("task.create", packet)),
    get: async (id) =>
      (await this.transport.send<TaskRecord | null>("task.get", { id })) ??
      undefined,
    list: async (filter?: TaskFilter) =>
      (await this.transport.send<readonly TaskRecord[]>(
        "task.list",
        filter ?? {},
      )),
    update: async (id, patch) => {
      await this.transport.send("task.update", { id, patch });
    },
    stop: async () => {
      throw new Error("task.stop not implemented in M1");
    },
    output: async function* () {
      return;
    },
  };

  emit(event: Omit<LaneEvent, "ts" | "agentId">): void {
    const full: LaneEvent = {
      ...event,
      ts: Date.now(),
      agentId: this.agentId,
    };
    // parentToolUseId tagging: if set on worker, stamp onto payload if missing.
    const payload =
      this.parentToolUseId !== undefined &&
      typeof event.payload === "object" &&
      event.payload !== null &&
      !("parentToolUseId" in (event.payload as object))
        ? { ...(event.payload as object), parentToolUseId: this.parentToolUseId }
        : full.payload;
    void this.transport.notify("lane_event", { ...full, payload });
  }

  async spawn(request: SpawnRequest): Promise<AgentHandle> {
    // Proxy to parent. Parent returns an AgentHandle-shaped object that's
    // actually a reference — for M1, we expose `wait` via a separate
    // request. Simpler: parent returns the final AgentResult directly via
    // the "spawn" request's result (blocking). Document this choice.
    const result = await this.transport.send<{
      agentId: AgentId;
      sessionId: SessionId;
      result: AgentResult;
    }>("spawn", {
      task: request.task,
      permissionMode: request.permissionMode,
      model: request.model,
      parentAgentId: this.agentId,
      parentToolUseId: request.parentToolUseId ?? this.parentToolUseId,
      taskId: request.taskId,
      // depth is INTENTIONALLY omitted — orchestrator computes authoritatively
    });

    const agentResult = result.result;
    return {
      agentId: result.agentId,
      sessionId: result.sessionId,
      wait: async () => agentResult,
      kill: async () => {
        /* already finished by the time spawn resolves */
      },
      events: async function* () {
        return;
      },
    };
  }

  async send(_to: AgentId, _message: AgentMessage): Promise<void> {
    throw new Error("send not implemented in M1");
  }

  async *inbox(): AsyncIterable<InboxEvent> {
    return;
  }
}
