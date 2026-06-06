/**
 * Persistent shell sessions (F11) with interactive stdin (F12),
 * state snapshots (F14), and lifecycle management (F15).
 *
 * Manages long-lived /bin/bash processes that survive across tool calls.
 * Each session is a PTY-like process with stdin/stdout/stderr pipes.
 * Sessions are identified by string IDs and evicted LRU when the max is hit.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { headTailTruncate, type HeadTailOptions } from "./internal.js";
import { getHardenedEnv } from "./process-hardening.js";
import { spawnSandboxedSync, type SandboxPolicy } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShellState {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shellOpts: string;
}

export interface ShellSession {
  readonly id: string;
  readonly pid: number;
  readonly cwd: string;
  readonly startedAt: number;
  readonly lastAccessedAt: number;
  readonly totalStdoutBytes: number;
  readonly totalStderrBytes: number;
  readonly lastCommand: string | null;
  readonly state: ShellState | null;
  exitCode: number | null;
  exited: boolean;
}

export interface SessionOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exited: boolean;
  readonly exitCode: number | null;
}

export interface ShellSessionManagerOptions {
  readonly maxSessions?: number;
  readonly headTail?: HeadTailOptions;
  readonly captureState?: boolean;
  readonly sandboxPolicy?: SandboxPolicy;
}

// ---------------------------------------------------------------------------
// Internal session state (not exported — callers use ShellSession snapshots)
// ---------------------------------------------------------------------------

interface LiveSession {
  id: string;
  process: ChildProcess;
  cwd: string;
  startedAt: number;
  lastAccessedAt: number;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  stdoutCursor: number;
  stderrCursor: number;
  totalStdoutBytes: number;
  totalStderrBytes: number;
  lastCommand: string | null;
  state: ShellState | null;
  exitCode: number | null;
  exited: boolean;
}

// ---------------------------------------------------------------------------
// ShellSessionManager
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SESSIONS = 64;

const STATE_PROBE_DELIMITER = "__SWARM_STATE_PROBE__";
const STATE_PROBE_CMD =
  `echo "${STATE_PROBE_DELIMITER}";` +
  `echo "CWD=$(pwd)";` +
  `echo "SHLVL=$SHLVL";` +
  `echo "PATH=$PATH";` +
  `echo "HOME=$HOME";` +
  `echo "USER=$USER";` +
  `echo "SHELL=$SHELL";` +
  `echo "OPTS=$(set +o 2>/dev/null | tr '\\n' ';')";` +
  `echo "${STATE_PROBE_DELIMITER}_END";\n`;

export class ShellSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly maxSessions: number;
  private readonly headTailOpts: HeadTailOptions;
  private readonly captureState: boolean;
  private readonly sandboxPolicy: SandboxPolicy;
  private nextId = 1;

  constructor(opts: ShellSessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.headTailOpts = opts.headTail ?? {};
    this.captureState = opts.captureState ?? true;
    this.sandboxPolicy = opts.sandboxPolicy ?? "prefer";
  }

  /**
   * Create a new persistent shell session. Optionally run an initial command.
   * Returns the session ID and PID.
   */
  create(cwd: string, initialCommand?: string): ShellSession {
    this.evictIfNeeded();

    const id = `sh_${this.nextId++}`;
    const env = { ...getHardenedEnv(), TERM: "dumb", PS1: "" };
    const child = spawnSandboxedSync(
      "/bin/bash",
      ["--norc", "--noprofile", "-i"],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
      { writableRoots: [], cwd, env, policy: this.sandboxPolicy },
    );

    const session: LiveSession = {
      id,
      process: child,
      cwd,
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      stdoutChunks: [],
      stderrChunks: [],
      stdoutCursor: 0,
      stderrCursor: 0,
      totalStdoutBytes: 0,
      totalStderrBytes: 0,
      lastCommand: initialCommand ?? null,
      state: null,
      exitCode: null,
      exited: false,
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      session.stdoutChunks.push(chunk);
      session.totalStdoutBytes += chunk.length;
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      session.stderrChunks.push(chunk);
      session.totalStderrBytes += chunk.length;
    });

    child.on("close", (code) => {
      session.exitCode = code;
      session.exited = true;
    });

    child.on("error", () => {
      session.exited = true;
    });

    this.sessions.set(id, session);

    if (initialCommand) {
      this.writeStdin(id, initialCommand + "\n");
    }

    return this.snapshot(session);
  }

  /**
   * Send input (keystrokes, commands, Ctrl-C) to a running session's stdin.
   * Returns true if the write succeeded, false if the session doesn't exist
   * or has exited.
   */
  writeStdin(sessionId: string, input: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;

    session.lastAccessedAt = Date.now();
    try {
      session.process.stdin!.write(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a signal to the session's process (e.g., SIGINT for Ctrl-C).
   */
  signal(sessionId: string, sig: NodeJS.Signals = "SIGINT"): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.exited) return false;

    session.lastAccessedAt = Date.now();
    try {
      session.process.kill(sig);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read new output since the last read. Uses cursor tracking so each read
   * returns only new data. Output is HeadTail-truncated per the configured
   * limits.
   */
  readOutput(sessionId: string): SessionOutput | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastAccessedAt = Date.now();

    const newStdout = this.drainSince(session.stdoutChunks, session.stdoutCursor);
    session.stdoutCursor = session.stdoutChunks.length;

    const newStderr = this.drainSince(session.stderrChunks, session.stderrCursor);
    session.stderrCursor = session.stderrChunks.length;

    const stdout = headTailTruncate(newStdout, this.headTailOpts);
    const stderr = headTailTruncate(newStderr, this.headTailOpts);

    return {
      stdout,
      stderr,
      exited: session.exited,
      exitCode: session.exitCode,
    };
  }

  /**
   * Inject the state probe command into a session. Called after the user's
   * command output has settled. The probe output will be captured on next
   * readOutput and parsed by extractState().
   */
  injectStateProbe(sessionId: string): boolean {
    if (!this.captureState) return false;
    return this.writeStdin(sessionId, STATE_PROBE_CMD);
  }

  /**
   * Parse state probe output from raw stdout. Returns the extracted state
   * and the stdout with probe output stripped. If no probe output is found,
   * returns null state and the original string.
   */
  extractState(stdout: string): { cleaned: string; state: ShellState | null } {
    const startIdx = stdout.indexOf(STATE_PROBE_DELIMITER);
    const endMarker = `${STATE_PROBE_DELIMITER}_END`;
    const endIdx = stdout.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1) {
      return { cleaned: stdout, state: null };
    }

    const probeBlock = stdout.slice(startIdx, endIdx + endMarker.length);
    const cleaned = (
      stdout.slice(0, startIdx) + stdout.slice(endIdx + endMarker.length)
    ).trim();

    const env: Record<string, string> = {};
    let cwd = "";
    let shellOpts = "";

    for (const line of probeBlock.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();

      switch (key) {
        case "CWD":
          cwd = val;
          break;
        case "OPTS":
          shellOpts = val;
          break;
        default:
          if (key && val) env[key] = val;
          break;
      }
    }

    return {
      cleaned,
      state: { cwd: cwd || "/", env, shellOpts },
    };
  }

  /**
   * Update the session's stored state snapshot.
   */
  updateState(sessionId: string, state: ShellState): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = state;
      if (state.cwd) session.cwd = state.cwd;
    }
  }

  /**
   * Update the last command for a session.
   */
  setLastCommand(sessionId: string, command: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastCommand = command;
  }

  /**
   * Read ALL buffered output (ignoring cursor — reads from the beginning).
   * Used for reattach: see everything the session has produced.
   */
  readAllOutput(sessionId: string): SessionOutput | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastAccessedAt = Date.now();

    const allStdout = Buffer.concat(session.stdoutChunks);
    const allStderr = Buffer.concat(session.stderrChunks);

    // Advance cursor past everything.
    session.stdoutCursor = session.stdoutChunks.length;
    session.stderrCursor = session.stderrChunks.length;

    const stdout = headTailTruncate(allStdout, this.headTailOpts);
    const stderr = headTailTruncate(allStderr, this.headTailOpts);

    return {
      stdout,
      stderr,
      exited: session.exited,
      exitCode: session.exitCode,
    };
  }

  /**
   * Get a snapshot of a session's metadata.
   */
  get(sessionId: string): ShellSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.lastAccessedAt = Date.now();
    return this.snapshot(session);
  }

  /**
   * List all active sessions.
   */
  list(): ShellSession[] {
    return Array.from(this.sessions.values()).map((s) => this.snapshot(s));
  }

  /**
   * Kill and remove a session.
   */
  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (!session.exited) {
      try {
        session.process.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Close all sessions. Used during cleanup.
   */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private evictIfNeeded(): void {
    while (this.sessions.size >= this.maxSessions) {
      let oldest: LiveSession | null = null;
      for (const s of this.sessions.values()) {
        if (!oldest || s.lastAccessedAt < oldest.lastAccessedAt) {
          oldest = s;
        }
      }
      if (oldest) {
        this.close(oldest.id);
      } else {
        break;
      }
    }
  }

  private drainSince(chunks: Buffer[], cursor: number): Buffer {
    if (cursor >= chunks.length) return Buffer.alloc(0);
    return Buffer.concat(chunks.slice(cursor));
  }

  private snapshot(s: LiveSession): ShellSession {
    return {
      id: s.id,
      pid: s.process.pid!,
      cwd: s.cwd,
      startedAt: s.startedAt,
      lastAccessedAt: s.lastAccessedAt,
      totalStdoutBytes: s.totalStdoutBytes,
      totalStderrBytes: s.totalStderrBytes,
      lastCommand: s.lastCommand,
      state: s.state,
      exitCode: s.exitCode,
      exited: s.exited,
    };
  }
}
