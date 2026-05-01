/**
 * CodexAppServerProvider — JSON-RPC 2.0 client for the Codex App Server.
 *
 * Spawns `codex app-server` as a subprocess, performs the `initialize`
 * handshake, and exposes lifecycle methods for Stage 3A. Agent-turn
 * execution (thread/start, turn/start, event streaming) is Stage 3B.
 *
 * Protocol: line-delimited JSON over stdio. Notifications (no `id` field)
 * are re-emitted on the `"notification"` EventEmitter event. Responses are
 * matched to pending requests by `id`.
 *
 * See test/fixtures/codex-app-server/SPIKE-NOTES.md for protocol details.
 */

import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcServerFrame,
  InitializeParams,
  InitializeResult,
  GetAuthStatusParams,
  GetAuthStatusResult,
} from "./codex-app-server-types.js";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/** Sandbox mode accepted by Codex App Server thread/start. */
export type SandboxMode = "danger-full-access" | "workspace-write" | "read-only";

/** Approval policy accepted by Codex App Server thread/start. */
export type AskForApproval = "never" | "on-failure" | "always";

export interface CodexAppServerOptions {
  /** Path to the codex binary. Defaults to `"codex"` (resolved via PATH). */
  readonly codexBinary?: string;
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Model override passed to thread/start. */
  readonly model?: string;
  /** Sandbox policy. Defaults to `"danger-full-access"`. */
  readonly sandbox?: SandboxMode;
  /** Approval policy. Defaults to `"never"`. */
  readonly approvalPolicy?: AskForApproval;
  /**
   * Injectable spawn function for testing. Defaults to Node's built-in
   * `child_process.spawn`. The signature must match `child_process.spawn`.
   */
  readonly spawn?: typeof nodeSpawn;
}

// ---------------------------------------------------------------------------
// Internal line-delimited JSON reader
// ---------------------------------------------------------------------------

/** Maximum line size accepted from server stdout (guards against OOM). */
const MAX_LINE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Incremental line splitter for the server's stdout stream.
 * Feeds string chunks, emits complete `\n`-delimited lines.
 */
class JsonLineReader {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      throw new Error(`JsonLineReader: buffer exceeded ${MAX_LINE_BYTES} bytes`);
    }
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.filter((l) => l.length > 0);
  }
}

// ---------------------------------------------------------------------------
// Frame discriminators
// ---------------------------------------------------------------------------

function isNotification(frame: unknown): frame is JsonRpcNotification {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return typeof f["method"] === "string" && !("id" in f);
}

function isErrorResponse(frame: unknown): frame is JsonRpcError {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return "id" in f && typeof f["id"] === "number" && "error" in f;
}

function isSuccessResponse(frame: unknown): frame is JsonRpcResponse {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return "id" in f && typeof f["id"] === "number" && "result" in f;
}

// ---------------------------------------------------------------------------
// CodexAppServerProvider
// ---------------------------------------------------------------------------

export class CodexAppServerProvider extends EventEmitter {
  private readonly options: Required<Omit<CodexAppServerOptions, "model">> & {
    readonly model: string | undefined;
  };

  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly reader = new JsonLineReader();

  constructor(options: CodexAppServerOptions = {}) {
    super();
    this.options = {
      codexBinary: options.codexBinary ?? "codex",
      cwd: options.cwd ?? process.cwd(),
      model: options.model,
      sandbox: options.sandbox ?? "danger-full-access",
      approvalPolicy: options.approvalPolicy ?? "never",
      spawn: options.spawn ?? nodeSpawn,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn `codex app-server`, send the `initialize` handshake, and return
   * the server's user-agent string.
   *
   * Resolves once the server responds to `initialize`. Rejects if the
   * process fails to start or the handshake is rejected.
   */
  async start(): Promise<{ userAgent: string }> {
    if (this.child !== null) {
      throw new Error("CodexAppServerProvider: already started");
    }

    const spawnFn = this.options.spawn;
    const child = spawnFn(this.options.codexBinary, ["app-server"], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child = child;

    // Wire stdout reader.
    if (child.stdout === null) {
      throw new Error("CodexAppServerProvider: child.stdout is null");
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = this.reader.push(chunk);
      } catch (err) {
        this.emit("error", err);
        return;
      }
      for (const line of lines) {
        this.dispatchLine(line);
      }
    });

    // Propagate process errors.
    child.on("error", (err) => {
      this.rejectAllPending(err);
      this.emit("error", err);
    });

    // Send initialize request.
    const params: InitializeParams = {
      clientInfo: { name: "swarm-harness", version: "0.0.1" },
      capabilities: null,
    };

    const result = await this.request<InitializeResult>("initialize", params as unknown as Record<string, unknown>);
    return { userAgent: result.userAgent };
  }

  /**
   * Send `getAuthStatus` and return the parsed auth fields.
   * Call after `start()`.
   */
  async getAuthStatus(): Promise<{
    authMethod: string | null;
    requiresOpenaiAuth: boolean;
  }> {
    const params: GetAuthStatusParams = {
      includeToken: null,
      refreshToken: null,
    };

    const result = await this.request<GetAuthStatusResult>(
      "getAuthStatus",
      params as unknown as Record<string, unknown>,
    );

    return {
      authMethod: result.authMethod ?? null,
      requiresOpenaiAuth: result.requiresOpenaiAuth ?? false,
    };
  }

  /**
   * Graceful shutdown: close stdin, wait for process exit (up to 5 s, then
   * SIGKILL). Resolves when the process closes.
   */
  async dispose(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.child = null;

    // Reject any in-flight requests.
    this.rejectAllPending(new Error("CodexAppServerProvider: disposed"));

    return new Promise<void>((resolve) => {
      child.once("close", () => resolve());

      // Close stdin to signal EOF to the server.
      if (child.stdin !== null) {
        child.stdin.end();
      }

      // Kill timeout — 5 seconds.
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);

      child.once("close", () => {
        clearTimeout(killTimer);
      });
    });
  }

  // -------------------------------------------------------------------------
  // JSON-RPC internals
  // -------------------------------------------------------------------------

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const child = this.child;
    if (child === null || child.stdin === null) {
      return Promise.reject(new Error("CodexAppServerProvider: not started"));
    }

    const id = this.nextId++;
    const frame: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      child.stdin!.write(JSON.stringify(frame) + "\n");
    });
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Malformed line — ignore.
      return;
    }

    const frame = parsed as JsonRpcServerFrame;

    if (isNotification(frame)) {
      this.emit("notification", frame);
      return;
    }

    if (isErrorResponse(frame)) {
      const entry = this.pending.get(frame.id);
      if (entry !== undefined) {
        this.pending.delete(frame.id);
        entry.reject(
          new Error(
            `JSON-RPC error ${frame.error.code}: ${frame.error.message}`,
          ),
        );
      }
      return;
    }

    if (isSuccessResponse(frame)) {
      const entry = this.pending.get(frame.id);
      if (entry !== undefined) {
        this.pending.delete(frame.id);
        entry.resolve(frame.result);
      }
      return;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }
}
