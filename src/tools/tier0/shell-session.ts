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
import { BoundedOutput } from "./bounded-output.js";
import { getHardenedEnv } from "./process-hardening.js";
import type { SandboxPolicy } from "./sandbox.js";
import { killProcessTree } from "../../process/tree.js";
import { getProcessBroker, type ProcessBroker } from "../../process/broker.js";

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
  /**
   * @deprecated Isolation policy belongs to the broker. Setting it here now
   * sets it for every untrusted child, not just this manager's sessions.
   */
  readonly sandboxPolicy?: SandboxPolicy;
  /** Broker to launch sessions through. Defaults to the process-wide one. */
  readonly broker?: ProcessBroker;
}

// ---------------------------------------------------------------------------
// Internal session state (not exported — callers use ShellSession snapshots)
// ---------------------------------------------------------------------------

/**
 * Bytes retained per end, per stream, per session. Reads truncate to 20 KiB at
 * each end, so this keeps several times more than any caller can observe: the
 * bound is reached only by output that was already going to be elided.
 */
const SESSION_RETAIN_BYTES = 64 * 1024;

/**
 * One stream of a session, held in bounded memory.
 *
 * A session outlives the command that filled it, so this is where unbounded
 * retention hurts most: the previous chunk array was never freed, and grew for
 * the life of the session even under ordinary use, because draining only
 * advanced a cursor past chunks it left in place. Two windows replace it —
 * `history` for a reattach that wants the whole session, `pending` for the
 * incremental read — and each discards its own middle as it fills.
 */
interface SessionStream {
  readonly history: BoundedOutput;
  readonly pending: BoundedOutput;
}

function newStream(): SessionStream {
  const window = { headBytes: SESSION_RETAIN_BYTES, tailBytes: SESSION_RETAIN_BYTES };
  return { history: new BoundedOutput(window), pending: new BoundedOutput(window) };
}

interface LiveSession {
  id: string;
  process: ChildProcess;
  cwd: string;
  startedAt: number;
  lastAccessedAt: number;
  stdout: SessionStream;
  stderr: SessionStream;
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
  private readonly broker: ProcessBroker;
  private nextId = 1;

  constructor(opts: ShellSessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.headTailOpts = opts.headTail ?? {};
    this.captureState = opts.captureState ?? true;
    this.broker = opts.broker ?? getProcessBroker();
    if (opts.sandboxPolicy !== undefined) this.broker.setPolicy(opts.sandboxPolicy);
  }

  /**
   * Create a new persistent shell session. Optionally run an initial command.
   * Returns the session ID and PID.
   */
  async create(cwd: string, initialCommand?: string): Promise<ShellSession> {
    this.evictIfNeeded();

    const id = `sh_${this.nextId++}`;
    const env = { ...getHardenedEnv(), TERM: "dumb", PS1: "" };
    const { child } = await this.broker.spawn({
      kind: "shell-session",
      command: "/bin/bash",
      args: ["--norc", "--noprofile", "-i"],
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      label: `persistent shell ${id}`,
    });

    const session: LiveSession = {
      id,
      process: child,
      cwd,
      startedAt: Date.now(),
      lastAccessedAt: Date.now(),
      stdout: newStream(),
      stderr: newStream(),
      lastCommand: initialCommand ?? null,
      state: null,
      exitCode: null,
      exited: false,
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      session.stdout.history.push(chunk);
      session.stdout.pending.push(chunk);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      session.stderr.history.push(chunk);
      session.stderr.pending.push(chunk);
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
      killProcessTree(session.process, sig);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read new output since the last read. Draining clears the pending window,
   * so what a reader has already seen stops being held. Output is
   * HeadTail-truncated per the configured limits.
   */
  readOutput(sessionId: string): SessionOutput | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastAccessedAt = Date.now();

    const newStdout = session.stdout.pending.bytes();
    session.stdout.pending.reset();

    const newStderr = session.stderr.pending.bytes();
    session.stderr.pending.reset();

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

    const allStdout = session.stdout.history.bytes();
    const allStderr = session.stderr.history.bytes();

    // Everything has now been seen, so nothing is pending.
    session.stdout.pending.reset();
    session.stderr.pending.reset();

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
      killProcessTree(session.process);
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

  private snapshot(s: LiveSession): ShellSession {
    return {
      id: s.id,
      pid: s.process.pid!,
      cwd: s.cwd,
      startedAt: s.startedAt,
      lastAccessedAt: s.lastAccessedAt,
      // Bytes the process produced, not bytes still held. A caller asking how
      // much a session has emitted wants the former, and it stays accurate
      // after the middle has been discarded.
      totalStdoutBytes: s.stdout.history.totalBytes,
      totalStderrBytes: s.stderr.history.totalBytes,
      lastCommand: s.lastCommand,
      state: s.state,
      exitCode: s.exitCode,
      exited: s.exited,
    };
  }
}
