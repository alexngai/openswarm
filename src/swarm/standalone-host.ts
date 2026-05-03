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
import type { LaneEvent, FailureClass } from "./events.js";
import {
  isValidTransition,
  INITIAL_LIFECYCLE_STATE,
  type WorkerLifecycleState,
} from "./worker-lifecycle.js";
import {
  listWorkerStates,
  isWorkerProcessAlive,
  type WorkerStateFile,
} from "./worker-state-file.js";
import { isAncestorOf as ancestorCheck } from "./ancestry.js";
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
  TaskStopParamsSchema,
  TaskOutputParamsSchema,
  TaskOwnerOfParamsSchema,
  TaskGetParamsSchema,
  TaskListParamsSchema,
  TaskCreateParamsSchema,
  TaskUpdateParamsSchema,
  AncestryIsAncestorOfParamsSchema,
  AskUserQuestionParamsSchema,
  type IpcRequest,
} from "./ipc/protocol.js";

/**
 * Injectable readline factory (for testability). Default uses the real
 * node:readline/promises module; tests override via `StandaloneHostOptions.readlineFactory`.
 */
export interface ReadlineLike {
  question(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
  close(): void;
}
export type ReadlineFactory = () => Promise<ReadlineLike>;

export interface StandaloneHostOptions {
  readonly registry?: TaskRegistry;
  readonly agentId?: AgentId;
  readonly maxDepth?: number;
  readonly permissionMode?: PermissionMode;
  /** For tests: override subprocess spawn so no real child is created. */
  readonly spawnWorker?: typeof spawnWorker;
  /**
   * For tests: override the readline/promises interface used by askUser().
   * When absent, askUser() lazy-imports node:readline/promises.
   */
  readonly readlineFactory?: ReadlineFactory;
}

export class StandaloneHost implements SwarmHost {
  readonly mode = "standalone" as const;
  readonly kind = "standalone" as const;
  readonly agentId: AgentId;
  readonly depth: number = 0; // root is always depth 0
  readonly permissionMode: PermissionMode;

  private readonly registry: TaskRegistry;
  private readonly depths = new Map<AgentId, number>();
  /**
   * Spawn-parent map: childAgentId → parentAgentId.
   * Populated at spawn() time. Eviction on worker_exited is deferred to M3b
   * alongside worker lifecycle tracking. The pre-existing `depths` map has
   * the same non-eviction behavior today.
   */
  private readonly spawnParents = new Map<AgentId, AgentId>();
  /** AgentHandle keyed by taskId — populated at spawn() to enable task_stop. */
  private readonly taskHandles = new Map<string, AgentHandle>();
  /**
   * agentId → taskId: used to route incoming text_delta lane events to
   * appendOutput. Populated at spawn() alongside taskHandles.
   * Wiring approach: agentId lookup (simpler than annotating text_delta frames).
   */
  private readonly agentToTaskId = new Map<AgentId, string>();
  private readonly maxDepth: number;
  private readonly events = new EventEmitter();
  private readonly spawnFn: typeof spawnWorker;
  private readonly readlineFactory: ReadlineFactory;

  private _lifecycleState: WorkerLifecycleState = INITIAL_LIFECYCLE_STATE;

  // M3a Phase 3 messaging state.
  private readonly messageInbox = new AgentInbox();
  private readonly roles = new RoleIndex();
  /** Live worker transports keyed by child agentId for `sub_agent_event` delivery. */
  private readonly transports = new Map<AgentId, WorkerTransport>();
  /**
   * agentId → team scope. Populated at spawn() so send_message can resolve
   * `*` and `role:<x>` against the sender's scope (v0.4 stage 4A.3).
   * The orchestrator's own agentId always maps to `"swarm:default"`.
   */
  private readonly agentToScope = new Map<AgentId, string>();

  // Expose the registry via the TaskAPI wrapper.
  readonly task: TaskAPI;

  constructor(opts: StandaloneHostOptions = {}) {
    this.agentId = (opts.agentId ?? (randomUUID() as string)) as AgentId;
    this.registry = opts.registry ?? new TaskRegistry();
    this.maxDepth = opts.maxDepth ?? resolveMaxDepth();
    this.permissionMode = opts.permissionMode ?? "workspace-write";
    this.spawnFn = opts.spawnWorker ?? spawnWorker;
    this.readlineFactory =
      opts.readlineFactory ??
      (async () => {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return {
          question: (prompt: string) => rl.question(prompt),
          close: () => rl.close(),
        };
      });
    this.depths.set(this.agentId, 0);
    this.agentToScope.set(this.agentId, "swarm:default");

    // Orphan-scan + crash_detected emission is wired but DISABLED at
    // construction time after v0.2 stage 2B integration tests showed it
    // contributed to per-test slowdowns when stale state files accumulate
    // and the scan + N emit loops run synchronously in the constructor.
    // The `scanForOrphanWorkers()` method below is still public so
    // orchestrators that want crash recovery can opt in explicitly.
    // Auto-scan-on-construction belongs to a v0.2 follow-up that also
    // makes the scan async + the write path async/batched.

    this.task = {
      create: async (packet) => this.registry.create(packet),
      get: async (id) => this.registry.get(id),
      list: async (filter?: TaskFilter) => this.registry.list(filter),
      update: async (id, patch) => this.registry.update(id, patch),
      ownerOf: async (taskId: string) => {
        const record = this.registry.get(taskId);
        return record?.owner;
      },
      appendOutput: (id: string, chunk: string) => {
        this.registry.appendOutput(id, chunk);
      },
      stop: async (id: string, by?: AgentId | "orchestrator") => {
        const handle = this.taskHandles.get(id);
        if (!handle) {
          throw new Error(`unknown taskId: ${id}`);
        }
        this.emit({
          type: "task_stop_requested",
          payload: { taskId: id },
        });
        await handle.kill();
        // Default `by` to "orchestrator" when called without an explicit caller —
        // the root StandaloneHost uses itself as the implicit stopper.
        this.registry.stop(id, by ?? "orchestrator");
        this.emit({
          type: "task_stopped",
          payload: { taskId: id },
        });
      },
      output: (id: string) => this.taskOutput(id),
    };
  }

  // orchestrator's own lifecycle is process lifetime; transitions are not driven
  getLifecycleState(): WorkerLifecycleState {
    return this._lifecycleState;
  }

  /**
   * Look up an agent's team scope. Returns `"swarm:default"` when unknown
   * (legacy single-team case and forward-compat for callers that haven't
   * registered yet).
   */
  scopeOf(agentId: AgentId): string {
    return this.agentToScope.get(agentId) ?? "swarm:default";
  }

  /**
   * List all members of a given team scope. Each entry carries `memberId`
   * (currently same as agentId — TeamSession will surface stable ids in a
   * later stage), `role`, and `agentId`. Agents without a registered role
   * are omitted. Optionally excludes a specific agent (typically the caller).
   *
   * Used by the `team_members` Tier 2 tool (v0.4 stage 4E.1).
   */
  listMembersInScope(
    scope: string,
    excludeAgentId?: AgentId,
  ): Array<{ memberId: string; role: string; agentId: AgentId }> {
    const out: Array<{ memberId: string; role: string; agentId: AgentId }> = [];
    for (const [agentId, agentScope] of this.agentToScope.entries()) {
      if (agentScope !== scope) continue;
      if (excludeAgentId !== undefined && agentId === excludeAgentId) continue;
      const roleInfo = this.roles.roleOf(agentId);
      if (roleInfo === undefined) continue;
      out.push({ memberId: agentId, role: roleInfo.role, agentId });
    }
    return out;
  }

  private _transitionTo(
    next: WorkerLifecycleState,
    opts?: { failureClass?: FailureClass; reason?: string },
  ): void {
    const from = this._lifecycleState;
    if (!isValidTransition(from, next)) {
      process.stderr.write(
        `[StandaloneHost] invalid lifecycle transition: ${from} → ${next} (agentId=${this.agentId})\n`,
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
    this.spawnParents.set(childAgentId, parentId);
    // Track team scope (v0.4 stage 4A.3). Defaults to "swarm:default" when the
    // spawn request omits teamScope — preserves single-team backward compat.
    const childScope = request.teamScope ?? "swarm:default";
    this.agentToScope.set(childAgentId, childScope);
    // Register role if the spawn request carries one (M3a Phase 3 — used by
    // `role:<name>` addressing in send_message; full role wiring lands in Phase 6).
    if (request.role !== undefined) {
      this.roles.register(childScope, childAgentId, request.role);
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
    // Populate TaskRecord.owner with the spawned child's agentId so
    // host.task.ownerOf(taskId) resolves to the running worker. Without this,
    // every worker-side `task_stop` would short-circuit to "unknown taskId".
    // Also handles the reuse case (existing record is re-owned by the new child).
    this.registry.update(taskRecord.id, { owner: childAgentId });

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
      ...(request.role !== undefined && { role: request.role }),
      ...(request.allowedTools !== undefined && {
        allowedTools: request.allowedTools,
      }),
      ...(request.teamScope !== undefined && { teamScope: request.teamScope }),
      ...(request.longLived === true && { longLived: true }),
      ...(request.idleTimeoutMs !== undefined && {
        idleTimeoutMs: request.idleTimeoutMs,
      }),
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
    // Also wire text_delta events to appendOutput for task_output polling.
    const laneBuffer: LaneEvent[] = [];
    const laneListener = (params: unknown) => {
      const evt = params as LaneEvent;
      laneBuffer.push(evt);
      this.events.emit("lane_event", evt);
      // Route text_delta → appendOutput via agentId → taskId map.
      if (evt.type === "text_delta") {
        const taskId = this.agentToTaskId.get(evt.agentId);
        if (taskId !== undefined) {
          const text = (evt.payload as { text?: string } | null)?.text;
          if (typeof text === "string" && text.length > 0) {
            this.registry.appendOutput(taskId, text);
          }
        }
      }
    };
    transport.on("lane_event", laneListener);

    // v0.4 stage 4D: a long-lived worker emits multiple `task_result`
    // notifications across runs. We track each "current run" with its own
    // resolver, so wait() and runMore() each get the matching result.
    const isLongLived = request.longLived === true;

    // Pending resolvers — populated when a run starts (initial spawn or
    // runMore), drained when task_result / close arrives.
    let pendingResolve: ((r: AgentResult) => void) | undefined;

    const synthesizeCloseFailure = (exit: unknown): AgentResult => {
      const exitCode = (exit as { code: number | null } | undefined)?.code ?? null;
      return {
        status: "failure",
        error: `worker exited (code=${exitCode}) before emitting task_result`,
        wallClockMs: 0,
      };
    };

    // Initial run — first task_result resolves the wait() promise.
    const resultPromise = new Promise<AgentResult>((resolve) => {
      pendingResolve = resolve;
    });

    transport.on("task_result", (params: unknown) => {
      const r = params as AgentResult;
      const resolver = pendingResolve;
      pendingResolve = undefined;
      if (resolver !== undefined) resolver(r);
    });

    // worker_idle + worker_drained notifications surface as lane events on
    // the orchestrator's bus so observers (and the host's own bookkeeping)
    // can react. The IPC notification arrives via the transport's typed
    // event emitter; handlers are no-ops for non-long-lived workers.
    transport.on("worker_idle", (params: unknown) => {
      this.events.emit("lane_event", {
        ts: Date.now(),
        agentId: childAgentId,
        type: "worker_idle",
        payload: params,
      } as LaneEvent);
    });
    transport.on("worker_drained", (params: unknown) => {
      this.events.emit("lane_event", {
        ts: Date.now(),
        agentId: childAgentId,
        type: "worker_drained",
        payload: params,
      } as LaneEvent);
    });

    transport.once("close", (exit: unknown) => {
      // Messaging cleanup on worker exit.
      this.onWorkerExited(childAgentId);
      // If close arrives while a run is still pending, synthesize a failure
      // so callers (wait / runMore) don't hang.
      const resolver = pendingResolve;
      pendingResolve = undefined;
      if (resolver !== undefined) resolver(synthesizeCloseFailure(exit));
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
      runMore: async (prompt: string, opts?: { taskId?: string }) => {
        if (!isLongLived) {
          throw new Error(
            "AgentHandle.runMore() is only available on long-lived workers (set SpawnRequest.longLived=true)",
          );
        }
        if (pendingResolve !== undefined) {
          throw new Error(
            "AgentHandle.runMore() called while a previous turn is still in flight",
          );
        }
        const next = new Promise<AgentResult>((resolve) => {
          pendingResolve = resolve;
        });
        await transport.send(
          "run_more",
          {
            prompt,
            ...(opts?.taskId !== undefined && { taskId: opts.taskId }),
          },
          { timeoutMs: 30_000 },
        );
        return next;
      },
      drain: async () => {
        if (!isLongLived) {
          throw new Error(
            "AgentHandle.drain() is only available on long-lived workers (set SpawnRequest.longLived=true)",
          );
        }
        // Send drain ack-only and wait for either worker_drained or close.
        const drainedPromise = new Promise<void>((resolve) => {
          transport.once("worker_drained", () => resolve());
          transport.once("close", () => resolve());
        });
        try {
          await transport.send("drain", {}, { timeoutMs: 30_000 });
        } catch {
          // If send fails (e.g. transport already closed), the close listener
          // above still resolves — fall through.
        }
        await drainedPromise;
      },
    };
    // Register handle by taskId so task_stop can kill the worker.
    this.taskHandles.set(taskRecord.id, handle);
    // Register agentId → taskId mapping for text_delta → appendOutput routing.
    this.agentToTaskId.set(childAgentId, taskRecord.id);
    return handle;
  }

  private async *taskOutput(id: string): AsyncIterable<string> {
    // M3a: snapshot only (streaming is M3b).
    const record = this.registry.get(id);
    if (record === undefined) {
      throw new Error(`unknown taskId: ${id}`);
    }
    if (record.output !== undefined && record.output.length > 0) {
      yield record.output;
    }
  }

  async isAncestorOf(ancestor: AgentId, descendant: AgentId): Promise<boolean> {
    return ancestorCheck(ancestor, descendant, this.spawnParents);
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
    //
    // Broadcasts (`*` and `role:<name>`) exclude depth-0 agents (the root
    // orchestrator). Nothing drains root's inbox automatically in M3a, so
    // fanning out to it just leaks messages until exit. Direct sends to
    // depth-0 are still allowed — they route to drainInbox() on the root
    // StandaloneHost if the caller explicitly wants to push a message there.
    const from = message.from;
    // Sender's team scope drives `*` and `role:<x>` resolution (v0.4 stage 4A.3).
    // Direct agentId addressing is unchanged — cross-scope direct sends remain
    // allowed so orchestrators can still pierce team boundaries deliberately.
    const senderScope = this.scopeOf(from);
    let recipients: AgentId[];
    if (to === "*") {
      recipients = [...this.depths.keys()].filter(
        (id) =>
          id !== from &&
          (this.depths.get(id) ?? 0) > 0 &&
          this.scopeOf(id) === senderScope,
      );
    } else if (typeof to === "string" && to.startsWith("role:")) {
      const role = to.slice("role:".length);
      recipients = this.roles
        .agentsInRole(senderScope, role)
        .filter(
          (id) => id !== from && (this.depths.get(id) ?? 0) > 0,
        );
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

  /**
   * Prompt the operator via the attached TTY and await an answer.
   *
   * Paths:
   *  - Headless (non-TTY stdin or stdout): returns `{status: "error"}` so the
   *    caller can detect there's no operator to ask. Worker agents must go
   *    through `SwarmHost` IPC instead.
   *  - TTY: uses `node:readline/promises` via the injectable
   *    `readlineFactory`. If `options` is provided and the operator types a
   *    number, that number maps 1-indexed into the list.
   *
   * The ink-modal integration noted in the plan is deferred; readline is the
   * M3b TTY fallback.
   */
  async askUser(
    question: string,
    options?: readonly string[],
    abort?: AbortSignal,
  ): Promise<import("./host.js").AskUserResponse> {
    this.emit({
      type: "ask_user_question_sent",
      payload: { question, optionsCount: options?.length ?? 0 },
    });

    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return {
        status: "error",
        message:
          "ask_user_question requires a TTY; use worker-mode IPC in headless contexts",
      };
    }

    // If already aborted before we start, short-circuit immediately.
    if (abort?.aborted) {
      return { status: "cancelled" };
    }

    const rl = await this.readlineFactory();
    try {
      const promptLines: string[] = [question];
      if (options != null && options.length > 0) {
        options.forEach((opt, i) => promptLines.push(`  ${i + 1}) ${opt}`));
      }
      const prompt = promptLines.join("\n") + "\n> ";

      let raw: string;
      try {
        // node:readline/promises rl.question() accepts {signal} as a second
        // argument (Node 18+). When the signal fires, question() rejects with
        // an AbortError. We catch that specifically and return cancelled.
        raw = await rl.question(prompt, abort != null ? { signal: abort } : undefined);
      } catch (err: unknown) {
        // AbortError from readline or any signal-driven cancellation.
        if (
          abort?.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return { status: "cancelled" };
        }
        throw err;
      }

      const answer = raw.trim();

      if (options != null && /^\d+$/.test(answer)) {
        const idx = parseInt(answer, 10) - 1;
        if (idx >= 0 && idx < options.length) {
          const selected = options[idx]!;
          this.emit({
            type: "ask_user_question_answered",
            payload: { question, answer: selected },
          });
          return { status: "answered", answer: selected };
        }
      }

      this.emit({
        type: "ask_user_question_answered",
        payload: { question, answer },
      });
      return { status: "answered", answer };
    } finally {
      rl.close();
    }
  }

  // -------------------------------------------------------------------------
  // Worker lifecycle + IPC plumbing (M3a Phase 3)
  // -------------------------------------------------------------------------

  /**
   * Scan the workers directory for state files that look like crashed workers.
   *
   * A worker is considered orphaned if its lifecycle state is not a terminal
   * state ("finished" or "failed") AND its process is no longer alive.
   *
   * v0.2: purely informational — callers receive the list and may emit
   * crash_detected events. No automatic file cleanup or restart logic.
   */
  scanForOrphanWorkers(): WorkerStateFile[] {
    const states = listWorkerStates();
    return states.filter(
      (s) =>
        s.lifecycleState !== "finished" &&
        s.lifecycleState !== "failed" &&
        !isWorkerProcessAlive(s.pid),
    );
  }

  private onWorkerExited(agentId: AgentId): void {
    this.roles.evict(agentId);
    this.agentToScope.delete(agentId);
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
    if (frame.method === "task.stop") {
      const parsed = TaskStopParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      // v0.4 stage 4I (Defect 3): respond BEFORE awaiting task.stop. When a
      // worker calls task_stop on its OWN task, this.task.stop calls
      // handle.kill() which closes the worker's transport synchronously —
      // any response sent after that gets dropped (writeFrame short-circuits
      // on `closed`). Sending the ack first lets the worker complete its
      // request cleanly before its transport tears down.
      transport.respond(frame.id, null);
      try {
        await this.task.stop(
          parsed.data.taskId,
          parsed.data.by as AgentId | "orchestrator" | undefined,
        );
      } catch (err) {
        // The response is already sent — surface the failure as a lane event
        // so observers see it. The original caller can't be notified
        // (transport may be closed) but the error is not silently dropped.
        this.emit({
          type: "error",
          payload: {
            class: "transport",
            message: `task.stop failed for ${parsed.data.taskId}: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          },
        });
      }
      return;
    }
    if (frame.method === "task.get") {
      const parsed = TaskGetParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      const record = this.registry.get(parsed.data.taskId);
      transport.respond(frame.id, record ?? null);
      return;
    }
    if (frame.method === "task.list") {
      const parsed = TaskListParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      const records = this.registry.list(
        parsed.data.filter as Parameters<typeof this.registry.list>[0],
      );
      transport.respond(frame.id, records);
      return;
    }
    if (frame.method === "task.create") {
      const parsed = TaskCreateParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      // Use caller's scope so the new task inherits the worker's team scope.
      const callerScope = this.scopeOf(from);
      const record = this.registry.create(
        parsed.data.packet as Parameters<typeof this.registry.create>[0],
        callerScope,
      );
      transport.respond(frame.id, record);
      return;
    }
    if (frame.method === "task.update") {
      const parsed = TaskUpdateParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      try {
        this.registry.update(
          parsed.data.taskId,
          parsed.data.patch as Parameters<typeof this.registry.update>[1],
        );
        transport.respond(frame.id, null);
      } catch (err) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    if (frame.method === "task.output") {
      const parsed = TaskOutputParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      const record = this.registry.get(parsed.data.taskId);
      if (record === undefined) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          `unknown taskId: ${parsed.data.taskId}`,
        );
        return;
      }
      transport.respond(frame.id, { output: record.output });
      return;
    }
    if (frame.method === "task.owner_of") {
      const parsed = TaskOwnerOfParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      const record = this.registry.get(parsed.data.taskId);
      transport.respond(frame.id, record?.owner ?? null);
      return;
    }
    if (frame.method === "ancestry.is_ancestor_of") {
      const parsed = AncestryIsAncestorOfParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(frame.id, IPC_ERROR_CODES.INVALID_PARAMS, parsed.error.message);
        return;
      }
      const result = await this.isAncestorOf(
        parsed.data.ancestor as AgentId,
        parsed.data.descendant as AgentId,
      );
      transport.respond(frame.id, result);
      return;
    }
    if (frame.method === "team.members") {
      const members = this.listMembersInScope(this.scopeOf(from), from);
      transport.respond(frame.id, members);
      return;
    }
    if (frame.method === "ask_user_question") {
      const parsed = AskUserQuestionParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      // M1 fix: create an AbortController tied to the worker's timeoutMs so
      // that if the worker's IPC request times out, the readline prompt is
      // also cancelled — preventing a zombie readline from holding stdin.
      const ac = new AbortController();
      const timeoutMs = parsed.data.timeoutMs ?? 600_000;
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const response = await this.askUser(
          parsed.data.question,
          parsed.data.options,
          ac.signal,
        );
        clearTimeout(timer);
        if (response.status === "answered") {
          transport.respond(frame.id, { answer: response.answer });
        } else if (response.status === "timed-out") {
          transport.respondError(frame.id, "timeout", "user did not respond in time");
        } else if (response.status === "cancelled") {
          transport.respondError(frame.id, "cancelled", "question cancelled by user");
        } else {
          transport.respondError(frame.id, "error", response.message);
        }
      } catch (err) {
        clearTimeout(timer);
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
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
