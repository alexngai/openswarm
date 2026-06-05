/**
 * Persistent shell sessions (F11) with interactive stdin (F12).
 *
 * Manages long-lived /bin/bash processes that survive across tool calls.
 * Each session is a PTY-like process with stdin/stdout/stderr pipes.
 * Sessions are identified by string IDs and evicted LRU when the max is hit.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { headTailTruncate, type HeadTailOptions } from "./internal.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShellSession {
  readonly id: string;
  readonly pid: number;
  readonly cwd: string;
  readonly startedAt: number;
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
  exitCode: number | null;
  exited: boolean;
}

// ---------------------------------------------------------------------------
// ShellSessionManager
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SESSIONS = 64;

export class ShellSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly maxSessions: number;
  private readonly headTailOpts: HeadTailOptions;
  private nextId = 1;

  constructor(opts: ShellSessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.headTailOpts = opts.headTail ?? {};
  }

  /**
   * Create a new persistent shell session. Optionally run an initial command.
   * Returns the session ID and PID.
   */
  create(cwd: string, initialCommand?: string): ShellSession {
    this.evictIfNeeded();

    const id = `sh_${this.nextId++}`;
    const child = spawn("/bin/bash", ["--norc", "--noprofile", "-i"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "dumb", PS1: "" },
    });

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
      exitCode: null,
      exited: false,
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      session.stdoutChunks.push(chunk);
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      session.stderrChunks.push(chunk);
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
      exitCode: s.exitCode,
      exited: s.exited,
    };
  }
}
