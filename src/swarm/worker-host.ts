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
import type { LaneEvent, FailureClass } from "./events.js";
import type { ParentTransport } from "./ipc/parent-transport.js";
import type { AgentResult } from "./host.js";
import type { IpcNotification } from "./ipc/protocol.js";
import {
  isValidTransition,
  INITIAL_LIFECYCLE_STATE,
  type WorkerLifecycleState,
} from "./worker-lifecycle.js";
import { writeWorkerState } from "./worker-state-file.js";

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

  private _lifecycleState: WorkerLifecycleState = INITIAL_LIFECYCLE_STATE;
  /** taskId from the run-request; set by markRunning(taskId). */
  private _taskId: string | undefined;
  /** AgentId of the parent that spawned this worker; set at construction. */
  private readonly _parentAgentId: AgentId | undefined;
  /** Epoch ms when this WorkerHost was constructed (worker process start). */
  private readonly _startedAt: number;

  constructor(
    readonly agentId: AgentId,
    readonly depth: number,
    readonly permissionMode: PermissionMode,
    private readonly transport: ParentTransport,
    private readonly parentToolUseId?: string,
    parentAgentId?: AgentId,
  ) {
    this._parentAgentId = parentAgentId;
    this._startedAt = Date.now();
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

    // Write initial state file immediately so a crash during setup is recorded.
    // Wrapped in try/catch so disk failures don't kill the worker before it
    // can complete its worker_ready handshake (an unwrapped throw here would
    // crash the constructor → parent times out at 10s waiting for ready).
    try {
      writeWorkerState({
        agentId: this.agentId,
        pid: process.pid,
        startedAt: this._startedAt,
        lifecycleState: this._lifecycleState,
        lastTransitionAt: this._startedAt,
        ...(this._parentAgentId !== undefined && { parentAgentId: this._parentAgentId }),
      });
    } catch (err) {
      process.stderr.write(
        `[WorkerHost] failed to write initial state file (agentId=${this.agentId}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
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

  getLifecycleState(): WorkerLifecycleState {
    return this._lifecycleState;
  }

  // --- Public lifecycle wrappers (internal API — called by worker-entry) ---

  /** Called once the worker_ready handshake completes and the worker is idle. */
  markReadyForPrompt(): void {
    this._transitionTo("ready_for_prompt");
  }

  /**
   * Called when a "run" request arrives. Immediately pairs prompt_accepted
   * with running — the worker accepts the prompt and starts executing it.
   * @param taskId Optional task identifier to persist in the state file.
   */
  markRunning(taskId?: string): void {
    if (taskId !== undefined) {
      this._taskId = taskId;
    }
    this._transitionTo("prompt_accepted");
    this._transitionTo("running");
  }

  /** Called after task_result is emitted (successful run). */
  markFinished(): void {
    this._transitionTo("finished");
  }

  /** Called on uncaught error or transport closure before task_result. */
  markFailed(failureClass: FailureClass, reason: string): void {
    this._transitionTo("failed", { failureClass, reason });
  }

  private _transitionTo(
    next: WorkerLifecycleState,
    opts?: { failureClass?: FailureClass; reason?: string },
  ): void {
    const from = this._lifecycleState;
    if (!isValidTransition(from, next)) {
      process.stderr.write(
        `[WorkerHost] invalid lifecycle transition: ${from} → ${next} (agentId=${this.agentId})\n`,
      );
      return;
    }
    this._lifecycleState = next;
    this.emit({
      type: "worker_lifecycle_changed",
      payload: {
        from,
        to: next,
        ...(opts?.failureClass !== undefined && {
          failureClass: opts.failureClass,
        }),
        ...(opts?.reason !== undefined && { reason: opts.reason }),
      },
    });
    // Persist state file ONLY on terminal transitions (finished / failed).
    // Per-transition writes were tried but caused ~4x slowdown in
    // integration tests with concurrent subprocess workers (each did ~5
    // sync fsync calls during its lifecycle). Constructor write captures
    // "spawning"; terminal write captures the final outcome — those two
    // are what crash recovery actually needs. Intermediate states
    // (ready_for_prompt, prompt_accepted, running) are observable via the
    // lane event stream, not the state file.
    if (next === "finished" || next === "failed") {
      const now = Date.now();
      try {
        writeWorkerState({
          agentId: this.agentId,
          pid: process.pid,
          startedAt: this._startedAt,
          lifecycleState: next,
          lastTransitionAt: now,
          ...(this._taskId !== undefined && { taskId: this._taskId }),
          ...(this._parentAgentId !== undefined && { parentAgentId: this._parentAgentId }),
          ...(opts?.failureClass !== undefined && { failureClass: opts.failureClass }),
          ...(opts?.reason !== undefined && { reason: opts.reason }),
        });
      } catch (err) {
        process.stderr.write(
          `[WorkerHost] failed to persist terminal state file (agentId=${this.agentId}): ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
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
      // Worker-mode spawn proxies to the orchestrator and returns a finalized
      // result — long-lived semantics (run_more/drain) are not supported across
      // the IPC boundary in v0.4 stage 4D. Surface a clear error if a caller
      // tries to use them on a worker-side child handle.
      runMore: async () => {
        throw new Error(
          "AgentHandle.runMore() is not supported for sub-agents spawned via WorkerHost (v0.4 stage 4D limitation)",
        );
      },
      drain: async () => {
        throw new Error(
          "AgentHandle.drain() is not supported for sub-agents spawned via WorkerHost (v0.4 stage 4D limitation)",
        );
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
   * Request the list of team members from the orchestrator.
   *
   * v0.4 stage 4E.1: worker calls this to populate the `team_members` Tier 2
   * tool result. Orchestrator resolves the worker's team scope and returns
   * `[{memberId, role, agentId}]` for peers (excluding the caller).
   */
  async requestTeamMembers(): Promise<
    Array<{ memberId: string; role: string; agentId: AgentId }>
  > {
    const result = await this.transport.send<
      Array<{ memberId: string; role: string; agentId: string }>
    >("team.members", {}, { timeoutMs: 5000 });
    return result as Array<{
      memberId: string;
      role: string;
      agentId: AgentId;
    }>;
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
   * Timeout: controlled by `SWARM_HARNESS_ASK_TIMEOUT_MS` env var (default
   * 600_000 ms). On orchestrator-side timeout the IPC layer surfaces
   * `request_timeout`, which we translate to `{status: "timed-out"}`.
   * Transport close returns `{status: "error", message: "transport_closed: ..."}`.
   */
  async askUser(
    question: string,
    options?: readonly string[],
  ): Promise<import("./host.js").AskUserResponse> {
    const rawTimeout = process.env.SWARM_HARNESS_ASK_TIMEOUT_MS ?? "600000";
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
