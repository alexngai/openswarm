import type {
  SwarmHost,
  SpawnRequest,
  AgentHandle,
  AgentMessage,
  InboxEvent,
  TaskAPI,
  TaskRecord,
  TaskFilter,
  SendResult,
} from "./host.js";
import type { AgentId, PermissionMode, SessionId } from "../core/types.js";
import type { LaneEvent } from "./events.js";
import type { ParentTransport } from "./ipc/parent-transport.js";
import type { AgentResult } from "./host.js";
import type { IpcNotification } from "./ipc/protocol.js";

export class WorkerHost implements SwarmHost {
  readonly mode = "worker" as const;
  readonly kind = "worker" as const;

  /**
   * Buffered inbox deliveries that arrived via `sub_agent_event` with
   * `eventKind === "inbox_delivery"`. `drainInbox` empties this buffer up
   * to `max`, then falls back to an orchestrator-side `message.recv` request
   * so any queued-but-undelivered messages also get returned.
   */
  private readonly inboxBuffer: AgentMessage[] = [];

  constructor(
    readonly agentId: AgentId,
    readonly depth: number,
    readonly permissionMode: PermissionMode,
    private readonly transport: ParentTransport,
    private readonly parentToolUseId?: string,
  ) {
    // Subscribe to sub_agent_event notifications. This handler is installed
    // unconditionally so messages that arrive between turns (e.g. while the
    // worker is mid-response) are buffered and surface on the next
    // check_inbox call. Guard against minimal transport fakes that don't
    // inherit from EventEmitter (used in spawn-integration.test.ts etc).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = this.transport as any;
    if (typeof t?.on === "function") {
      t.on("notification", (frame: IpcNotification) => {
        if (
          frame.method === "sub_agent_event" &&
          typeof frame.params === "object" &&
          frame.params !== null &&
          (frame.params as { eventKind?: string }).eventKind ===
            "inbox_delivery"
        ) {
          const msg = (frame.params as { message?: AgentMessage }).message;
          if (msg !== undefined) this.inboxBuffer.push(msg);
        }
      });
    }
  }

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
    stop: async (id: string, by?: import("../core/types.js").AgentId | "orchestrator") => {
      await this.transport.send("task.stop", { taskId: id, by });
    },
    ownerOf: async (taskId: string) => {
      const result = await this.transport.send<string | null>(
        "task.owner_of",
        { taskId },
      );
      return (result ?? undefined) as import("../core/types.js").AgentId | undefined;
    },
    appendOutput: (_id: string, _chunk: string) => {
      // Workers do not call appendOutput directly — the orchestrator wires
      // text_delta events from lane_event notifications. This is a no-op on
      // the worker side to satisfy the interface.
    },
    output: (id: string) => this.taskOutput(id),
  };

  private async *taskOutput(id: string): AsyncIterable<string> {
    const result = await this.transport.send<{ output?: string }>(
      "task.output",
      { taskId: id },
    );
    if (result.output !== undefined && result.output.length > 0) {
      yield result.output;
    }
  }

  async isAncestorOf(ancestor: AgentId, descendant: AgentId): Promise<boolean> {
    return this.transport.send<boolean>("ancestry.is_ancestor_of", {
      ancestor,
      descendant,
    });
  }

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

  /**
   * Send a message via the orchestrator (rev-2 Option A: all routing lives at
   * depth 0). Proxies through `message.send` IPC request.
   */
  async send(
    to: AgentId | "*" | `role:${string}`,
    message: AgentMessage,
  ): Promise<SendResult> {
    const result = await this.transport.send<SendResult>("message.send", {
      to,
      content: message.content,
      from: message.from,
      timestamp: message.timestamp,
      ...(message.correlationId !== undefined && {
        correlationId: message.correlationId,
      }),
    });
    return result;
  }

  /**
   * Synchronously drain up to `max` messages from the local buffer.
   *
   * Note: `sub_agent_event` deliveries populate the buffer opportunistically.
   * Messages enqueued while the worker was not subscribed (or that arrive
   * during a race) must be fetched via an explicit `message.recv` IPC.
   * For Phase 3 simplicity, this method returns ONLY what's already in the
   * local buffer — the orchestrator pushes proactively, so the only way to
   * miss a message is a dropped notification (see Decision context #2:
   * best-effort, in-memory delivery).
   */
  drainInbox(max: number): AgentMessage[] {
    if (max <= 0) return [];
    const take = Math.min(max, this.inboxBuffer.length);
    return this.inboxBuffer.splice(0, take);
  }

  async *inbox(): AsyncIterable<InboxEvent> {
    return;
  }

  /**
   * Proxy ask_user_question through the orchestrator.
   *
   * Timeout: controlled by `SWARM_CODER_ASK_TIMEOUT_MS` env var (default
   * 600_000 ms). On orchestrator-side timeout the IPC layer surfaces
   * `request_timeout`, which we translate to `{status: "timed-out"}`.
   * Transport close returns `{status: "error", message: "transport_closed: ..."}`.
   */
  async askUser(
    question: string,
    options?: readonly string[],
  ): Promise<import("./host.js").AskUserResponse> {
    const rawTimeout = process.env.SWARM_CODER_ASK_TIMEOUT_MS ?? "600000";
    const parsedTimeout = parseInt(rawTimeout, 10);
    const timeoutMs =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : 600_000;

    try {
      const result = await this.transport.send<{ answer: string }>(
        "ask_user_question",
        { question, options, timeoutMs },
        { timeoutMs },
      );
      return { status: "answered", answer: result.answer };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "request_timeout" || code === "timeout") {
        return { status: "timed-out" };
      }
      if (code === "cancelled") {
        return { status: "cancelled" };
      }
      if (code === "transport_closed") {
        return { status: "error", message: `transport_closed: ${msg}` };
      }
      return { status: "error", message: msg };
    }
  }
}
