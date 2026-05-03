/**
 * Orchestrator — topology-pluggable shell.
 *
 * v0.4 Stage 4C refactor: today's fanout coordination logic moved into
 * `FanoutTopology` (src/swarm/topologies/fanout.ts). Orchestrator now owns
 * shared infrastructure (StandaloneHost, WorkerPool, DeadLetterWriter, SIGINT
 * handler) and dispatches each run to a topology implementation.
 *
 * Backward compat: `run(tasks: TaskPacket[])` synthesizes a fanout TeamSpec
 * internally so existing CLI wiring (`swarm run tasks.jsonl`) and the
 * orchestrator unit tests work unchanged. New code uses `runTeam(spec)`.
 *
 * Signal handling (M1):
 *   - First SIGINT: closes the pool (no new acquires), in-flight tasks
 *     continue until their subprocess exits naturally or is killed by
 *     handle.kill(). The spawner uses detached:false so children are
 *     reaped when the orchestrator exits.
 *   - Second SIGINT: force-exits with code 130.
 */

import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { PermissionMode, Usage } from "../core/types.js";
import type { TaskPacket, AgentResult } from "./host.js";
import { StandaloneHost } from "./standalone-host.js";
import { WorkerPool } from "./worker-pool.js";
import { DeadLetterWriter } from "./dead-letter.js";
import type { RoleRegistry } from "./roles.js";
import type {
  TeamSpec,
  TopologyKind,
  MemberSpec,
} from "./team-spec.js";
import type {
  Topology,
  TopologyContext,
  TeamResult,
} from "./topologies-types.js";
import { FanoutTopology } from "./topologies/index.js";

// Re-export AgentResult/Usage so legacy import sites keep working without
// chasing module paths.
export type { AgentResult, Usage };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  readonly concurrency: number;
  readonly permissionMode: PermissionMode;
  readonly resultsOut: Writable;
  readonly eventsOut?: Writable;
  /** Inject a pre-built host for testing. */
  readonly host?: StandaloneHost;
  /** Path for dead-letter JSONL file. Default: ./dead-letter.jsonl */
  readonly deadLetterPath?: string;
  /**
   * When true, a non-empty dead-letter delta does NOT cause the run to exit
   * non-zero. Default: false.
   */
  readonly allowDeadLetter?: boolean;
  /**
   * Role registry used to resolve `task.role` / `defaultRole` names to
   * full Role objects at dispatch (M3a Phase 6). Omit to run without
   * role wiring; tasks with a `role` field then fail with "unknown role".
   */
  readonly roles?: RoleRegistry;
  /**
   * Role name applied to every task that doesn't set its own `role`
   * field. Resolved against `roles` at dispatch.
   */
  readonly defaultRole?: string;
}

/**
 * RunResult — outcome of a swarm run. Aliases TeamResult so legacy callers
 * that import RunResult keep working unchanged.
 */
export type RunResult = TeamResult;

export interface ResultLine {
  readonly id: string;
  readonly status: "succeeded" | "failed" | "timeout" | "cancelled";
  readonly output?: string;
  readonly error?: string;
  readonly usage?: import("../core/types.js").Usage;
  readonly wallClockMs: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly completedAt: number;
  /** Present when a task was cancelled via task_stop; identifies who stopped it. */
  readonly stoppedBy?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator extends EventEmitter {
  private readonly host: StandaloneHost;
  private readonly pool: WorkerPool;
  private readonly deadLetter: DeadLetterWriter;
  private shuttingDown = false;
  private sigintHandler?: () => void;

  constructor(private readonly opts: OrchestratorOptions) {
    super();
    this.host = opts.host ?? new StandaloneHost({ permissionMode: opts.permissionMode });
    this.pool = new WorkerPool(opts.concurrency);
    this.deadLetter = new DeadLetterWriter(opts.deadLetterPath ?? "./dead-letter.jsonl");
    // Prevent resultsOut stream errors from becoming uncaught exceptions.
    // Write errors are surfaced via the writeResult() promise rejection instead.
    opts.resultsOut.on("error", () => {
      // Handled in topology writeResult(); swallow here to avoid double-reporting.
    });
  }

  /**
   * LEGACY: runs today's fanout via TaskPacket[] input. Synthesizes a TeamSpec
   * internally and delegates to `runTeam()`. Returns RunResult (= TeamResult)
   * for compatibility with existing callers.
   */
  async run(tasks: readonly TaskPacket[]): Promise<RunResult> {
    const members: MemberSpec[] = tasks.map((t) => ({
      id: t.id,
      // Empty role string preserves legacy "no role" semantics; the topology
      // treats empty strings as undefined when reconstructing TaskPacket.
      role: t.role ?? "",
      prompt: t.prompt,
      ...(t.budget !== undefined && { budget: t.budget }),
      branchPolicy: t.branchPolicy,
      commitPolicy: t.commitPolicy,
      escalationPolicy: t.escalationPolicy,
    }));
    const spec: TeamSpec = {
      name: "swarm-run",
      topology: "fanout",
      members,
      coordination: { completion: { kind: "all" } },
    };
    return await this.runTeam(spec);
  }

  /**
   * v0.4 entry point: run a TeamSpec through its declared topology.
   * Stage 4C only supports `topology: "fanout"`; others land in 4E.
   */
  async runTeam(spec: TeamSpec): Promise<TeamResult> {
    // Install SIGINT handler for graceful shutdown. The handler aborts the
    // shared AbortSignal so every topology's per-task loops can short-circuit
    // pending work, then closes the pool so queued acquires reject.
    const abortController = new AbortController();
    this.sigintHandler = () => {
      if (this.shuttingDown) {
        // Second Ctrl-C — force exit.
        process.stderr.write("[swarm-harness] second SIGINT — forcing exit\n");
        process.exit(130);
      }
      this.shuttingDown = true;
      process.stderr.write(
        "[swarm-harness] SIGINT received; draining workers...\n",
      );
      abortController.abort();
      this.pool.close();
    };
    process.once("SIGINT", this.sigintHandler);

    try {
      const topology = pickTopology(spec.topology);
      const ctx: TopologyContext = {
        host: this.host,
        pool: this.pool,
        resultsOut: this.opts.resultsOut,
        deadLetter: this.deadLetter,
        permissionMode: this.opts.permissionMode,
        abort: abortController.signal,
        ...(this.opts.eventsOut !== undefined && { eventsOut: this.opts.eventsOut }),
        ...(this.opts.roles !== undefined && { roles: this.opts.roles }),
        ...(this.opts.allowDeadLetter !== undefined && {
          allowDeadLetter: this.opts.allowDeadLetter,
        }),
        ...(this.opts.defaultRole !== undefined && {
          defaultRole: this.opts.defaultRole,
        }),
      };
      return await topology.run(spec, ctx);
    } finally {
      // Clean up SIGINT handler.
      if (this.sigintHandler) {
        process.removeListener("SIGINT", this.sigintHandler);
        this.sigintHandler = undefined;
      }
      await this.deadLetter.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Topology dispatch
// ---------------------------------------------------------------------------

function pickTopology(kind: TopologyKind): Topology {
  switch (kind) {
    case "fanout":
      return new FanoutTopology();
    // Stage 4E adds the rest. Until then, throw a clear error so misuse
    // surfaces immediately at runTeam() time.
    case "pipeline":
    case "coordinator":
    case "peer-team":
    case "committee":
    case "critic-loop":
      throw new Error(
        `topology "${kind}" not supported in v0.4 stage 4C; lands in 4E`,
      );
  }
}
