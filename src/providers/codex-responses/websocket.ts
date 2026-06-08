/**
 * WebSocket "cached" transport for the codex Responses API.
 *
 * Reuses a single connection across turns within a session and sends only the
 * NEW input items + `previous_response_id` (the server holds prior context
 * connection-scoped, since store:false disables cross-request reuse). This
 * avoids re-uploading the full prefix each turn — a latency win on large
 * sessions. Ported from openclaw `openai-chatgpt-responses.ts`.
 *
 * Correctness is guaranteed by a JSON prefix-equality check: the delta is only
 * sent when the current request provably continues the last one; otherwise we
 * fall back to the full body. The whole transport also falls back to SSE on any
 * connection failure (in "auto" mode).
 */

import { buildCodexHeaders, type CodexHeaderParams } from "./headers.js";
import type { CodexSseEvent, CodexInputItem, CodexRequestBody } from "./types.js";

export const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";

// Minimal structural type for the runtime WebSocket (global in Node 20+).
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState?: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

type WebSocketCtor = new (url: string, opts?: { headers?: Record<string, string> }) => WebSocketLike;

export function resolveCodexWsUrl(endpoint: string): string {
  return endpoint.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

/** WS headers: codex auth headers minus the SSE-only bits, with the WS beta. */
export function buildCodexWsHeaders(p: CodexHeaderParams): Record<string, string> {
  const headers = buildCodexHeaders(p);
  delete headers["accept"];
  delete headers["content-type"];
  headers["OpenAI-Beta"] = OPENAI_BETA_RESPONSES_WEBSOCKETS;
  return headers;
}

function getWebSocketCtor(): WebSocketCtor | null {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof ctor === "function" ? (ctor as unknown as WebSocketCtor) : null;
}

export function isWebSocketReusable(socket: WebSocketLike | null): boolean {
  if (socket === null) return false;
  // readyState 1 === OPEN; if the runtime doesn't expose it, assume reusable.
  return socket.readyState === undefined || socket.readyState === 1;
}

/** Open a WS connection, resolving on `open` and rejecting on error/close/abort. */
export function connectCodexWs(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  ctorOverride?: WebSocketCtor,
): Promise<WebSocketLike> {
  const Ctor = ctorOverride ?? getWebSocketCtor();
  if (Ctor === null) return Promise.reject(new Error("WebSocket transport is not available in this runtime"));

  return new Promise<WebSocketLike>((resolve, reject) => {
    let settled = false;
    let socket: WebSocketLike;
    try {
      socket = new Ctor(url, { headers });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("codex WebSocket connection error"));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("codex WebSocket closed before open"));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.close(1000, "aborted");
      reject(new Error("request aborted"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

function decodeWsData(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const v = data;
    return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  return null;
}

const COMPLETION_TYPES = new Set(["response.completed", "response.done", "response.incomplete", "response.failed"]);

/** Yield parsed Responses events from a WS socket until completion/close. */
export async function* parseCodexWs(
  socket: WebSocketLike,
  signal?: AbortSignal,
): AsyncGenerator<CodexSseEvent> {
  const queue: CodexSseEvent[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let failed: Error | null = null;
  let sawCompletion = false;

  const wake = () => {
    const r = pending;
    pending = null;
    r?.();
  };
  const onMessage = (event: unknown) => {
    const text = decodeWsData((event as { data?: unknown } | undefined)?.data);
    if (text === null || text.trim() === "") return; // undecodable/empty keep-alive
    let parsed: CodexSseEvent;
    try {
      parsed = JSON.parse(text) as CodexSseEvent;
    } catch {
      // A corrupt frame would otherwise be dropped, completing the turn with
      // silently-missing assistant content. Fail the turn so the engine retries.
      failed = new Error("malformed codex WebSocket frame");
      done = true;
      wake();
      return;
    }
    if (parsed && typeof parsed.type === "string") {
      if (COMPLETION_TYPES.has(parsed.type)) {
        sawCompletion = true;
        done = true;
      }
      queue.push(parsed);
      wake();
    }
  };
  const onError = () => {
    failed = new Error("codex WebSocket error mid-stream");
    done = true;
    wake();
  };
  const onClose = () => {
    if (!sawCompletion && failed === null) failed = new Error("codex WebSocket closed before completion");
    done = true;
    wake();
  };
  const onAbort = () => {
    failed = new Error("request aborted");
    done = true;
    wake();
  };

  // Prefer ArrayBuffer over Blob for any binary frame so decodeWsData can read
  // it synchronously (some runtimes default to Blob).
  try {
    (socket as { binaryType?: string }).binaryType = "arraybuffer";
  } catch {
    /* runtime without binaryType — text frames still work */
  }
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose);
  signal?.addEventListener("abort", onAbort);
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("request aborted");
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        pending = resolve;
      });
    }
    if (failed) throw failed;
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------------------
// Delta / continuation
// ---------------------------------------------------------------------------

export interface WsContinuation {
  /** The full body (minus input) of the last turn, for the match check. */
  readonly lastBodyKey: string;
  /** The full input array sent last turn. */
  readonly lastInput: readonly CodexInputItem[];
  /** The assistant response converted to input items (server already has these). */
  readonly lastResponseItems: readonly CodexInputItem[];
  readonly lastResponseId: string;
}

function bodyKey(body: CodexRequestBody): string {
  const { input: _input, ...rest } = body as CodexRequestBody & { previous_response_id?: string };
  delete (rest as { previous_response_id?: string }).previous_response_id;
  void _input;
  return JSON.stringify(rest);
}

/**
 * Compute the delta body for a continuation turn, or return the full body when
 * the request does not provably continue the last one (prefix mismatch, changed
 * system/tools, shrunk history). Faithful to openclaw getCachedWebSocketInputDelta.
 */
export function buildWsTurnBody(
  body: CodexRequestBody,
  continuation: WsContinuation | null,
): CodexRequestBody {
  if (continuation === null) return body;
  if (bodyKey(body) !== continuation.lastBodyKey) return body;

  const current = body.input;
  const baseline = [...continuation.lastInput, ...continuation.lastResponseItems];
  if (current.length < baseline.length) return body;
  if (JSON.stringify(current.slice(0, baseline.length)) !== JSON.stringify(baseline)) return body;

  const delta = current.slice(baseline.length);
  return { ...body, previous_response_id: continuation.lastResponseId, input: delta };
}

export { bodyKey as wsBodyKey };
