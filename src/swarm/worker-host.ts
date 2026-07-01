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

  /**
   * Team scope this worker belongs to. Set by `worker-entry.ts` from
   * `OPENSWARM_TEAM_SCOPE` env (V0.4.Q1 propagation). Defaults to
   * `"swarm:default"` for legacy single-team runs.
   */
  private readonly _teamScope: string;

  constructor(
    readonly agentId: AgentId,
    readonly depth: number,
    readonly permissionMode: PermissionMode,
    private readonly transport: ParentTransport,
    private readonly parentToolUseId?: string,
    parentAgentId?: AgentId,
    teamScope?: string,
  ) {
    this._parentAgentId = parentAgentId;
    this._teamScope = teamScope ?? "swarm:default";
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
      (await this.transport.send<TaskRecord>("task.create", { packet })),
    get: async (id) =>
      (await this.transport.send<TaskRecord | null>("task.get", {
        taskId: id,
      })) ?? undefined,
    list: async (filter?: TaskFilter) =>
      (await this.transport.send<readonly TaskRecord[]>("task.list", {
        filter: filter ?? {},
      })),
    update: async (id, patch) => {
      await this.transport.send("task.update", { taskId: id, patch });
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
    pullNext: async (
      scope: string,
      claimerId: import("../core/types.js").AgentId,
    ) => {
      // v0.5 stage 5C: proxy through to the orchestrator's TaskAPI.
      const result = await this.transport.send<TaskRecord | null>(
        "task.pull_next",
        { scope, claimerId },
      );
      return result ?? null;
    },
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

  /** Called after task_result is emitted (successful run, non-long-lived). */
  markFinished(): void {
    this._transitionTo("finished");
  }

  /** Called on uncaught error or transport closure before task_result. */
  markFailed(failureClass: FailureClass, reason: string): void {
    this._transitionTo("failed", { failureClass, reason });
  }

  /**
   * v0.4 stage 4M.3 (M5): long-lived worker transitions to idle after a turn
   * completes (instead of `finished`/`failed`) so subsequent run_more
   * requests can validly drive `idle → prompt_accepted → running` again.
   */
  markIdle(): void {
    this._transitionTo("idle");
  }

  /**
   * v0.4 stage 4M.3 (M5): drain requested while idle. Transitions
   * `idle → drained` directly (the worker has nothing to finish).
   * If currently running, callers should instead transition through
   * `running → idle` then `idle → drained` after the turn completes.
   */
  markDrained(): void {
    this._transitionTo("drained");
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

  /**
   * v0.7 stage 7B: route a commit through git-cascade via the orchestrator's
   * branch-policy adapter. Returns null when not in a stream context.
   */
  async commitChanges(
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<
    | import("./adapters/git-cascade-branch-policy.js").CommitChangesResult
    | null
  > {
    const result = await this.transport.send<
      | import("./adapters/git-cascade-branch-policy.js").CommitChangesResult
      | null
    >("task.commit_changes", { message, ...(metadata !== undefined && { metadata }) });
    return result ?? null;
  }

  /**
   * docs/44 P2b: signal the orchestrator that this (resolver) worker has
   * resolved its assigned merge conflict and committed the fix. Proxies via
   * `task.resolve_conflict` and AWAITS the orchestrator's ack so the signal is
   * guaranteed delivered before the worker exits — a fire-and-forget
   * notification could be dropped during subprocess teardown.
   */
  async resolveConflict(
    conflictId: string,
    opts?: { readonly resolutionCommit?: string },
  ): Promise<void> {
    // review LOW: this is a local IPC ack (the orchestrator handler responds
    // synchronously), not a long operation — bound it to 10s instead of the
    // transport's 60s default so a wedged orchestrator can't keep the resolver
    // alive for a full minute during teardown.
    await this.transport.send<null>(
      "task.resolve_conflict",
      {
        conflictId,
        ...(opts?.resolutionCommit !== undefined && {
          resolutionCommit: opts.resolutionCommit,
        }),
      },
      { timeoutMs: 10_000 },
    );
  }

  /**
   * Resolve the team scope for an agent id. WorkerHost only knows about its
   * own scope (set at construction from env); callers asking about another
   * agent's scope must go through the orchestrator. v0.4 stage 4M.7: enables
   * the agent tool's `team: "self"` path on the worker side.
   */
  scopeOf(agentId: AgentId): string {
    if (agentId !== this.agentId) {
      throw new Error(
        `WorkerHost.scopeOf: cannot resolve scope for non-self agent "${agentId}" (worker only knows its own scope)`,
      );
    }
    return this._teamScope;
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
      // v0.4 stage 4M.6: forward framework so worker-spawned children can opt
      // into FrameworkProvider mode. Parallel fix to 4M.5 in StandaloneHost.spawn.
      framework: request.framework,
      // v0.4 stage 4M.7: forward teamScope so worker-side agent({team: "self"})
      // peer-spawn lands in the caller's team scope (not "swarm:default").
      teamScope: request.teamScope,
      // v0.7 stage 7A.2: forward cwd so worker-spawned children can land
      // inside a git-cascade worktree per the BranchPolicy adapter.
      cwd: request.cwd,
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
  async drainInbox(max: number): Promise<AgentMessage[]> {
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
   * Timeout: controlled by `OPENSWARM_ASK_TIMEOUT_MS` env var (default
   * 600_000 ms). On orchestrator-side timeout the IPC layer surfaces
   * `request_timeout`, which we translate to `{status: "timed-out"}`.
   * Transport close returns `{status: "error", message: "transport_closed: ..."}`.
   */
  async askUser(
    question: string,
    options?: readonly string[],
  ): Promise<import("./host.js").AskUserResponse> {
    const rawTimeout = process.env.OPENSWARM_ASK_TIMEOUT_MS ?? "600000";
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

  /**
   * Escalate a mode-denied tool call to the orchestrator (Stage B B0.3),
   * which routes it to an injected interaction handler (e.g. the ACP client).
   * Mirrors askUser(). Denies on timeout / transport error — the safe default,
   * matching what a non-escalating worker would have returned.
   */
  async requestPermission(
    req: import("./host.js").PermissionRequest,
  ): Promise<import("./host.js").PermissionDecisionResponse> {
    const rawTimeout = process.env.OPENSWARM_ASK_TIMEOUT_MS ?? "600000";
    const parsedTimeout = parseInt(rawTimeout, 10);
    const timeoutMs =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : 600_000;
    try {
      const result = await this.transport.send<{
        outcome: "allow" | "deny";
        reason?: string;
      }>(
        "permission.request",
        { ...req, agentId: this.agentId, timeoutMs },
        { timeoutMs },
      );
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: "deny", reason: `permission escalation failed: ${msg}` };
    }
  }
}
