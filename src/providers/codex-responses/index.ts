/**
 * CodexResponsesTransportProvider — in-process provider for ChatGPT
 * subscription plans via the codex backend Responses API.
 *
 * Owns its own transport (it does NOT use the Vercel AI SDK / `streamText`)
 * because the codex backend is not AI-SDK-compatible — see docs/42.
 *
 * Two transports:
 *  - "sse" (default): one HTTPS request per turn, full context (prompt caching
 *    keeps the repeated prefix cheap server-side).
 *  - "websocket" / "auto": a reused connection sends only the new input items +
 *    previous_response_id (delta), avoiding re-uploading the prefix each turn.
 *    "auto" falls back to SSE on any WS failure.
 *
 * Plugs into NativeEngine / HardenedNativeEngine through `Provider.stream()`;
 * `Provider.model` is intentionally omitted.
 */

import { randomUUID } from "node:crypto";
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "../index.js";
import { buildCodexRequest, assistantContentToCodexInput } from "./request-builder.js";
import { buildCodexHeaders, type CodexHeaderParams } from "./headers.js";
import { parseCodexSse } from "./sse.js";
import { CodexEventTranslator } from "./events.js";
import { classifyCodexHttpError } from "./errors.js";
import type { CodexReasoningConfig, CodexRequestBody, CodexSseEvent } from "./types.js";
import {
  resolveCodexWsUrl,
  buildCodexWsHeaders,
  connectCodexWs,
  parseCodexWs,
  isWebSocketReusable,
  buildWsTurnBody,
  wsBodyKey,
  type WebSocketLike,
  type WsContinuation,
} from "./websocket.js";

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const WS_IDLE_TTL_MS = 5 * 60 * 1000;

export type CodexTransport = "sse" | "websocket" | "auto";

/**
 * Supplies a fresh bearer token + account id at request time. Implementations
 * own refresh (the OAuth AuthSource, or a dev source reading codex's token).
 */
export interface CodexCredentialSource {
  getCredentials(): Promise<{ token: string; accountId: string }>;
}

type WsConnectFn = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
) => Promise<WebSocketLike>;

export interface CodexResponsesProviderOptions {
  readonly modelId: string;
  readonly credentials: CodexCredentialSource;
  readonly reasoning?: CodexReasoningConfig;
  readonly endpoint?: string;
  /** Stable id for cache affinity when a request omits sessionId. */
  readonly sessionId?: string;
  /** SSE (default), or WebSocket delta transport ("websocket"/"auto"). */
  readonly transport?: CodexTransport;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable WS connect for tests. Defaults to the real connector. */
  readonly wsConnectImpl?: WsConnectFn;
}

// gpt-5.5 on a ChatGPT plan (docs/42). Limits per openclaw's catalog.
function codexCapabilities(): ProviderCapabilities {
  return {
    streaming: true,
    promptCache: true,
    parallelToolUse: false,
    vision: true,
    reasoning: true,
    maxContextTokens: 400_000,
    maxOutputTokens: 128_000,
  };
}

type AssistantAcc =
  | { type: "text"; text: string }
  | { type: "reasoning"; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

function accumulateAssistant(acc: AssistantAcc[], ev: ProviderEvent): void {
  if (ev.type === "text-delta") {
    const tail = acc[acc.length - 1];
    if (tail !== undefined && tail.type === "text") tail.text += ev.text;
    else acc.push({ type: "text", text: ev.text });
  } else if (ev.type === "reasoning") {
    acc.push({ type: "reasoning", signature: ev.signature });
  } else if (ev.type === "tool-call") {
    acc.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
  }
}

function responseIdOf(raw: CodexSseEvent): string | undefined {
  if (raw.type === "response.created" || raw.type === "response.completed") {
    const r = raw.response as { id?: unknown } | undefined;
    if (typeof r?.id === "string") return r.id;
  }
  return undefined;
}

export class CodexResponsesTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "openai-codex";
  /** Own-transport provider — no Vercel AI SDK handle (Provider.model is optional). */
  readonly model = undefined;
  readonly capabilities: ProviderCapabilities = codexCapabilities();

  private readonly modelId: string;
  private readonly credentials: CodexCredentialSource;
  private readonly reasoning?: CodexReasoningConfig;
  private readonly endpoint: string;
  private readonly fallbackSessionId: string;
  private readonly transport: CodexTransport;
  private readonly fetchImpl: typeof fetch;
  private readonly wsConnect: WsConnectFn;

  // WebSocket state (per-session: one provider instance == one session).
  private ws: WebSocketLike | null = null;
  private continuation: WsContinuation | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: CodexResponsesProviderOptions) {
    this.modelId = opts.modelId;
    this.credentials = opts.credentials;
    this.reasoning = opts.reasoning;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.fallbackSessionId = opts.sessionId ?? randomUUID();
    this.transport = opts.transport ?? "sse";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsConnect = opts.wsConnectImpl ?? connectCodexWs;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // Pin a stable session id for the whole session → ~96% prefix caching on
    // repeat turns (docs/42 §6.2).
    const sessionId = req.sessionId ?? this.fallbackSessionId;

    let token: string;
    let accountId: string;
    try {
      ({ token, accountId } = await this.credentials.getCredentials());
    } catch (err) {
      yield { type: "error", code: "auth", message: `codex credentials unavailable: ${errMsg(err)}`, retryable: false, cause: err };
      return;
    }

    const body = buildCodexRequest({ ...req, model: this.modelId }, {
      sessionId,
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
    });
    const headerParams: CodexHeaderParams = { token, accountId, sessionId };

    if (this.transport === "sse") {
      yield* this.streamSse(body, headerParams, req.abort);
      return;
    }

    // WebSocket / auto.
    let started = false;
    try {
      yield* this.streamWs(body, headerParams, req.abort, () => {
        started = true;
      });
    } catch (err) {
      this.resetWs();
      // A user-cancelled turn is not a failure — the engine owns abort. Don't
      // emit a retryable error (which would drive a spurious retry).
      if (req.abort?.aborted) return;
      // Only fall back to SSE if nothing was emitted yet (can't un-yield).
      if (this.transport === "auto" && !started) {
        yield* this.streamSse(body, headerParams, req.abort);
        return;
      }
      yield { type: "error", code: "transport", message: errMsg(err), retryable: true, cause: err };
    }
  }

  /** Close any open WS connection. Safe to call multiple times. */
  dispose(): void {
    this.resetWs();
  }

  // -------------------------------------------------------------------------
  // SSE transport
  // -------------------------------------------------------------------------

  private async *streamSse(
    body: CodexRequestBody,
    headerParams: CodexHeaderParams,
    abort: AbortSignal | undefined,
  ): AsyncGenerator<ProviderEvent> {
    const headers = buildCodexHeaders(headerParams);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(abort !== undefined ? { signal: abort } : {}),
      });
    } catch (err) {
      yield { type: "error", code: "transport", message: errMsg(err), retryable: true, cause: err };
      return;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const { error, friendlyMessage } = classifyCodexHttpError(res.status, raw);
      yield {
        type: "error",
        code: error.code,
        message: friendlyMessage ?? error.message,
        retryable: error.retryable,
        ...(error.cause !== undefined ? { cause: error.cause } : {}),
      };
      return;
    }
    if (res.body === null) {
      yield { type: "error", code: "transport", message: "empty response body", retryable: true };
      return;
    }

    const translator = new CodexEventTranslator();
    const bytes = res.body as unknown as AsyncIterable<Uint8Array>;
    let sawTerminal = false;
    try {
      for await (const ev of parseCodexSse(bytes)) {
        for (const out of translator.translate(ev)) {
          if (out.type === "finish" || out.type === "error") sawTerminal = true;
          yield out;
        }
      }
    } catch (err) {
      yield { type: "error", code: "transport", message: errMsg(err), retryable: true, cause: err };
      return;
    }
    if (!sawTerminal) {
      yield { type: "error", code: "transport", message: "codex stream ended without a terminal event", retryable: true };
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket transport (delta / continuation)
  // -------------------------------------------------------------------------

  private async *streamWs(
    body: CodexRequestBody,
    headerParams: CodexHeaderParams,
    abort: AbortSignal | undefined,
    onStart: () => void,
  ): AsyncGenerator<ProviderEvent> {
    this.clearIdle();
    if (!isWebSocketReusable(this.ws)) {
      const url = resolveCodexWsUrl(this.endpoint);
      const headers = buildCodexWsHeaders(headerParams);
      this.ws = await this.wsConnect(url, headers, abort);
      // A fresh connection has no server-side context → next send is full.
      this.continuation = null;
    }
    const socket = this.ws!;

    // Delta when the request provably continues the last turn; else full body.
    const turnBody = buildWsTurnBody(body, this.continuation);
    socket.send(JSON.stringify({ type: "response.create", ...turnBody }));

    const translator = new CodexEventTranslator();
    const assistant: AssistantAcc[] = [];
    let responseId: string | undefined;
    let sawError = false;

    try {
      for await (const raw of parseCodexWs(socket, abort)) {
        const id = responseIdOf(raw);
        if (id !== undefined) responseId = id;
        for (const out of translator.translate(raw)) {
          onStart();
          accumulateAssistant(assistant, out);
          if (out.type === "error") sawError = true;
          yield out;
        }
      }
    } catch (err) {
      // The connection is dead/inconsistent — drop it so the next turn reconnects.
      this.resetWs();
      throw err instanceof Error ? err : new Error(String(err));
    }

    // Record continuation so the next turn can send only the delta. The server
    // holds [lastInput + this response] connection-scoped via previous_response_id.
    if (responseId !== undefined && !sawError) {
      this.continuation = {
        lastBodyKey: wsBodyKey(body),
        lastInput: body.input,
        lastResponseItems: assistantContentToCodexInput(
          assistant as Parameters<typeof assistantContentToCodexInput>[0],
        ),
        lastResponseId: responseId,
      };
    } else {
      this.continuation = null;
    }
    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.resetWs(), WS_IDLE_TTL_MS);
    // Never keep the process alive just for the idle socket.
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private resetWs(): void {
    this.clearIdle();
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "done");
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.continuation = null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
