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
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Writable } from "node:stream";
import type { TeamSpec } from "./team-spec.js";
import type { TeamResult } from "./topologies-types.js";
import { Orchestrator } from "./orchestrator.js";
import {
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

    // 7. Build orchestrator if not injected; kick off runTeam in background.
    this.orchestrator = this.opts.orchestrator ?? this.buildOrchestrator();
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
    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      eventsOut: this.opts.eventsOut ?? process.stderr,
    });
    return { runTeam: (spec) => orch.runTeam(spec) };
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
        // 5E.4 will populate from TeamSession; 5E.2 reports an empty list.
        members: [],
      });
      return;
    }

    // send_prompt / stop / kill — implemented in 5E.4.
    this.sendErr(
      socket,
      req.id,
      TEAM_DAEMON_ERROR_CODES.UNKNOWN_METHOD,
      `method not yet implemented in 5E.2: ${req.method} (lands in 5E.4)`,
    );
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
