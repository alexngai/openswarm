/**
 * team-daemon.ts — TeamDaemon class.
 *
 * v0.5 stage 5E.2: lifecycle scaffold for the per-team daemon (V0.5.Q1).
 * Owns the Unix socket bind, pid file, signal handlers, and stale-socket
 * cleanup. RPC method handlers other than `status` are stubbed with
 * UNKNOWN_METHOD until 5E.4. The events.jsonl writer lands in 5E.5.
 *
 * The daemon is per-team — each `swarm-harness team start --detach` forks one
 * of these processes per team name. Multi-team-in-one-process (and a host
 * daemon) are deferred per docs/28 §V0.5.Q1.
 */

import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Writable } from "node:stream";
import type { TeamSpec, MemberSpec } from "./team-spec.js";
import type { TeamResult } from "./topologies-types.js";
import type { LaneEvent } from "./events.js";
import type { TeamSession } from "./team-session.js";
import { Orchestrator } from "./orchestrator.js";
import { StandaloneHost } from "./standalone-host.js";
import { buildMetadataEvent, isRecordedLaneEvent } from "./wire-protocol.js";
import {
  SendPromptParamsSchema,
  TEAM_DAEMON_ERROR_CODES,
  type TeamDaemonRequest,
  type TeamDaemonResponse,
} from "./team-daemon-protocol.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * On-disk paths owned by one daemon instance. Per V0.5.Q3, production callers
 * generate these under `${XDG_RUNTIME_DIR}/swarm-harness/teams/<name>/`.
 */
export interface TeamDaemonPaths {
  readonly sockPath: string;
  readonly pidPath: string;
  readonly eventsPath: string;
  readonly statePath: string;
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

    // 7. Build orchestrator if not injected.
    this.orchestrator = this.opts.orchestrator ?? this.buildOrchestrator();

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

    // 9. Kick off runTeam in the background.
    this.runTeamPromise = this.orchestrator.runTeam(this.opts.spec);
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
   * Graceful stop — close socket, drop in-flight connections, remove pid +
   * sock files, detach signal handlers. Idempotent. The orchestrator's
   * in-flight workers continue in the background; 5E.4 will wire actual
   * worker drain via the 4D drain frame.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

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

  private buildOrchestrator(): TeamDaemonOrchestrator {
    // Default production orchestrator. Writes results to a stream sink at
    // statePath (5E.5 will refine this — for now we just need a Writable).
    const resultsOut = fs.createWriteStream(this.opts.paths.statePath, {
      flags: "a",
    });
    // v0.5 stage 5E.5 — construct the host explicitly so the daemon can
    // subscribe to its lane-event bus. Orchestrator.opts.host accepts a
    // pre-built host; without it Orchestrator would build a private one we
    // couldn't subscribe to.
    const host = new StandaloneHost({ permissionMode: "workspace-write" });
    // v0.6 stage 5F — persistent: true so the topology skips dispose() and
    // the daemon can route send_prompt RPCs through the live TeamSession.
    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      eventsOut: this.opts.eventsOut ?? process.stderr,
      host,
      persistent: true,
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
      this.sendOk(socket, req.id, {
        teamName: this.opts.spec.name,
        scope: `swarm:${this.opts.spec.name}`,
        topology: this.opts.spec.topology,
        startedAt: this.startedAt,
        // Members are populated when 5E.5 wires the orchestrator's TeamSession
        // surface to the daemon. For 5E.4 the snapshot reports an empty list.
        members: [],
      });
      return;
    }

    if (req.method === "stop") {
      // V0.5 stage 5E.4: graceful stop. Reply ack first, then tear down so
      // the caller sees the response before the socket goes away. The
      // runTeam promise continues in the background; the daemon exits when
      // the orchestrator finishes or process.exit is called by the entry.
      this.sendOk(socket, req.id, { acknowledged: true });
      // Defer stop() to next tick so the response flushes.
      setImmediate(() => {
        void this.stop().catch(() => {
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
        void this.stop()
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
