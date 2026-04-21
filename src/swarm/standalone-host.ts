import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  SwarmHost,
  SpawnRequest,
  AgentHandle,
  AgentResult,
  AgentMessage,
  InboxEvent,
  TaskAPI,
  TaskRecord,
  TaskPacket,
  TaskFilter,
  SendResult,
} from "./host.js";
import type { AgentId, PermissionMode, SessionId } from "../core/types.js";
import type { LaneEvent } from "./events.js";
import { TaskRegistry } from "./task-registry.js";
import { WorkerTransport } from "./ipc/worker-transport.js";
import { spawnWorker } from "./subprocess-spawner.js";
import { resolveMaxDepth } from "./depth-limit.js";
import { clampPermissionMode } from "./permission-order.js";
import { AgentInbox } from "./inbox.js";
import { RoleIndex } from "./role-index.js";
import {
  IPC_ERROR_CODES,
  MessageSendParamsSchema,
  type IpcRequest,
} from "./ipc/protocol.js";

export interface StandaloneHostOptions {
  readonly registry?: TaskRegistry;
  readonly agentId?: AgentId;
  readonly maxDepth?: number;
  readonly permissionMode?: PermissionMode;
  /** For tests: override subprocess spawn so no real child is created. */
  readonly spawnWorker?: typeof spawnWorker;
}

export class StandaloneHost implements SwarmHost {
  readonly mode = "standalone" as const;
  readonly agentId: AgentId;
  readonly depth: number = 0; // root is always depth 0
  readonly permissionMode: PermissionMode;

  private readonly registry: TaskRegistry;
  private readonly depths = new Map<AgentId, number>();
  private readonly maxDepth: number;
  private readonly events = new EventEmitter();
  private readonly spawnFn: typeof spawnWorker;

  // M3a Phase 3 messaging state.
  private readonly messageInbox = new AgentInbox();
  private readonly roles = new RoleIndex();
  /** Live worker transports keyed by child agentId for `sub_agent_event` delivery. */
  private readonly transports = new Map<AgentId, WorkerTransport>();

  // Expose the registry via the TaskAPI wrapper.
  readonly task: TaskAPI;

  constructor(opts: StandaloneHostOptions = {}) {
    this.agentId = (opts.agentId ?? (randomUUID() as string)) as AgentId;
    this.registry = opts.registry ?? new TaskRegistry();
    this.maxDepth = opts.maxDepth ?? resolveMaxDepth();
    this.permissionMode = opts.permissionMode ?? "workspace-write";
    this.spawnFn = opts.spawnWorker ?? spawnWorker;
    this.depths.set(this.agentId, 0);

    this.task = {
      create: async (packet) => this.registry.create(packet),
      get: async (id) => this.registry.get(id),
      list: async (filter?: TaskFilter) => this.registry.list(filter),
      update: async (id, patch) => this.registry.update(id, patch),
      stop: async () => {
        throw new Error("task.stop not implemented in M1");
      },
      output: async function* () {
        // Empty iterator; output streaming is M3.
        return;
      },
    };
  }

  emit(event: Omit<LaneEvent, "ts" | "agentId">): void {
    const full: LaneEvent = { ...event, ts: Date.now(), agentId: this.agentId };
    this.registry.emit(full);
    this.events.emit("lane_event", full);
  }

  async spawn(request: SpawnRequest): Promise<AgentHandle> {
    // AUTHORITATIVE depth: compute from parent's depth in our own map.
    const parentId =
      (request.parentAgentId ?? this.agentId) as AgentId;
    const parentDepth = this.depths.get(parentId);
    if (parentDepth === undefined) {
      throw new Error(
        `StandaloneHost.spawn: unknown parentAgentId "${parentId}"`,
      );
    }
    const childDepth = parentDepth + 1;
    if (childDepth > this.maxDepth) {
      // Emit lane event and reject.
      this.emit({
        type: "recursion_limit_hit",
        payload: { parentAgentId: parentId, attemptedDepth: childDepth, limit: this.maxDepth },
      });
      throw new Error(
        `recursion depth limit reached (${this.maxDepth})`,
      );
    }

    // Allocate child identity.
    const childAgentId = randomUUID() as AgentId;
    this.depths.set(childAgentId, childDepth);
    // Register role if the spawn request carries one (M3a Phase 3 — used by
    // `role:<name>` addressing in send_message; full role wiring lands in Phase 6).
    if (request.role !== undefined) {
      this.roles.register(childAgentId, request.role);
    }

    // Task registration: reuse or create.
    let taskRecord: TaskRecord;
    if (request.taskId !== undefined) {
      const existing = this.registry.get(request.taskId);
      if (!existing) {
        throw new Error(
          `StandaloneHost.spawn: unknown taskId "${request.taskId}"`,
        );
      }
      taskRecord = existing;
    } else {
      // Create a record from the packet (without id).
      // SpawnRequest.task is a TaskPacket including id; registry.create wants
      // Omit<TaskPacket,"id">. We strip id.
      const { id: _ignored, ...packetWithoutId } = request.task;
      taskRecord = this.registry.create(packetWithoutId);
    }

    // Spawn the subprocess.
    this.emit({
      type: "spawn_requested",
      payload: {
        parentAgentId: parentId,
        childAgentId,
        taskId: taskRecord.id,
        depth: childDepth,
      },
    });

    // Clamp child permission mode: child cannot escalate beyond parent's level.
    const clampedMode = clampPermissionMode(
      request.permissionMode,
      this.permissionMode,
    );

    const child = this.spawnFn({
      agentId: childAgentId,
      depth: childDepth,
      parentPid: process.pid,
      orchestratorPid: process.pid,
      parentToolUseId: request.parentToolUseId,
      permissionMode: clampedMode,
    });
    const transport = new WorkerTransport(child);
    this.transports.set(childAgentId, transport);

    // Wire worker-initiated requests (M3a Phase 3: message.send; other methods
    // — spawn/task.* — are routed here but currently unsupported in the
    // StandaloneHost worker path. Returning UNKNOWN_METHOD keeps the transport
    // healthy rather than leaving requests pending.)
    transport.on("request", (frame: IpcRequest) => {
      this.handleWorkerRequest(childAgentId, transport, frame).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          message,
        );
      });
    });

    // Wait for worker_ready with a 10s timeout.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        transport.kill("SIGTERM");
        reject(
          new Error("worker_ready timeout: child never emitted worker_ready"),
        );
      }, 10_000);
      transport.once("worker_ready", () => {
        clearTimeout(timer);
        resolve();
      });
      transport.once("close", () => {
        clearTimeout(timer);
        reject(new Error("worker exited before emitting worker_ready"));
      });
    });
    await readyPromise;

    // Fire off the `run` request with the task packet.
    const taskForWorker: TaskPacket = { ...taskRecord };
    const runAckPromise = transport.send("run", taskForWorker, {
      timeoutMs: 30_000,
    });

    // Collect lane events into a buffer + re-emit on our bus.
    const laneBuffer: LaneEvent[] = [];
    const laneListener = (params: unknown) => {
      laneBuffer.push(params as LaneEvent);
      this.events.emit("lane_event", params as LaneEvent);
    };
    transport.on("lane_event", laneListener);

    // Promise that resolves with the final AgentResult.
    const resultPromise = new Promise<AgentResult>((resolve) => {
      transport.once("task_result", (params: unknown) => {
        resolve(params as AgentResult);
      });
      transport.once("close", (exit: unknown) => {
        // Messaging cleanup on worker exit.
        this.onWorkerExited(childAgentId);
        // If close arrives before task_result, synthesize a failure.
        const exitCode = (exit as { code: number | null } | undefined)?.code ?? null;
        resolve({
          status: "failure",
          error: `worker exited (code=${exitCode}) before emitting task_result`,
          wallClockMs: 0,
        });
      });
    });

    // Await run ack (don't block the final result — run() just confirms receipt).
    void runAckPromise.catch(() => {
      /* if run ack rejects, result will resolve via task_result or close */
    });

    const handle: AgentHandle = {
      agentId: childAgentId,
      sessionId: childAgentId as unknown as SessionId, // M1 fresh session per worker; reuse id
      wait: async () => resultPromise,
      kill: async () => {
        transport.kill("SIGTERM");
      },
      events: async function* () {
        // Replay buffered events then listen for more.
        for (const evt of laneBuffer) yield evt;
        // M1: don't stream live; return after buffer.
        return;
      },
    };
    return handle;
  }

  /**
   * Real send (M3a Phase 3).
   *
   * Resolves recipients, enforces rev-2 Option A depth-1 scope, enqueues per
   * recipient, and emits `message_sent`/`inbox_overflow` lane events.
   * Best-effort live delivery uses `sub_agent_event` with
   * `eventKind: "inbox_delivery"` so a worker mid-turn sees the message
   * without polling.
   */
  async send(
    to: AgentId | "*" | `role:${string}`,
    message: AgentMessage,
  ): Promise<SendResult> {
    // 1. Resolve recipients.
    const from = message.from;
    let recipients: AgentId[];
    if (to === "*") {
      recipients = [...this.depths.keys()].filter((id) => id !== from);
    } else if (typeof to === "string" && to.startsWith("role:")) {
      const role = to.slice("role:".length);
      recipients = this.roles
        .agentsInRole(role)
        .filter((id) => id !== from);
    } else {
      const direct = to as AgentId;
      if (!this.depths.has(direct)) {
        return { ok: false, delivered: 0, reason: "unknown_recipient" };
      }
      recipients = [direct];
    }

    // 2. Depth-1 scope enforcement (rev-2 Option A).
    // Root orchestrator = depth 0, workers it spawns = depth 1.
    // Messaging only supported at depth ≤ 1 on BOTH sides.
    const senderDepth = this.depths.get(from) ?? 0;
    if (senderDepth > 1) {
      return {
        ok: false,
        delivered: 0,
        reason: "depth>1 messaging unsupported",
      };
    }
    for (const r of recipients) {
      const rDepth = this.depths.get(r) ?? 0;
      if (rDepth > 1) {
        return {
          ok: false,
          delivered: 0,
          reason: "depth>1 messaging unsupported",
        };
      }
    }

    // 3. Enqueue + emit events + attempt immediate delivery.
    let dropped = 0;
    let delivered = 0;
    for (const r of recipients) {
      const d = this.messageInbox.enqueue(r, message);
      if (d > 0) {
        dropped += d;
        this.emit({
          type: "inbox_overflow",
          payload: { agentId: r, droppedCount: d },
        });
      }
      delivered += 1;
      this.emit({
        type: "message_sent",
        payload: {
          from,
          to: r,
          ...(message.correlationId !== undefined && {
            correlationId: message.correlationId,
          }),
        },
      });
      // Best-effort push to live worker.
      const transport = this.transports.get(r);
      if (transport !== undefined) {
        transport.notify("sub_agent_event", {
          agentId: r,
          eventKind: "inbox_delivery",
          message,
        });
      }
    }

    const result: SendResult = {
      ok: true,
      delivered,
      ...(dropped > 0 && { dropped, partial: true }),
    };
    return result;
  }

  /**
   * Synchronously drain up to `max` messages queued for this host's own agent.
   * Used by the `check_inbox` tool when executing in the root orchestrator
   * (the only "standalone" case where this host answers a tool call directly).
   */
  drainInbox(max: number): AgentMessage[] {
    return this.messageInbox.drain(this.agentId, max);
  }

  async *inbox(): AsyncIterable<InboxEvent> {
    return; // M3b+: full inbox iterator. Phase 3 uses drainInbox + sub_agent_event.
  }

  // -------------------------------------------------------------------------
  // Worker lifecycle + IPC plumbing (M3a Phase 3)
  // -------------------------------------------------------------------------

  private onWorkerExited(agentId: AgentId): void {
    this.roles.evict(agentId);
    const discarded = this.messageInbox.discardAgent(agentId);
    if (discarded.length > 0) {
      this.emit({
        type: "inbox_drained_on_exit",
        payload: { agentId, messageCount: discarded.length },
      });
    }
    this.transports.delete(agentId);
    // Keep depth entry so post-exit lookups are stable; reaping belongs to M4+.
  }

  private async handleWorkerRequest(
    from: AgentId,
    transport: WorkerTransport,
    frame: IpcRequest,
  ): Promise<void> {
    if (frame.method === "message.send") {
      const parsed = MessageSendParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      const p = parsed.data;
      const result = await this.send(
        p.to as AgentId | "*" | `role:${string}`,
        {
          from: from as AgentId,
          to: p.to as AgentId,
          content: p.content,
          timestamp: p.timestamp,
          ...(p.correlationId !== undefined && {
            correlationId: p.correlationId,
          }),
        },
      );
      transport.respond(frame.id, result);
      return;
    }
    if (frame.method === "message.recv") {
      // Orchestrator-side inbox drain for this worker.
      const max =
        typeof (frame.params as { max?: unknown })?.max === "number"
          ? Math.max(1, (frame.params as { max: number }).max)
          : 10;
      const messages = this.messageInbox.drain(from, max);
      transport.respond(frame.id, messages);
      return;
    }
    // Unknown / unsupported method — reply so the worker doesn't hang.
    transport.respondError(
      frame.id,
      IPC_ERROR_CODES.UNKNOWN_METHOD,
      `method not supported in StandaloneHost: ${frame.method}`,
    );
  }
}
