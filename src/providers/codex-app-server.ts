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
import type { NormalizedEvent } from "../core/types.js";
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
  ThreadStartParams,
  ThreadStartResult,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
  ThreadArchiveParams,
  TurnStartedNotification,
  TurnCompletedNotification,
  ItemStartedNotification,
  ItemCompletedNotification,
  CommandExecutionItem,
  ItemAgentMessageDeltaNotification,
  ThreadTokenUsageNotification,
  Tool,
  DynamicToolCallContext,
  DynamicToolCallResponse,
} from "./codex-app-server-types.js";
import { DynamicToolCallParamsSchema } from "./codex-app-server-types.js";

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/** Sandbox mode accepted by Codex App Server thread/start. */
export type SandboxMode = "danger-full-access" | "workspace-write" | "read-only";

/** Approval policy accepted by Codex App Server thread/start. */
export type AskForApproval = "never" | "on-failure" | "always";

/**
 * Handler invoked when the codex agent calls a dynamic tool registered at
 * thread/start. Returns the structured response sent back as the JSON-RPC
 * result for the `item/tool/call` request.
 *
 * Implementations should NOT throw — wrap errors and return
 * `{ contentItems: [...error text...], success: false }`. The provider's
 * dispatch loop additionally wraps the call in try/catch for safety.
 */
export type DynamicToolCallHandler = (
  tool: string,
  args: unknown,
  context: DynamicToolCallContext,
) => Promise<DynamicToolCallResponse>;

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
   * Tools to register at thread/start (sent as `dynamicTools`). Each entry
   * becomes callable by the codex agent via `item/tool/call` requests, which
   * are dispatched to `onDynamicToolCall`.
   *
   * When non-empty, the provider also sets `capabilities.experimentalApi: true`
   * in the initialize handshake — the App Server requires it to honor
   * dynamicTools.
   */
  readonly dynamicTools?: readonly Tool[];
  /**
   * Handler invoked when the codex agent calls a registered dynamic tool.
   * Required when `dynamicTools` is non-empty.
   */
  readonly onDynamicToolCall?: DynamicToolCallHandler;
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
  private overflowed = false;

  /**
   * Push a chunk of text. Returns parsed lines, or throws on overflow.
   * @param onOverflow - called when the buffer exceeds MAX_LINE_BYTES so the
   *   provider can drain active turn queues before the caller propagates the
   *   error (Defect 6).
   */
  push(chunk: string, onOverflow?: () => void): string[] {
    if (this.overflowed) return [];
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.overflowed = true;
      if (onOverflow !== undefined) onOverflow();
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

/**
 * A JSON-RPC *request* sent by the server (has both `method` and `id`,
 * unlike notifications which lack `id` and responses which lack `method`).
 * Used for the `item/tool/call` dynamicTools dispatch path (Stage 4H).
 */
interface JsonRpcServerRequest {
  readonly method: string;
  readonly id: number;
  readonly params: unknown;
}

function isServerRequest(frame: unknown): frame is JsonRpcServerRequest {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return (
    typeof f["method"] === "string" &&
    "id" in f &&
    typeof f["id"] === "number"
  );
}

function isErrorResponse(frame: unknown): frame is JsonRpcError {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return "id" in f && typeof f["id"] === "number" && "error" in f && !("method" in f);
}

function isSuccessResponse(frame: unknown): frame is JsonRpcResponse {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as Record<string, unknown>;
  return "id" in f && typeof f["id"] === "number" && "result" in f && !("method" in f);
}

// ---------------------------------------------------------------------------
// CodexAppServerProvider
// ---------------------------------------------------------------------------

export class CodexAppServerProvider extends EventEmitter {
  private readonly options: Required<
    Omit<CodexAppServerOptions, "model" | "dynamicTools" | "onDynamicToolCall">
  > & {
    readonly model: string | undefined;
    readonly dynamicTools: readonly Tool[];
    readonly onDynamicToolCall: DynamicToolCallHandler | undefined;
  };

  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly reader = new JsonLineReader();

  /** Cumulative token usage aggregated from thread/tokenUsage/updated events. */
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private cumulativeCacheReadTokens = 0;

  /**
   * Set of enqueue functions for all active runTurn() calls. Used to inject
   * fatal error + done items when the child crashes mid-stream (Defect 3).
   */
  private readonly activeTurnQueues = new Set<
    (item: { kind: "event"; event: import("../core/types.js").NormalizedEvent } | { kind: "done" }) => void
  >();

  /**
   * Whether dispose() has been intentionally called (suppresses crash injection
   * in the child error/close handlers). One-shot — the provider is single-use;
   * after dispose(), `start()` will throw on the `child !== null` guard. If a
   * future caller adds a re-start path, this must reset to `false`.
   */
  private disposing = false;

  constructor(options: CodexAppServerOptions = {}) {
    super();
    if (
      options.dynamicTools !== undefined &&
      options.dynamicTools.length > 0 &&
      options.onDynamicToolCall === undefined
    ) {
      throw new Error(
        "CodexAppServerProvider: dynamicTools requires onDynamicToolCall",
      );
    }
    this.options = {
      codexBinary: options.codexBinary ?? "codex",
      cwd: options.cwd ?? process.cwd(),
      model: options.model,
      sandbox: options.sandbox ?? "danger-full-access",
      approvalPolicy: options.approvalPolicy ?? "never",
      dynamicTools: options.dynamicTools ?? [],
      onDynamicToolCall: options.onDynamicToolCall,
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
        lines = this.reader.push(chunk, () => {
          // Overflow: drain active turn queues with a fatal error (Defect 6).
          this.rejectAllPending(new Error("JsonLineReader: buffer exceeded — transport broken"));
          this.drainActiveTurnQueuesWithError("JsonLineReader: line too long — transport broken");
        });
      } catch (err) {
        this.emit("error", err);
        return;
      }
      for (const line of lines) {
        this.dispatchLine(line);
      }
    });

    // Propagate process errors and drain any active turn queues (Defect 3).
    child.on("error", (err) => {
      this.rejectAllPending(err);
      if (!this.disposing) {
        this.drainActiveTurnQueuesWithError(`transport error: ${err.message}`);
      }
      this.emit("error", err);
    });

    // Writes to the child's stdin fail ASYNCHRONOUSLY, as an "error" event on
    // the stream. The handler above is on the child process and covers spawn
    // failures, not pipe writes — so without this listener an EPIPE from
    // writing a frame to an already-exited codex was an uncaught exception
    // that killed the host. It also stranded the caller: `send` registers into
    // `pending` before it writes, so the request being written never settled.
    // Draining here turns both into a rejected promise.
    child.stdin?.on("error", (err: Error) => {
      this.rejectAllPending(err);
      if (!this.disposing) {
        this.drainActiveTurnQueuesWithError(`transport write failed: ${err.message}`);
      }
    });

    // If the child exits unexpectedly (not via dispose()), unblock active turns.
    child.on("close", (_code, _signal) => {
      if (!this.disposing) {
        this.drainActiveTurnQueuesWithError("codex child process exited unexpectedly");
      }
    });

    // Send initialize request.
    // When dynamicTools are registered we must opt into experimentalApi so
    // the App Server honors them and routes item/tool/call requests back.
    const useExperimentalApi = this.options.dynamicTools.length > 0;
    const params: InitializeParams = {
      clientInfo: { name: "openswarm", version: "0.0.1" },
      capabilities: useExperimentalApi ? { experimentalApi: true } : null,
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
   * Send `thread/start` and return the new thread's id and selected model.
   * Call after `start()`.
   */
  async startThread(opts: {
    model?: string;
    cwd?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: AskForApproval;
  } = {}): Promise<{ threadId: string; model: string }> {
    const params: ThreadStartParams = {
      experimentalRawEvents: false,
      ...(opts.model !== undefined && { model: opts.model }),
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.sandbox !== undefined && { sandbox: opts.sandbox }),
      ...(opts.approvalPolicy !== undefined && { approvalPolicy: opts.approvalPolicy }),
      ...(this.options.dynamicTools.length > 0 && {
        dynamicTools: this.options.dynamicTools,
      }),
    };

    const result = await this.request<ThreadStartResult>(
      "thread/start",
      params as unknown as Record<string, unknown>,
    );

    return { threadId: result.thread.id, model: result.model };
  }

  /**
   * Send `turn/start` and stream `NormalizedEvent`s until the turn completes
   * or is interrupted. Honors `signal.aborted` — sends `turn/interrupt` and
   * emits an error event if the signal fires.
   */
  async *runTurn(
    threadId: string,
    prompt: string,
    opts: { signal?: AbortSignal; model?: string } = {},
  ): AsyncIterable<NormalizedEvent> {
    const { signal, model } = opts;

    // Build turn/start params.
    const turnParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: prompt }],
      ...(model !== undefined && { model }),
    };

    // Send turn/start; capture the assigned turnId from the response.
    const turnResult = await this.request<TurnStartResult>(
      "turn/start",
      turnParams as unknown as Record<string, unknown>,
    );
    const turnId = turnResult.turn.id;

    // If already aborted before we even started streaming, bail out.
    if (signal?.aborted) {
      await this.sendTurnInterrupt(threadId, turnId);
      const providerError: NormalizedEvent = {
        type: "error",
        error: { code: "transport", message: "Turn aborted before streaming", retryable: false },
      };
      yield providerError;
      return;
    }

    // Snapshot cumulative usage at turn start for per-turn delta (Defect 5).
    const turnStartUsage = {
      inputTokens: this.cumulativeInputTokens,
      outputTokens: this.cumulativeOutputTokens,
    };

    // Build an async queue fed by the notification listener.
    type QueueItem =
      | { kind: "event"; event: NormalizedEvent }
      | { kind: "done" };

    const queue: QueueItem[] = [];
    let resolveWaiter: (() => void) | null = null;

    // aborted flag — set true when abort fires; prevents late notifications
    // from enqueuing into a no-longer-drained queue (Defect 1).
    let aborted = false;

    function enqueue(item: QueueItem): void {
      queue.push(item);
      if (resolveWaiter !== null) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
    }

    async function waitForItem(): Promise<void> {
      if (queue.length > 0) return;
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
      });
    }

    // Register this turn's enqueue in activeTurnQueues so child crashes
    // can unblock us (Defect 3).
    this.activeTurnQueues.add(enqueue);

    // Notification listener — translates Codex events to NormalizedEvent.
    const onNotification = (frame: JsonRpcNotification): void => {
      // Guard: if this turn was aborted, discard all late notifications (Defect 1).
      if (aborted) return;

      const method = frame.method;
      const params = frame.params as Record<string, unknown>;

      // Skip v1 codex/event/* wrappers — use v2 events only.
      if (method.startsWith("codex/event/")) return;

      // Filter by threadId when present.
      if (
        "threadId" in params &&
        typeof params["threadId"] === "string" &&
        params["threadId"] !== threadId
      ) {
        return;
      }

      // Filter by turnId when present (after we know the turnId).
      if (
        "turnId" in params &&
        typeof params["turnId"] === "string" &&
        params["turnId"] !== turnId
      ) {
        return;
      }

      if (method === "turn/started") {
        // Notification echo of our turn/start — no event emitted.
        const p = params as unknown as TurnStartedNotification;
        // turnId confirmation; already captured from response.
        void p;
        return;
      }

      if (method === "item/agentMessage/delta") {
        const p = params as unknown as ItemAgentMessageDeltaNotification;
        enqueue({ kind: "event", event: { type: "text_delta", text: p.delta } });
        return;
      }

      if (method === "item/started") {
        const p = params as unknown as ItemStartedNotification;
        if (p.item.type === "commandExecution") {
          const item = p.item as unknown as CommandExecutionItem;
          const id = item.id;
          enqueue({ kind: "event", event: { type: "tool_use_start", id, name: "exec" } });
          enqueue({
            kind: "event",
            event: {
              type: "tool_use_input",
              id,
              jsonDelta: JSON.stringify({
                command: item.command,
                cwd: item.cwd,
                commandActions: item.commandActions,
              }),
            },
          });
          enqueue({ kind: "event", event: { type: "tool_use_end", id } });
          return;
        }
        // userMessage, agentMessage: text already streamed via deltas — drop.
        // reasoning, plan, webSearch, contextCompaction: fall through to info.
        if (p.item.type === "userMessage" || p.item.type === "agentMessage") {
          return;
        }
        enqueue({
          kind: "event",
          event: {
            type: "info",
            source: "codex",
            method,
            payload: frame.params ?? null,
          },
        });
        return;
      }

      if (method === "item/completed") {
        const p = params as unknown as ItemCompletedNotification;
        if (p.item.type === "commandExecution") {
          const item = p.item as unknown as CommandExecutionItem;
          enqueue({
            kind: "event",
            event: {
              type: "tool_result",
              toolUseId: item.id,
              content: item.aggregatedOutput ?? "",
              isError: item.exitCode !== 0,
            },
          });
          return;
        }
        // userMessage, agentMessage: text already streamed via deltas — drop.
        if (p.item.type === "userMessage" || p.item.type === "agentMessage") {
          return;
        }
        // Other types (reasoning, plan, etc.): emit as info.
        enqueue({
          kind: "event",
          event: {
            type: "info",
            source: "codex",
            method,
            payload: frame.params ?? null,
          },
        });
        return;
      }

      if (method === "thread/tokenUsage/updated") {
        const p = params as unknown as ThreadTokenUsageNotification;
        // Accumulate for getCumulativeUsage(); don't emit a NormalizedEvent.
        const last = p.tokenUsage.last;
        this.cumulativeInputTokens += last.inputTokens;
        this.cumulativeOutputTokens += last.outputTokens;
        this.cumulativeCacheReadTokens += last.cachedInputTokens;
        return;
      }

      if (method === "account/rateLimits/updated") {
        // Skip in v0.3.
        return;
      }

      if (method === "turn/completed") {
        const p = params as unknown as TurnCompletedNotification;
        if (p.threadId !== threadId) return;
        // Also guard by turnId: ignore completions for a different turn
        // (e.g. a late notification from an aborted prior turn).
        if (p.turn.id !== turnId) return;

        if (p.turn.status === "failed" && p.turn.error !== null) {
          enqueue({
            kind: "event",
            event: {
              type: "error",
              error: {
                code: "provider_unavailable",
                message: p.turn.error.message,
                retryable: false,
              },
            },
          });
        }

        const stopReason = p.turn.status === "completed" ? "end_turn" : "error";
        // Per-turn delta — getCumulativeUsage() returns the session total.
        const turnDelta = {
          inputTokens: this.cumulativeInputTokens - turnStartUsage.inputTokens,
          outputTokens: this.cumulativeOutputTokens - turnStartUsage.outputTokens,
        };
        enqueue({
          kind: "event",
          event: {
            type: "message_stop",
            stopReason,
            usage: turnDelta,
          },
        });
        enqueue({ kind: "done" });
        return;
      }

      if (method === "error") {
        // v0.4 stage 4M.9: when Codex sends a bare `error` notification
        // without a `message` field, the previous fallback of "Unknown error"
        // dropped the entire payload — making the consultant pattern's
        // failures un-debuggable. Now we serialise the full params object so
        // operators can see whatever Codex actually told us (status code,
        // requestId, code, etc.).
        const p = params as { message?: string };
        const msg =
          p.message !== undefined && p.message !== ""
            ? p.message
            : `codex error notification with no message field; params=${JSON.stringify(params)}`;
        enqueue({
          kind: "event",
          event: {
            type: "error",
            error: {
              code: "provider_unavailable",
              message: msg,
              retryable: false,
            },
          },
        });
        enqueue({ kind: "done" });
        return;
      }

      // Anything else — emit as info so callers can inspect unknown notifications.
      enqueue({
        kind: "event",
        event: {
          type: "info",
          source: "codex",
          method,
          payload: frame.params ?? null,
        },
      });
    };

    this.on("notification", onNotification);

    // Abort handler (Defect 1): set aborted and remove listener immediately
    // so no microtask-late notifications can sneak through after abort.
    // We do NOT reject unrelated pending entries — only the current turn's
    // turn/interrupt request is fire-and-forget so it doesn't pollute the map
    // (sendTurnInterrupt already wraps in try/catch and ignores rejections).
    let abortHandler: (() => void) | null = null;
    if (signal !== undefined) {
      abortHandler = () => {
        aborted = true;
        // Remove listener immediately — not just in finally — to prevent a
        // microtask-queued turn/completed from firing after we're done.
        this.off("notification", onNotification);
        void this.sendTurnInterrupt(threadId, turnId);
        enqueue({
          kind: "event",
          event: {
            type: "error",
            error: { code: "transport", message: "Turn aborted", retryable: false },
          },
        });
        enqueue({ kind: "done" });
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      // Drain the queue until we see a "done" sentinel.
      while (true) {
        await waitForItem();
        while (queue.length > 0) {
          const item = queue.shift()!;
          if (item.kind === "done") return;
          yield item.event;
        }
      }
    } finally {
      this.activeTurnQueues.delete(enqueue);
      this.off("notification", onNotification);
      if (signal !== undefined && abortHandler !== null) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }

  /**
   * Send `thread/archive` to cleanly shut down the thread.
   * Non-fatal on failure.
   */
  async archiveThread(threadId: string): Promise<void> {
    try {
      const params: ThreadArchiveParams = { threadId };
      await this.request<unknown>(
        "thread/archive",
        params as unknown as Record<string, unknown>,
      );
    } catch {
      // Non-fatal — best-effort cleanup.
    }
  }

  /**
   * Return cumulative token usage aggregated from all
   * `thread/tokenUsage/updated` notifications received so far.
   */
  getCumulativeUsage(): {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
  } {
    return {
      inputTokens: this.cumulativeInputTokens,
      outputTokens: this.cumulativeOutputTokens,
      cacheReadInputTokens: this.cumulativeCacheReadTokens,
      cacheWriteInputTokens: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async sendTurnInterrupt(threadId: string, turnId: string): Promise<void> {
    try {
      const params: TurnInterruptParams = { threadId, turnId };
      await this.request<unknown>(
        "turn/interrupt",
        params as unknown as Record<string, unknown>,
      );
    } catch {
      // Non-fatal.
    }
  }

  /**
   * Graceful shutdown: close stdin, wait for process exit (up to 5 s, then
   * SIGKILL). Resolves when the process closes.
   */
  async dispose(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    this.child = null;
    this.disposing = true;

    // Drain any in-flight runTurn consumers so they receive error+done instead
    // of hanging on waitForItem(). Covers the narrow race where a child
    // error/close fires *after* dispose() flips `disposing=true` (the
    // listener's `!this.disposing` guard would otherwise skip the drain).
    this.drainActiveTurnQueuesWithError("provider disposed");

    // Reject any in-flight requests.
    this.rejectAllPending(new Error("CodexAppServerProvider: disposed"));

    return new Promise<void>((resolve) => {
      // Close stdin to signal EOF to the server.
      if (child.stdin !== null) {
        child.stdin.end();
      }

      // Kill timeout — 5 seconds.
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);

      // Single close listener: cancel the kill timer then resolve (Defect 2).
      child.once("close", () => {
        clearTimeout(killTimer);
        resolve();
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

    // Server-originated request (has both method AND id) — dispatch
    // before notification because the notification check is based on
    // "method but no id". (Stage 4H — item/tool/call.)
    if (isServerRequest(parsed)) {
      void this.handleServerRequest(parsed);
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

  /**
   * Handle a server-originated JSON-RPC request. Currently only
   * `item/tool/call` is supported (Stage 4H — dynamicTools dispatch).
   * Always replies with a JSON-RPC result frame matching the incoming id.
   * Errors are returned as `{success: false}` rather than thrown so the
   * dispatch loop never crashes.
   */
  private async handleServerRequest(req: JsonRpcServerRequest): Promise<void> {
    if (req.method === "item/tool/call") {
      let response: DynamicToolCallResponse;
      try {
        const parsed = DynamicToolCallParamsSchema.safeParse(req.params);
        if (!parsed.success) {
          response = {
            contentItems: [
              { type: "inputText", text: `invalid params: ${parsed.error.message}` },
            ],
            success: false,
          };
        } else if (this.options.onDynamicToolCall === undefined) {
          response = {
            contentItems: [
              {
                type: "inputText",
                text: "no dynamic tool handler registered",
              },
            ],
            success: false,
          };
        } else {
          response = await this.options.onDynamicToolCall(
            parsed.data.tool,
            parsed.data.arguments,
            {
              threadId: parsed.data.threadId,
              turnId: parsed.data.turnId,
              callId: parsed.data.callId,
            },
          );
        }
      } catch (err) {
        response = {
          contentItems: [
            {
              type: "inputText",
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          success: false,
        };
      }
      this.sendResultResponse(req.id, response);
      return;
    }

    // Unknown server request — reply with a JSON-RPC error so the server
    // doesn't hang waiting for a response.
    this.sendErrorResponse(
      req.id,
      -32601,
      `Method not found: ${req.method}`,
    );
  }

  /**
   * Send a JSON-RPC success response back to the server. Used for
   * dynamicTools (`item/tool/call`) responses.
   */
  private sendResultResponse(id: number, result: unknown): void {
    const child = this.child;
    if (child === null || child.stdin === null) return;
    const frame = { jsonrpc: "2.0", id, result };
    try {
      child.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // Best-effort — transport may be torn down.
    }
  }

  /**
   * Send a JSON-RPC error response back to the server (for unknown server
   * requests). Mirrors {@link sendResultResponse} on the failure path.
   */
  private sendErrorResponse(id: number, code: number, message: string): void {
    const child = this.child;
    if (child === null || child.stdin === null) return;
    const frame = { jsonrpc: "2.0", id, error: { code, message } };
    try {
      child.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // Best-effort.
    }
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(err);
    }
    this.pending.clear();
  }

  /**
   * Inject a fatal error event + done sentinel into every active runTurn()
   * queue. Used when the child crashes mid-stream (Defect 3) or when the
   * line reader overflows (Defect 6).
   */
  private drainActiveTurnQueuesWithError(message: string): void {
    const errorEvent: NormalizedEvent = {
      type: "error",
      error: { code: "transport", message, retryable: false },
    };
    for (const enqueue of this.activeTurnQueues) {
      enqueue({ kind: "event", event: errorEvent });
      enqueue({ kind: "done" });
    }
    this.activeTurnQueues.clear();
  }
}
