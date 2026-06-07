/**
 * CodexResponsesTransportProvider — in-process provider for ChatGPT
 * subscription plans via the codex backend Responses API.
 *
 * Owns its own HTTPS + SSE transport (it does NOT use the Vercel AI SDK /
 * `streamText`) because the codex backend is not AI-SDK-compatible — see
 * docs/42. Composes the protocol-core modules: request-builder → fetch →
 * parseCodexSse → CodexEventTranslator, with error classification.
 *
 * Plugs into NativeEngine / HardenedNativeEngine through the standard
 * `Provider.stream()` seam; `Provider.model` is intentionally omitted.
 */

import { randomUUID } from "node:crypto";
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "../index.js";
import { buildCodexRequest } from "./request-builder.js";
import { buildCodexHeaders } from "./headers.js";
import { parseCodexSse } from "./sse.js";
import { CodexEventTranslator } from "./events.js";
import { classifyCodexHttpError } from "./errors.js";
import type { CodexReasoningConfig } from "./types.js";

const DEFAULT_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/**
 * Supplies a fresh bearer token + account id at request time. Implementations
 * own refresh (the OAuth AuthSource, or a dev source reading codex's token).
 */
export interface CodexCredentialSource {
  getCredentials(): Promise<{ token: string; accountId: string }>;
}

export interface CodexResponsesProviderOptions {
  readonly modelId: string;
  readonly credentials: CodexCredentialSource;
  readonly reasoning?: CodexReasoningConfig;
  readonly endpoint?: string;
  /** Stable id for cache affinity when a request omits sessionId. */
  readonly sessionId?: string;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
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
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CodexResponsesProviderOptions) {
    this.modelId = opts.modelId;
    this.credentials = opts.credentials;
    this.reasoning = opts.reasoning;
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.fallbackSessionId = opts.sessionId ?? randomUUID();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    // Pin a stable session id for the whole session → ~96% prefix caching on
    // repeat turns (docs/42 §6.2). Prefer the engine's sessionId; fall back to
    // this provider instance's id (one instance == one session via makeEngine).
    const sessionId = req.sessionId ?? this.fallbackSessionId;

    let token: string;
    let accountId: string;
    try {
      ({ token, accountId } = await this.credentials.getCredentials());
    } catch (err) {
      yield {
        type: "error",
        code: "auth",
        message: `codex credentials unavailable: ${errMsg(err)}`,
        retryable: false,
        cause: err,
      };
      return;
    }

    const body = buildCodexRequest({ ...req, model: this.modelId }, {
      sessionId,
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
    });
    const headers = buildCodexHeaders({ token, accountId, sessionId });

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(req.abort !== undefined ? { signal: req.abort } : {}),
      });
    } catch (err) {
      yield {
        type: "error",
        code: "transport",
        message: errMsg(err),
        retryable: true,
        cause: err,
      };
      return;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      const { error, friendlyMessage } = classifyCodexHttpError(res.status, raw);
      yield {
        type: "error",
        code: error.code,
        // Prefer the actionable, user-facing message (e.g. "run login",
        // "retry in ~N min") over the raw backend string when available.
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
    // Node's fetch Response.body is async-iterable at runtime (Node 20+); the
    // DOM type doesn't advertise it, hence the cast.
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
      // A mid-stream read/connection failure: surface as a retryable error event
      // (contract parity with openai-transport — never throw out of stream()).
      yield { type: "error", code: "transport", message: errMsg(err), retryable: true, cause: err };
      return;
    }
    if (!sawTerminal) {
      // Stream closed cleanly but no response.completed/failed arrived (truncation)
      // — retry rather than silently accept a truncated turn as end_turn.
      yield {
        type: "error",
        code: "transport",
        message: "codex stream ended without a terminal event",
        retryable: true,
      };
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
