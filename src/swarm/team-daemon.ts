/**
 * team-daemon.ts — TeamDaemon class.
 *
 * Per-team daemon (V0.5.Q1). Owns the Unix socket bind, pid file, signal
 * handlers, and stale-socket cleanup. Implemented RPCs: `status`, `stop`,
 * `kill`, `send_prompt` (see team-daemon-protocol.ts); events stream to a
 * per-team events.jsonl. `status` does not yet report per-member state.
 *
 * The daemon is per-team — each `openswarm team start --detach` forks one
 * of these processes per team name. Multi-team-in-one-process (and a host
 * daemon) are deferred per docs/28 §V0.5.Q1.
 */

import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Writable } from "node:stream";
import type { PermissionMode } from "../core/types.js";
import type { TeamSpec, MemberSpec } from "./team-spec.js";
import type { TeamResult } from "./topologies-types.js";
import type { LaneEvent } from "./events.js";
import type { TeamSession } from "./team-session.js";
import { Orchestrator } from "./orchestrator.js";
import { StandaloneHost } from "./standalone-host.js";
import { RoleRegistry, BUILTIN_ROLES, loadCustomRoles } from "./roles.js";
import {
  openTeamCheckpoint,
  type TeamCheckpointStore,
} from "./team-checkpoint.js";
import { buildMetadataEvent, isRecordedLaneEvent } from "./wire-protocol.js";
import { SwarmUsageAggregator } from "./usage-aggregator.js";
import { defaultCostModel } from "../core/cost-model.js";
import {
  SendPromptParamsSchema,
  StopParamsSchema,
  TEAM_DAEMON_ERROR_CODES,
  type TeamDaemonRequest,
  type TeamDaemonResponse,
} from "./team-daemon-protocol.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default graceful-drain budget for `stop` before force-killing workers. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * On-disk paths owned by one daemon instance. Per V0.5.Q3, production callers
 * generate these under `${XDG_RUNTIME_DIR}/openswarm/teams/<name>/`.
 */
export interface TeamDaemonPaths {
  readonly sockPath: string;
  readonly pidPath: string;
  readonly eventsPath: string;
  readonly statePath: string;
  /** Durable per-team progress checkpoint for crash-recovery (docs/28 T1). */
  readonly checkpointPath: string;
}

/**
 * Slimmed-down orchestrator surface the daemon depends on. Production wraps
 * a real Orchestrator; tests inject a stub that resolves runTeam without
 * spawning subprocess workers.
 */
export interface TeamDaemonOrchestrator {
  runTeam(spec: TeamSpec): Promise<TeamResult>;
  /**
   * v0.5 stage 5E.5: optional lane-event subscription. When present the
   * daemon attaches a handler that writes each event as a JSONL line to
   * events.jsonl. Returns an unsubscribe function called at daemon stop.
   */
  subscribeEvents?(handler: (event: LaneEvent) => void): () => void;
  /**
   * v0.6 stage 5F: when present, returns the live TeamSession so the
   * daemon's send_prompt handler can spawn ad-hoc members into the
   * running team. Returns undefined when no team is active (yet, or for
   * topologies that don't honor `persistent: true`).
   */
  getActiveTeam?(): TeamSession | undefined;
}

export interface TeamDaemonOptions {
  readonly spec: TeamSpec;
  readonly paths: TeamDaemonPaths;
  /** For tests: inject a custom orchestrator. Production uses the default. */
  readonly orchestrator?: TeamDaemonOrchestrator;
  /**
   * For tests + stage 5E.5: override the events.jsonl writer. v0.5 stage 5E.2
   * leaves this null — the writer is wired in 5E.5 once the orchestrator's
   * lane-event subscription surface is finalised.
   */
  readonly eventsOut?: Writable;
  /**
   * For tests: override the kill-handler's terminal `process.exit(0)`. The
   * production daemon needs to hard-exit so the OS reaps in-flight workers
   * (V0.5.Q5a); tests inject a no-op so the kill RPC behaviour can be
   * verified without taking down the test runner.
   */
  readonly processExit?: (code: number) => void;
  /**
   * Effective permission mode for the daemon's orchestrator/host (Phase 4.1c).
   * Threaded from `team start` via OPENSWARM_DAEMON_PERMISSION_MODE. Defaults
   * to "workspace-write" when omitted (the historical hardcoded value).
   */
  readonly permissionMode?: PermissionMode;
  /**
   * Orchestrator worker concurrency (Phase 4.1c). Threaded from `team start`
   * via OPENSWARM_DAEMON_CONCURRENCY. Defaults to 1 when omitted.
   */
  readonly concurrency?: number;
  /**
   * For tests + startup notices: sink for the human-readable startup line
   * (effective config + degradation warnings). Defaults to process.stdout,
   * which the detached forker captures into daemon.log.
   */
  readonly startupOut?: Writable;
}

// ---------------------------------------------------------------------------
// TeamDaemon
// ---------------------------------------------------------------------------

export class TeamDaemon {
  private readonly opts: TeamDaemonOptions;
  private server: Server | undefined;
  private orchestrator: TeamDaemonOrchestrator | undefined;
  private startedAt = 0;
  private connections = new Set<Socket>();
  private signalCleanup: (() => void) | undefined;
  private runTeamPromise: Promise<TeamResult> | undefined;
  private stopped = false;
  private eventsStream: fs.WriteStream | undefined;
  private eventsUnsubscribe: (() => void) | undefined;
  private checkpointStore: TeamCheckpointStore | undefined;
  /**
   * GitHub #17: rolls up per-member + team-wide token/cost usage from the lane
   * stream so the `status` RPC can report aggregate usage across the spawn
   * tree. Fed from the same subscribeEvents handler that writes events.jsonl.
   */
  // CostModel from the env (OPENSWARM_USD_PER_GPU_HOUR → self-host GPU accounting;
  // else $-table + FLOPs). docs/50 §4.2 dual-axis.
  private readonly usage = new SwarmUsageAggregator(defaultCostModel());

  constructor(opts: TeamDaemonOptions) {
    this.opts = opts;
  }

  /**
   * Bind socket, write pid file, install signal handlers, kick off the team
   * run. Resolves when start-up is complete; the team continues to run in the
   * background until awaitTeamCompletion() resolves or stop() is called.
   */
  async start(): Promise<void> {
    if (this.server !== undefined) {
      throw new Error("TeamDaemon: already started");
    }
    this.startedAt = Date.now();

    // 1. Stale-socket cleanup (V0.5.Q5b). Throws TEAM_ALREADY_RUNNING if a
    //    live daemon owns the socket (V0.5.Q7).
    await this.removeStaleSocketOrThrow();

    // 2. Ensure paths' parent dir exists.
    await fsp.mkdir(path.dirname(this.opts.paths.sockPath), { recursive: true });

    // 3. Bind socket.
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      this.server!.once("error", onErr);
      this.server!.listen(this.opts.paths.sockPath, () => {
        this.server!.off("error", onErr);
        resolve();
      });
    });

    // 4. Write pid file (V0.5.Q5b uses this to detect liveness).
    await fsp.writeFile(this.opts.paths.pidPath, String(process.pid));

    // 5. Write team-state.json snapshot.
    await this.writeState();

    // 6. Install signal handlers (V0.5.Q5a / SIGTERM = graceful drain).
    const onSig = (): void => {
      void this.stop().catch(() => {
        /* swallow — daemon is exiting anyway */
      });
    };
    process.on("SIGTERM", onSig);
    process.on("SIGINT", onSig);
    this.signalCleanup = (): void => {
      process.off("SIGTERM", onSig);
      process.off("SIGINT", onSig);
    };

    // 7. Build orchestrator if not injected. For the default (production)
    //    orchestrator, open the durable checkpoint first so a restart resumes
    //    mid-topology (docs/28 crash-recovery T1). Injected orchestrators
    //    (tests) manage their own recovery, if any.
    if (this.opts.orchestrator !== undefined) {
      this.orchestrator = this.opts.orchestrator;
    } else {
      this.checkpointStore = await openTeamCheckpoint({
        checkpointPath: this.opts.paths.checkpointPath,
        spec: this.opts.spec,
      });
      // Resolve member roles the same way the foreground `swarm`/`team` paths
      // do (built-ins + custom from `.openswarm/roles.json`). Without this the
      // orchestrator has no registry and every role-bearing member fails with
      // "unknown role" — so a detached/resumed team could never run.
      const roles = new RoleRegistry();
      for (const r of BUILTIN_ROLES) roles.register(r);
      const custom = await loadCustomRoles(
        path.join(process.cwd(), ".openswarm", "roles.json"),
      );
      for (const r of custom) roles.register(r);
      this.orchestrator = this.buildOrchestrator(this.checkpointStore, roles);
    }

    // 8. v0.5 stage 5E.5 — open events.jsonl writer + subscribe lane events.
    if (this.orchestrator.subscribeEvents !== undefined) {
      // Detect first-open so we can stamp a wire-protocol metadata header
      // exactly once. On restart we append to the existing file and skip
      // the header so readers see one metadata line per wire.
      let needsHeader = false;
      try {
        const st = await fsp.stat(this.opts.paths.eventsPath);
        needsHeader = st.size === 0;
      } catch {
        needsHeader = true;
      }
      this.eventsStream = fs.createWriteStream(this.opts.paths.eventsPath, {
        flags: "a",
      });
      const stream = this.eventsStream;
      if (needsHeader) {
        try {
          stream.write(JSON.stringify(buildMetadataEvent("team-daemon")) + "\n");
        } catch {
          /* writer broken — drop the header silently */
        }
      }
      this.eventsUnsubscribe = this.orchestrator.subscribeEvents((event) => {
        // GitHub #17: accrue usage from EVERY event (before the recorded
        // filter below) so `message_stop` samples and `worker_spawned` spawn
        // edges both reach the aggregator regardless of disk-recording policy.
        this.usage.record(event);
        // {ts, ...laneEvent} shape per docs/28 §V0.5.Q4. LaneEvent already
        // carries its own ts; we keep it (rather than overwriting) so the
        // emit-time clock is preserved.
        //
        // Live-only events (text_delta / tool_use_input / heartbeat /
        // worker_lifecycle_changed) are high-frequency deltas that
        // don't earn their disk footprint — they still reach in-process
        // subscribers, but the JSONL wire stays lean. See wire-protocol.ts.
        if (!isRecordedLaneEvent(event)) return;
        try {
          stream.write(JSON.stringify(event) + "\n");
        } catch {
          /* writer broken — drop the event silently */
        }
      });
    }

    // 8.5 Phase 4.1c — surface effective config + any degradation up front,
    //     so an operator inspecting daemon.log sees it at start rather than
    //     only as a mid-run team_note.
    this.emitStartupNotice();

    // 9. Kick off runTeam in the background.
    this.runTeamPromise = this.orchestrator.runTeam(this.opts.spec);
  }

  /**
   * Write a one-time startup summary (effective permissionMode + concurrency)
   * plus a degradation warning when the team selects the `spawn-resolver`
   * conflict strategy under a permission mode below danger-full-access — the
   * resolver can't commit or call resolve_conflict there and will escalate
   * instead of resolving (mirrors the peer-team.ts mid-run team_note).
   */
  private emitStartupNotice(): void {
    const out = this.opts.startupOut ?? process.stdout;
    const permissionMode = this.opts.permissionMode ?? "workspace-write";
    const concurrency = this.opts.concurrency ?? 1;
    const lines: string[] = [
      `[openswarm] team "${this.opts.spec.name}" daemon ready — ` +
        `topology=${this.opts.spec.topology} permissionMode=${permissionMode} concurrency=${concurrency}`,
    ];

    const defaultStrategy =
      this.opts.spec.coordination.conflictRecovery?.defaultStrategy;
    const wantsSpawnResolver =
      defaultStrategy === "spawn-resolver" ||
      this.opts.spec.members.some((m) => m.onConflict === "spawn-resolver");
    if (wantsSpawnResolver && permissionMode !== "danger-full-access") {
      lines.push(
        `[openswarm] warning: spawn-resolver conflict recovery is selected but ` +
          `permissionMode="${permissionMode}" is below danger-full-access — the ` +
          `resolver cannot commit or call resolve_conflict and will escalate ` +
          `instead of resolving.`,
      );
    }

    try {
      out.write(lines.join("\n") + "\n");
    } catch {
      /* startup sink broken — non-fatal */
    }
  }

  /**
   * Wait for the orchestrator's runTeam promise to resolve. Useful for the
   * CLI entry which exits after the team finishes.
   */
  async awaitTeamCompletion(): Promise<TeamResult> {
    if (this.runTeamPromise === undefined) {
      throw new Error("TeamDaemon: not started");
    }
    return this.runTeamPromise;
  }

  /**
   * Graceful stop — drain in-flight workers, close socket, drop in-flight
   * connections, remove pid + sock files, detach signal handlers. Idempotent.
   *
   * Phase 4.1b: before releasing the socket we drain the active team's
   * workers — long-lived members get a cooperative `drain()`, one-shot
   * members are awaited to completion — bounded by `drainTimeoutMs` (default
   * DEFAULT_DRAIN_TIMEOUT_MS). Whatever remains after the deadline is
   * force-killed. `drainTimeoutMs: 0` skips the cooperative drain entirely
   * (the `kill` RPC path, which relies on process exit reaping subprocesses).
   */
  async stop(opts?: { drainTimeoutMs?: number }): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const drainTimeoutMs = opts?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (drainTimeoutMs > 0) {
      await this.drainWorkers(drainTimeoutMs);
    }

    if (this.server !== undefined) {
      // Drop existing connections so close() can resolve.
      for (const conn of this.connections) conn.destroy();
      this.connections.clear();
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    // v0.5 stage 5E.5 — detach event subscription + close events.jsonl writer.
    if (this.eventsUnsubscribe !== undefined) {
      this.eventsUnsubscribe();
      this.eventsUnsubscribe = undefined;
    }
    if (this.eventsStream !== undefined) {
      const stream = this.eventsStream;
      await new Promise<void>((resolve) => stream.end(() => resolve()));
      this.eventsStream = undefined;
    }

    // Flush any pending checkpoint writes before we release the socket/pid so
    // an immediate restart sees a consistent progress record.
    if (this.checkpointStore !== undefined) {
      await this.checkpointStore.close().catch(() => {});
      this.checkpointStore = undefined;
    }

    await this.unlinkIfExists(this.opts.paths.sockPath);
    await this.unlinkIfExists(this.opts.paths.pidPath);

    if (this.signalCleanup !== undefined) {
      this.signalCleanup();
      this.signalCleanup = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Phase 4.1b — drain the active team's non-terminal workers within a budget.
   * Long-lived members get a cooperative `drain()`; one-shot members (whose
   * `drain()` rejects) are awaited to their current task's completion. Any
   * worker still live after `timeoutMs` is force-killed so teardown can
   * proceed. No-op when there is no live TeamSession (test orchestrators or
   * dispose-after-run topologies).
   */
  private async drainWorkers(timeoutMs: number): Promise<void> {
    const team = this.orchestrator?.getActiveTeam?.();
    if (team === undefined) return;
    const members = [...team.members.values()].filter(
      (m) => m.state !== "finished" && m.state !== "failed",
    );
    if (members.length === 0) return;

    const drainOne = async (handle: {
      drain: () => Promise<void>;
      wait: () => Promise<unknown>;
    }): Promise<void> => {
      try {
        await handle.drain();
      } catch {
        // Not a long-lived worker — await its in-flight task instead.
        await handle.wait().catch(() => {});
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const drained = Promise.allSettled(
      members.map((m) => drainOne(m.handle)),
    ).then(() => "drained" as const);

    const outcome = await Promise.race([drained, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === "timeout") {
      // Deadline hit — force-kill whatever is still live.
      await Promise.allSettled(members.map((m) => m.handle.kill()));
    }
  }

  private buildOrchestrator(
    checkpoint?: TeamCheckpointStore,
    roles?: RoleRegistry,
  ): TeamDaemonOrchestrator {
    // Default production orchestrator. Writes results to a stream sink at
    // statePath (5E.5 will refine this — for now we just need a Writable).
    const resultsOut = fs.createWriteStream(this.opts.paths.statePath, {
      flags: "a",
    });
    // v0.5 stage 5E.5 — construct the host explicitly so the daemon can
    // subscribe to its lane-event bus. Orchestrator.opts.host accepts a
    // pre-built host; without it Orchestrator would build a private one we
    // couldn't subscribe to.
    const permissionMode = this.opts.permissionMode ?? "workspace-write";
    const concurrency = this.opts.concurrency ?? 1;
    const host = new StandaloneHost({ permissionMode });
    // v0.6 stage 5F — persistent: true so the topology skips dispose() and
    // the daemon can route send_prompt RPCs through the live TeamSession.
    const orch = new Orchestrator({
      concurrency,
      permissionMode,
      resultsOut,
      eventsOut: this.opts.eventsOut ?? process.stderr,
      host,
      persistent: true,
      ...(checkpoint !== undefined && { checkpoint }),
      ...(roles !== undefined && { roles }),
    });
    // The host has a private `events` EventEmitter (same duck-typed access
    // pattern used by the host→MAP bridge in src/host/map-bridge.ts).
    const bus = (host as unknown as { readonly events: EventEmitter }).events;
    return {
      runTeam: (spec) => orch.runTeam(spec),
      subscribeEvents: (handler) => {
        bus.on("lane_event", handler);
        return () => bus.off("lane_event", handler);
      },
      getActiveTeam: () => orch.getActiveTeam(),
    };
  }

  private async writeState(): Promise<void> {
    const snapshot = {
      teamName: this.opts.spec.name,
      scope: `swarm:${this.opts.spec.name}`,
      topology: this.opts.spec.topology,
      pid: process.pid,
      startedAt: this.startedAt,
    };
    await fsp.writeFile(
      this.opts.paths.statePath,
      JSON.stringify(snapshot) + "\n",
    );
  }

  private async removeStaleSocketOrThrow(): Promise<void> {
    const sockExists = await this.exists(this.opts.paths.sockPath);
    if (!sockExists) return;

    // If a pid file is present and that pid is alive, refuse to start
    // (V0.5.Q7 — duplicate team start).
    const pidExists = await this.exists(this.opts.paths.pidPath);
    if (pidExists) {
      const pidStr = await fsp.readFile(this.opts.paths.pidPath, "utf8");
      const pid = Number.parseInt(pidStr.trim(), 10);
      if (Number.isFinite(pid) && this.isProcessAlive(pid)) {
        const err = new Error(
          `team "${this.opts.spec.name}" already running (pid ${pid})`,
        );
        (err as Error & { code?: string }).code =
          TEAM_DAEMON_ERROR_CODES.TEAM_ALREADY_RUNNING;
        throw err;
      }
    }

    // Stale — clean up (V0.5.Q5b).
    await this.unlinkIfExists(this.opts.paths.sockPath);
    await this.unlinkIfExists(this.opts.paths.pidPath);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async exists(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async unlinkIfExists(p: string): Promise<void> {
    try {
      await fsp.unlink(p);
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Connection / RPC handling
  // -------------------------------------------------------------------------

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.on("error", () => {
      /* drop connection-level errors — they're not daemon failures */
    });

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length === 0) continue;
        this.handleFrame(socket, line);
      }
    });
  }

  private handleFrame(socket: Socket, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendErr(
        socket,
        "0",
        TEAM_DAEMON_ERROR_CODES.MALFORMED_FRAME,
        "invalid json",
      );
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { kind?: string }).kind !== "request"
    ) {
      this.sendErr(
        socket,
        "0",
        TEAM_DAEMON_ERROR_CODES.MALFORMED_FRAME,
        "expected a request frame",
      );
      return;
    }
    const req = parsed as TeamDaemonRequest;

    if (req.method === "status") {
      // Read live member states off the active TeamSession (Phase 4.1a).
      // Topologies that dispose after their run (or test orchestrators that
      // don't expose getActiveTeam) report an empty list.
      const team = this.orchestrator?.getActiveTeam?.();
      // GitHub #17: attach each member's SUBTREE usage (itself + everything it
      // spawned) plus a team-wide roll-up, so operators see aggregate token/
      // cost across the full spawn tree — resolving the "blank cost side"
      // gap flagged in docs/47. Usage is 0 until the first `message_stop`.
      const members =
        team === undefined
          ? []
          : [...team.members.values()].map((m) => ({
              memberId: m.memberId,
              role: m.role,
              agentId: m.agentId,
              state: m.state,
              usage: this.usage.subtreeUsage(m.agentId),
            }));
      this.sendOk(socket, req.id, {
        teamName: this.opts.spec.name,
        scope: `swarm:${this.opts.spec.name}`,
        topology: this.opts.spec.topology,
        startedAt: this.startedAt,
        members,
        teamUsage: this.usage.teamTotal(),
      });
      return;
    }

    if (req.method === "stop") {
      // V0.5 stage 5E.4: graceful stop. Reply ack first, then tear down so
      // the caller sees the response before the socket goes away. The
      // runTeam promise continues in the background; the daemon exits when
      // the orchestrator finishes or process.exit is called by the entry.
      // Phase 4.1b: honour an optional drain budget from StopParams.
      const parsedStop = StopParamsSchema.safeParse(req.params);
      const drainTimeoutMs = parsedStop.success
        ? parsedStop.data.timeoutMs
        : undefined;
      this.sendOk(socket, req.id, { acknowledged: true });
      // Defer stop() to next tick so the response flushes.
      setImmediate(() => {
        void this.stop(
          drainTimeoutMs !== undefined ? { drainTimeoutMs } : undefined,
        ).catch(() => {
          /* swallow — daemon is exiting anyway */
        });
      });
      return;
    }

    if (req.method === "kill") {
      // V0.5 stage 5E.4: hard kill. Same response shape as stop, but the
      // daemon process exits immediately so OS reaps in-flight workers.
      this.sendOk(socket, req.id, { acknowledged: true });
      setImmediate(() => {
        // Hard kill — skip the cooperative drain (drainTimeoutMs: 0); the
        // process exit below reaps in-flight worker subprocesses via stdin EOF.
        void this.stop({ drainTimeoutMs: 0 })
          .catch(() => {
            /* swallow */
          })
          .then(() => {
            // Hard exit — workers' stdin EOF will reap them per V0.5.Q5a.
            const exitFn = this.opts.processExit ?? process.exit.bind(process);
            exitFn(0);
          });
      });
      return;
    }

    if (req.method === "send_prompt") {
      // v0.6 stage 5F: route the prompt through the live TeamSession by
      // spawning an ad-hoc member with the prompt as its task. The new
      // member inherits role + policies from the spec's first member so
      // operators don't need to re-specify them per send.
      void this.handleSendPrompt(socket, req).catch((err) => {
        this.sendErr(
          socket,
          req.id,
          TEAM_DAEMON_ERROR_CODES.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      });
      return;
    }

    // Any other method is unknown.
    this.sendErr(
      socket,
      req.id,
      TEAM_DAEMON_ERROR_CODES.UNKNOWN_METHOD,
      `unknown method: ${req.method}`,
    );
  }

  /**
   * v0.6 stage 5F: spawn an ad-hoc member into the live TeamSession with
   * the caller-supplied prompt. Inherits role + policies from the spec's
   * first member so operators don't need to re-specify them every send.
   *
   * Returns SendPromptResult { delivered, recipients } per docs/28 §V0.5.Q6.
   * Errors map to UNKNOWN_METHOD when the topology doesn't expose a live
   * team, INTERNAL_ERROR on actual spawn failure.
   */
  private async handleSendPrompt(
    socket: Socket,
    req: TeamDaemonRequest,
  ): Promise<void> {
    const parsed = SendPromptParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      this.sendErr(
        socket,
        req.id,
        TEAM_DAEMON_ERROR_CODES.INVALID_PARAMS,
        parsed.error.message,
      );
      return;
    }
    if (
      this.orchestrator === undefined ||
      this.orchestrator.getActiveTeam === undefined
    ) {
      this.sendErr(
        socket,
        req.id,
        TEAM_DAEMON_ERROR_CODES.UNKNOWN_METHOD,
        "send_prompt requires an orchestrator with getActiveTeam (only the " +
          "production daemon path supports this; tests inject custom orchestrators)",
      );
      return;
    }
    const team = this.orchestrator.getActiveTeam();
    if (team === undefined) {
      this.sendErr(
        socket,
        req.id,
        TEAM_DAEMON_ERROR_CODES.UNKNOWN_METHOD,
        "no live TeamSession — only PeerTeamTopology supports persistent " +
          "mode in v0.6 (other topologies dispose after their initial run)",
      );
      return;
    }

    // Inherit role + policies from the spec's first member; this matches the
    // operator's mental model of "send the team another task in the same
    // role they were already running".
    const template: MemberSpec | undefined = this.opts.spec.members[0];
    const adhocMember: MemberSpec = {
      role: template?.role ?? "",
      prompt: parsed.data.prompt,
      branchPolicy: template?.branchPolicy ?? { kind: "none" },
      commitPolicy: template?.commitPolicy ?? { kind: "none" },
      escalationPolicy: template?.escalationPolicy ?? { kind: "none" },
      // Inherit the engine selection so an ad-hoc send runs on the same
      // model/framework the team was configured with (Phase 2.2).
      ...(template?.model !== undefined && { model: template.model }),
      ...(template?.framework !== undefined && { framework: template.framework }),
    };

    const handle = await team.spawnMember(adhocMember);
    this.sendOk(socket, req.id, {
      delivered: 1,
      recipients: [handle.agentId],
    });
  }

  private sendOk(socket: Socket, id: string, result: unknown): void {
    const resp: TeamDaemonResponse = {
      kind: "response",
      id,
      ok: true,
      result,
    };
    socket.write(JSON.stringify(resp) + "\n");
  }

  private sendErr(
    socket: Socket,
    id: string,
    code: string,
    message: string,
  ): void {
    const resp: TeamDaemonResponse = {
      kind: "response",
      id,
      ok: false,
      error: { code, message },
    };
    socket.write(JSON.stringify(resp) + "\n");
  }
}
