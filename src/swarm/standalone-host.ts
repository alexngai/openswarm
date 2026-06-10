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
  InteractionHandler,
  PermissionRequest,
  PermissionDecisionResponse,
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
import { InMemoryInboxBackend, type InboxBackend } from "./inbox.js";
import { RoleIndex } from "./role-index.js";
import {
  IdentityBranchPolicyAdapter,
  type BranchPolicyAdapter,
} from "./adapters/git-cascade-branch-policy.js";
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
  SpawnRequestParamsSchema,
  TaskPullNextParamsSchema,
  TaskCommitChangesParamsSchema,
  TaskResolveConflictParamsSchema,
  AskUserQuestionParamsSchema,
  PermissionRequestParamsSchema,
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
  /**
   * Stage B B0.3: orchestrator-side handler for worker permission escalations.
   * The ACP team path injects one that routes to the client's
   * requestPermission. Absent, the host denies escalated tool calls (the same
   * outcome a non-escalating worker would have produced).
   */
  readonly interactionHandler?: InteractionHandler;
  /**
   * v0.5 stage 5B: allow callers to wrap the constructed TaskAPI before it's
   * exposed as `host.task`. Production use case: opentasks adapter
   * (src/swarm/adapters/opentasks-task-registry.ts) mirrors create/update
   * into the opentasks daemon for cross-system visibility while leaving the
   * local in-memory registry authoritative for runtime ops.
   */
  readonly taskWrapper?: (inner: TaskAPI) => TaskAPI;
  /**
   * v0.6 stage 6A.1: pluggable inbox backend. Defaults to
   * `new InMemoryInboxBackend()`. Production callers can pass an
   * `AgentInboxBackend` (6A.2) for threading + persistence + federation.
   */
  readonly inboxBackend?: InboxBackend;
  /**
   * v0.7 stage 7A.3: pluggable BranchPolicy resolver. Defaults to
   * `new IdentityBranchPolicyAdapter()` (returns `{}` for all kinds, so
   * spawn cwd stays as `process.cwd()`). Production callers wanting
   * worktree-per-member pass a `GitCascadeBranchPolicyAdapter`.
   */
  readonly branchPolicyAdapter?: BranchPolicyAdapter;
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
  private readonly interactionHandler?: InteractionHandler;

  private _lifecycleState: WorkerLifecycleState = INITIAL_LIFECYCLE_STATE;

  // M3a Phase 3 messaging state.
  private readonly messageInbox: InboxBackend;
  private readonly branchPolicyAdapter: BranchPolicyAdapter;
  private readonly roles = new RoleIndex();
  /** Live worker transports keyed by child agentId for `sub_agent_event` delivery. */
  private readonly transports = new Map<AgentId, WorkerTransport>();
  /**
   * agentId → team scope. Populated at spawn() so send_message can resolve
   * `*` and `role:<x>` against the sender's scope (v0.4 stage 4A.3).
   * The orchestrator's own agentId always maps to `"swarm:default"`.
   */
  private readonly agentToScope = new Map<AgentId, string>();
  /**
   * agentId → stable memberId (when registered by TeamSession.spawnMember).
   * v0.4 stage 4M (M1): allows team_members() to return TeamSession's stable
   * memberId rather than echoing agentId. Optional — agents not registered
   * via TeamSession (e.g. legacy fanout via swarm run) fall through to using
   * agentId as the memberId.
   */
  private readonly agentToMemberId = new Map<AgentId, string>();
  /** docs/44 P2 — pending conflict-resolution waiters, keyed by conflictId. */
  private readonly conflictWaiters = new Map<
    string,
    (v: { resolutionCommit?: string } | null) => void
  >();
  /** docs/44 P2 — resolutions that arrived before anyone started awaiting. */
  private readonly resolvedConflicts = new Map<
    string,
    { resolutionCommit?: string }
  >();

  // Expose the registry via the TaskAPI wrapper.
  readonly task: TaskAPI;

  constructor(opts: StandaloneHostOptions = {}) {
    this.agentId = (opts.agentId ?? (randomUUID() as string)) as AgentId;
    this.registry = opts.registry ?? new TaskRegistry();
    this.maxDepth = opts.maxDepth ?? resolveMaxDepth();
    this.permissionMode = opts.permissionMode ?? "workspace-write";
    this.spawnFn = opts.spawnWorker ?? spawnWorker;
    this.interactionHandler = opts.interactionHandler;
    this.messageInbox = opts.inboxBackend ?? new InMemoryInboxBackend();
    this.branchPolicyAdapter =
      opts.branchPolicyAdapter ?? new IdentityBranchPolicyAdapter();
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

    const innerTask: TaskAPI = {
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
      pullNext: async (scope: string, claimerId: AgentId) =>
        this.registry.pullNext(scope, claimerId),
    };
    // v0.5 stage 5B: optional wrapper (e.g. opentasks adapter) sits in front
    // of the in-memory implementation so it can mirror state to an external
    // task graph daemon without disturbing local-runtime semantics.
    this.task = opts.taskWrapper !== undefined ? opts.taskWrapper(innerTask) : innerTask;
  }

  // orchestrator's own lifecycle is process lifetime; transitions are not driven
  getLifecycleState(): WorkerLifecycleState {
    return this._lifecycleState;
  }

  /**
   * v0.7 stage 7B: route a commit through git-cascade's tracker.
   * Delegates to the branch-policy adapter's commitChanges if available;
   * returns null when no adapter or when this agent isn't in a stream
   * (e.g. the orchestrator's own agentId, which has no worktree).
   */
  async commitChanges(
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<
    | import("./adapters/git-cascade-branch-policy.js").CommitChangesResult
    | null
  > {
    if (this.branchPolicyAdapter.commitChanges === undefined) return null;
    return this.branchPolicyAdapter.commitChanges(this.agentId, message, metadata);
  }

  /**
   * v0.7 stage 7B: orchestrator-side commit on behalf of a specific agent
   * (typically a worker). Used by the IPC handler for `task.commit_changes`.
   * Looks up the worker's stream via the branch-policy adapter.
   */
  async commitChangesForAgent(
    agentId: AgentId,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<
    | import("./adapters/git-cascade-branch-policy.js").CommitChangesResult
    | null
  > {
    if (this.branchPolicyAdapter.commitChanges === undefined) return null;
    return this.branchPolicyAdapter.commitChanges(agentId, message, metadata);
  }

  /**
   * v0.7 stage 7D: does the configured branch-policy adapter manage
   * streams (i.e. is it git-cascade-backed, not the identity default)?
   * Topology executors use this to decide whether to apply per-topology
   * default branch policies (per docs/25 §10.4 table).
   */
  supportsStreams(): boolean {
    return this.branchPolicyAdapter.streamIdFor !== undefined;
  }

  /**
   * v0.7 stage 7C: look up the stream id an agent is operating on. Returns
   * undefined when the adapter doesn't track streams (identity adapter)
   * or the agent isn't in a stream context.
   */
  streamIdFor(agentId: AgentId): string | undefined {
    if (this.branchPolicyAdapter.streamIdFor === undefined) return undefined;
    return this.branchPolicyAdapter.streamIdFor(agentId);
  }

  /**
   * v0.7 stage 7F: look up or create a worktree-less integrator stream
   * wrapping an existing git branch. Exposed for cascade rebase parent
   * linkage; the auto-merge path uses mergeStreamToBranchForAgent (which
   * routes around git-cascade's branch-naming limitation). Returns null
   * when the adapter isn't stream-aware.
   */
  async ensureIntegratorStream(branch: string): Promise<string | null> {
    if (this.branchPolicyAdapter.ensureIntegratorStream === undefined) return null;
    return this.branchPolicyAdapter.ensureIntegratorStream(branch);
  }

  /**
   * v0.7 stage 7F: merge an agent's stream into an existing git branch
   * via the adapter's plain-git path. Used by PeerTeamTopology when
   * `coordination.mergeStreams.targetBranch` is set. Returns null when
   * the adapter doesn't support the operation.
   */
  async mergeStreamToBranchForAgent(
    agentId: AgentId,
    opts: { readonly targetBranch: string; readonly strategy?: string },
  ): Promise<
    | import("./adapters/git-cascade-branch-policy.js").MergeStreamResult
    | null
  > {
    if (this.branchPolicyAdapter.mergeStreamToBranch === undefined) return null;
    return this.branchPolicyAdapter.mergeStreamToBranch({
      sourceAgentId: agentId,
      targetBranch: opts.targetBranch,
      ...(opts.strategy !== undefined && { strategy: opts.strategy }),
    });
  }

  /**
   * v0.7 stage 7C: merge an agent's stream into a target. Used by topology
   * auto-merge (see TeamCoordination.mergeStreams) and any future
   * model-invokable merge tool. Returns null when the adapter doesn't
   * support merges; otherwise returns the (possibly-failed) result.
   */
  async mergeStreamForAgent(
    agentId: AgentId,
    opts: {
      readonly targetStream: string;
      readonly strategy?: string;
    },
  ): Promise<
    | import("./adapters/git-cascade-branch-policy.js").MergeStreamResult
    | null
  > {
    if (this.branchPolicyAdapter.mergeStream === undefined) return null;
    return this.branchPolicyAdapter.mergeStream({
      sourceAgentId: agentId,
      targetStream: opts.targetStream,
      ...(opts.strategy !== undefined && { strategy: opts.strategy }),
    });
  }

  /**
   * docs/44 P2 — mark a conflict resolved (called by the `resolve_conflict`
   * tool). Wakes a matching waiter if present; otherwise records the
   * resolution so a later `waitForConflictResolution` returns immediately.
   */
  resolveConflict(
    conflictId: string,
    opts?: { readonly resolutionCommit?: string },
  ): void {
    const payload = { resolutionCommit: opts?.resolutionCommit };
    const waiter = this.conflictWaiters.get(conflictId);
    if (waiter !== undefined) {
      this.conflictWaiters.delete(conflictId);
      waiter(payload);
      return;
    }
    this.resolvedConflicts.set(conflictId, payload);
  }

  /**
   * docs/44 P2 — await resolution of a conflict, or time out. Returns the
   * resolution payload on success, or `null` on timeout. Idempotent-friendly:
   * a resolution that arrived before the wait started is consumed immediately.
   */
  async waitForConflictResolution(
    conflictId: string,
    timeoutMs: number,
  ): Promise<{ readonly resolutionCommit?: string } | null> {
    const already = this.resolvedConflicts.get(conflictId);
    if (already !== undefined) {
      this.resolvedConflicts.delete(conflictId);
      return already;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.conflictWaiters.delete(conflictId);
        resolve(null);
      }, timeoutMs);
      this.conflictWaiters.set(conflictId, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
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
   * Register a stable memberId for an agent (called by TeamSession.spawnMember
   * after host.spawn returns). v0.4 stage 4M (M1).
   */
  setMemberId(agentId: AgentId, memberId: string): void {
    this.agentToMemberId.set(agentId, memberId);
  }

  /**
   * Stable memberId for an agent, or undefined if not registered via
   * TeamSession. team_members() falls back to agentId when undefined so the
   * non-team legacy path still produces a string identifier.
   */
  memberIdOf(agentId: AgentId): string | undefined {
    return this.agentToMemberId.get(agentId);
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
      const memberId = this.agentToMemberId.get(agentId) ?? agentId;
      out.push({ memberId, role: roleInfo.role, agentId });
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

    // v0.7 stage 7A.3: resolve the BranchPolicy via the adapter (default
    // identity → no-op; GitCascadeBranchPolicyAdapter → creates a
    // stream + worktree and returns a cwd). Adapter resolution overrides
    // an explicit `request.cwd` when set, since the worktree is the
    // semantically-correct location for a stream/fork member.
    const branchResolution = await this.branchPolicyAdapter.resolve(
      request.task.branchPolicy,
      childAgentId,
    );
    const resolvedCwd = branchResolution.cwd ?? request.cwd;

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
      ...(request.framework !== undefined && { framework: request.framework }),
      ...(request.longLived === true && { longLived: true }),
      ...(request.idleTimeoutMs !== undefined && {
        idleTimeoutMs: request.idleTimeoutMs,
      }),
      // When the host can route escalations to an operator (the ACP team path
      // sets interactionHandler), enable the worker's permission escalation via
      // its env — scoped to the child, not the orchestrator's process.env.
      ...(this.interactionHandler !== undefined && { permissionEscalation: true }),
      // B1.4: thread the session sidecar (coordinator root only) so the worker
      // can persist + resume its engine session across processes.
      ...(request.sessionSidecarPath !== undefined && {
        sessionSidecarPath: request.sessionSidecarPath,
      }),
      // v0.7 stage 7A.2 + 7A.3: thread cwd through to the spawner. Spawner
      // already honors `args.cwd` (subprocess-spawner.ts:130, default
      // process.cwd()). resolvedCwd merges the BranchPolicy adapter's
      // worktree cwd (when set) with any explicit request.cwd.
      ...(resolvedCwd !== undefined && { cwd: resolvedCwd }),
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

    // v0.4 stage 4M (B3): emit worker_spawned now that the child is wired
    // up. The spawn_requested event above announces intent; worker_spawned
    // announces a live, observable child. MAP adapter forwards this as
    // swarm.agent.spawned per docs/25 §10.1.
    this.emit({
      type: "worker_spawned",
      payload: {
        childAgentId,
        parentAgentId: parentId,
        ...(request.role !== undefined && { role: request.role }),
        taskId: taskRecord.id,
        teamScope: childScope,
        depth: childDepth,
      },
    });

    transport.once("close", (exit: unknown) => {
      // v0.4 stage 4M (B3): emit worker_exited for MAP adapter +
      // observability. exitCode === 0 is success; null (signal-killed) and
      // any non-zero are treated as failure by the adapter.
      const exitObj = exit as { code: number | null; signal: NodeJS.Signals | null } | undefined;
      const exitCode = exitObj?.code ?? null;
      const signal = exitObj?.signal ?? null;
      this.emit({
        type: "worker_exited",
        payload: {
          agentId: childAgentId,
          exitCode,
          ...(signal !== null && { signal }),
        },
      });
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
      // v0.6 stage 6A.1: scope-keyed enqueue. Use the recipient's scope so
      // the message lands in the right queue when the backend is multi-
      // tenant (one in-memory backend per swarm-harness process serving
      // multiple team scopes; or a shared sqlite-backed agent-inbox).
      const recipientScope = this.scopeOf(r);
      const d = await this.messageInbox.enqueue(recipientScope, r, message);
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
          content: message.content,
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
  async drainInbox(max: number): Promise<AgentMessage[]> {
    return this.messageInbox.drain(this.scopeOf(this.agentId), this.agentId, max);
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
  /**
   * Resolve a worker permission escalation (Stage B B0.3). Emits a
   * `permission_prompt` lane event, delegates to the injected interaction
   * handler (the ACP client routes to the user), and emits the granted/denied
   * outcome. Denies when no handler is attached — matching what a
   * non-escalating worker would have returned.
   */
  async resolvePermission(
    req: PermissionRequest,
  ): Promise<PermissionDecisionResponse> {
    this.emit({
      type: "permission_prompt",
      payload: {
        toolName: req.toolName,
        requiredPermission: req.requiredPermission,
        currentMode: req.currentMode,
      },
    });
    const decision: PermissionDecisionResponse = this.interactionHandler
      ? await this.interactionHandler.requestPermission(req)
      : { outcome: "deny", reason: "no operator attached" };
    this.emit({
      type:
        decision.outcome === "allow"
          ? "permission_granted"
          : "permission_denied",
      payload: {
        toolName: req.toolName,
        ...(decision.reason !== undefined && { reason: decision.reason }),
      },
    });
    return decision;
  }

  async askUser(
    question: string,
    options?: readonly string[],
    abort?: AbortSignal,
  ): Promise<import("./host.js").AskUserResponse> {
    this.emit({
      type: "ask_user_question_sent",
      payload: { question, optionsCount: options?.length ?? 0 },
    });

    // Route to the operator (the ACP client) when a handler is present — the ACP
    // team path has no TTY but can prompt the editor (docs/33 §9).
    if (this.interactionHandler?.askUserQuestion !== undefined) {
      return this.interactionHandler.askUserQuestion(question, options);
    }

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

  private async onWorkerExited(agentId: AgentId): Promise<void> {
    // v0.6 stage 6A.1: capture scope BEFORE the agentToScope.delete below;
    // discard() needs the scope to find the right queue.
    const scope = this.scopeOf(agentId);
    this.roles.evict(agentId);
    this.agentToScope.delete(agentId);
    this.agentToMemberId.delete(agentId);
    const discarded = await this.messageInbox.discard(scope, agentId);
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
      const messages = await this.messageInbox.drain(this.scopeOf(from), from, max);
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
    if (frame.method === "task.commit_changes") {
      // v0.7 stage 7B: route the worker's commit through the branch-policy
      // adapter. Worker doesn't pass its own agentId — we use `from` (the
      // requester) so the adapter looks up the worker's recorded
      // {streamId, worktree} mapping.
      const parsed = TaskCommitChangesParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      try {
        const result = await this.commitChangesForAgent(
          from,
          parsed.data.message,
          parsed.data.metadata,
        );
        transport.respond(frame.id, result);
      } catch (err) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    if (frame.method === "task.resolve_conflict") {
      // docs/44 P2b: a resolver worker reports it resolved its assigned
      // conflict. Route to resolveConflict (conflictId-keyed, agent-agnostic)
      // to wake the spawn-resolver coordinator's waiter, then ack.
      const parsed = TaskResolveConflictParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      this.resolveConflict(
        parsed.data.conflictId,
        parsed.data.resolutionCommit !== undefined
          ? { resolutionCommit: parsed.data.resolutionCommit }
          : undefined,
      );
      transport.respond(frame.id, null);
      return;
    }

    if (frame.method === "task.pull_next") {
      // v0.5 stage 5C: worker self-pulls the next claimable task in its
      // scope. Routes through the (possibly wrapped) TaskAPI so opentasks
      // mirror updates fire alongside the in-memory claim.
      const parsed = TaskPullNextParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      try {
        const claimed = await this.task.pullNext(
          parsed.data.scope,
          parsed.data.claimerId as AgentId,
        );
        transport.respond(frame.id, claimed);
      } catch (err) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }

    if (frame.method === "spawn") {
      // v0.4 stage 4M.6: dispatch worker-side `agent` tool spawns. The
      // `spawn` request method has been listed in the protocol header since
      // M1 but the handler did not exist — any worker-side `agent({...})`
      // call would have hit UNKNOWN_METHOD in production. Note: this commit
      // covers default child-spawn only; the `team: "self"` peer-spawn path
      // (V0.4.Q1 follow-up) lands in 4M.7, which adds scope-aware handling.
      const parsed = SpawnRequestParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      const params = parsed.data;
      const spawnReq: SpawnRequest = {
        // The schema is permissive on `task`; the worker-side caller
        // (agent tool) constructs the TaskPacket via host.task.create
        // first, so the shape is well-formed by the time it arrives here.
        task: params.task as unknown as TaskPacket,
        permissionMode: params.permissionMode,
        ...(params.model !== undefined && { model: params.model }),
        ...(params.framework !== undefined && { framework: params.framework }),
        // v0.4 stage 4M.7: honor caller-supplied teamScope so worker-side
        // agent({team: "self"}) lands the child as a peer in the caller's
        // scope rather than the default scope.
        ...(params.teamScope !== undefined && { teamScope: params.teamScope }),
        // v0.7 stage 7A.2: forward cwd from worker-side spawn requests.
        ...(params.cwd !== undefined && { cwd: params.cwd }),
        ...(params.taskId !== undefined && { taskId: params.taskId }),
        ...(params.parentToolUseId !== undefined && {
          parentToolUseId: params.parentToolUseId,
        }),
        parentAgentId: params.parentAgentId as AgentId,
      };
      try {
        const handle = await this.spawn(spawnReq);
        const result = await handle.wait();
        transport.respond(frame.id, {
          agentId: handle.agentId,
          sessionId: handle.sessionId,
          result,
        });
      } catch (err) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
    if (frame.method === "permission.request") {
      const parsed = PermissionRequestParamsSchema.safeParse(frame.params);
      if (!parsed.success) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INVALID_PARAMS,
          parsed.error.message,
        );
        return;
      }
      try {
        const decision = await this.resolvePermission({
          toolName: parsed.data.toolName,
          input: parsed.data.input,
          requiredPermission: parsed.data.requiredPermission,
          currentMode: parsed.data.currentMode,
          ...(parsed.data.agentId !== undefined && { agentId: parsed.data.agentId }),
        });
        transport.respond(frame.id, {
          outcome: decision.outcome,
          ...(decision.reason !== undefined && { reason: decision.reason }),
        });
      } catch (err) {
        transport.respondError(
          frame.id,
          IPC_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
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
