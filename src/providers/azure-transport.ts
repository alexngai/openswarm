/**
 * AzureTransportProvider — Vercel AI SDK transport for Azure OpenAI, calling
 * Azure DIRECTLY (no gateway). openswarm agents run inside remote E2B
 * sandboxes that have internet but cannot reach a local gateway, so this
 * transport talks straight to the Azure OpenAI deployment endpoint.
 *
 * Azure's chat-completions URL shape is:
 *   ${AZURE_API_BASE}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}
 *
 * We point the OpenAI-compatible client's baseURL at
 *   ${AZURE_API_BASE}/openai/deployments/${deployment}
 * send the `api-key: ${AZURE_OPENAI_API_KEY}` header, and inject the
 * `?api-version=...` query param on every request via a wrapped fetch.
 *
 * Config (env):
 *   AZURE_API_BASE (or AZURE_OPENAI_ENDPOINT) — endpoint base, e.g. https://my-res.openai.azure.com
 *   AZURE_OPENAI_API_KEY                       — the Azure resource api-key
 *   AZURE_OPENAI_API_VERSION                   — optional, defaults to 2024-08-01-preview
 *
 * The model/deployment name is the deployment (e.g. gpt-4.1).
 *
 * Modeled on LiteLLMTransportProvider / DashScopeTransportProvider (the other
 * OpenAI-compat transports). Use the async factory `AzureTransportProvider.create()`.
 */

import { streamText, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import type { FinishReason } from "ai";
import type { AuthSource } from "../auth/index.js";
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "./index.js";
import type { StopReason } from "../core/types.js";
import { providerMessagesToVercel } from "./message-replay.js";
import { toolSpecsToVercelTools } from "./tool-translation.js";
import { mapVercelUsage } from "./vercel-usage.js";
import { classifyProviderError } from "./error-classifier.js";

const DEFAULT_API_VERSION = "2024-08-01-preview";

/** Generic capabilities — the deployment is arbitrary, so assume the common SWE-agent baseline. */
function defaultCapabilities(): ProviderCapabilities {
  return {
    streaming: true,
    // Azure OpenAI caches prompts and reports `cached_tokens`, but ONLY reliably
    // when `prompt_cache_key` routes repeat prefixes to the same replica — probed
    // 2026-07-09 on gpt-5.5: identical back-to-back requests hit 0% without the
    // key and ~92% with it (docs/53). promptCache: false here silently disabled
    // the key and made every mono-large eval token full-price.
    promptCache: true,
    parallelToolUse: true,
    vision: false,
    reasoning: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
  };
}

/** Read the Azure endpoint base, trimming any trailing slash. */
export function azureApiBaseFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env["AZURE_API_BASE"] ?? env["AZURE_OPENAI_ENDPOINT"])?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

export function azureApiVersionFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env["AZURE_OPENAI_API_VERSION"]?.trim() || DEFAULT_API_VERSION;
}

/**
 * Wrap fetch so every request carries `?api-version=...` (Azure requires it as a
 * query param) and the `api-key` header (Azure's auth wire format — not a Bearer
 * token). Adds the query param only if not already present.
 */
export function azureFetch(apiVersion: string, apiKey: string): typeof fetch {
  return (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input.toString() : (input as Request).url,
    );
    if (!url.searchParams.has("api-version")) {
      url.searchParams.set("api-version", apiVersion);
    }
    const headers = new Headers(init?.headers);
    headers.set("api-key", apiKey);
    // Azure rejects an Authorization header alongside api-key in some configs; drop it.
    headers.delete("authorization");
    return globalThis.fetch(url.toString(), { ...init, headers });
  };
}

function mapFinishReason(reason: FinishReason): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
    case "error":
    case "other":
      return "error";
    default: {
      const _: never = reason;
      void _;
      return "error";
    }
  }
}

export class AzureTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "azure";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly deployment: string;

  private constructor(auth: AuthSource, deployment: string) {
    this.auth = auth;
    this.deployment = deployment;
    const apiBase = azureApiBaseFromEnv() ?? "";
    const apiVersion = azureApiVersionFromEnv();
    const apiKey = process.env["AZURE_OPENAI_API_KEY"] ?? "";
    const baseURL = `${apiBase}/openai/deployments/${deployment}`;
    const client = createOpenAI({
      // apiKey is supplied via the api-key header in azureFetch; this value is
      // unused on the wire but createOpenAI requires a non-empty key to init.
      apiKey,
      baseURL,
      fetch: azureFetch(apiVersion, apiKey),
    });
    // Azure deployments are addressed by deployment name; baseURL already encodes
    // it, so the model path segment Azure ignores — but the OpenAI-compat client
    // still appends /chat/completions, which is exactly Azure's shape.
    this.model = client.chat(deployment) as LanguageModel;
    this.capabilities = defaultCapabilities();
  }

  /** Async factory — verifies AZURE_API_BASE + AZURE_OPENAI_API_KEY are present. */
  static async create(auth: AuthSource, deployment: string): Promise<AzureTransportProvider> {
    if (!azureApiBaseFromEnv()) {
      throw new Error(
        "error: AzureTransportProvider requires AZURE_API_BASE (or AZURE_OPENAI_ENDPOINT) env var (the Azure OpenAI endpoint base). Set it and retry.",
      );
    }
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: AzureTransportProvider requires AZURE_OPENAI_API_KEY env var. Set it and retry.",
      );
    }
    return new AzureTransportProvider(auth, deployment);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const systemPrompt: string | undefined = req.systemPrompt
      ? Array.isArray(req.systemPrompt)
        ? (req.systemPrompt as readonly string[]).join("")
        : (req.systemPrompt as string)
      : undefined;

    const extraOptions: Record<string, unknown> = {};
    if (req.maxOutputTokens !== undefined) extraOptions["maxOutputTokens"] = req.maxOutputTokens;
    if (req.temperature !== undefined) extraOptions["temperature"] = req.temperature;
    if (req.topP !== undefined) extraOptions["topP"] = req.topP;

    // Prompt-cache routing hint (mirrors openai-transport): a per-session stable
    // key keeps repeat prefixes on the same replica. Without it this deployment's
    // hit rate is ~0 (see defaultCapabilities note).
    const providerOptions =
      req.sessionId !== undefined && this.capabilities.promptCache
        ? { openai: { promptCacheKey: req.sessionId } }
        : undefined;

    const result = streamText({
      model: this.model,
      messages: providerMessagesToVercel(req.messages),
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      tools: toolSpecsToVercelTools(req.tools ?? []),
      ...(req.abort !== undefined ? { abortSignal: req.abort } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      ...extraOptions,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          yield { type: "text-delta", text: part.text };
          break;
        case "reasoning-delta":
          yield { type: "reasoning-delta", text: part.text };
          break;
        case "tool-input-start":
          yield { type: "tool-input-start", id: part.id, name: part.toolName };
          break;
        case "tool-input-delta":
          yield { type: "tool-input-delta", id: part.id, delta: part.delta };
          break;
        case "tool-call":
          yield { type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input };
          break;
        case "finish": {
          const usage = part.totalUsage;
          yield {
            type: "finish",
            stopReason: mapFinishReason(part.finishReason),
            usage: mapVercelUsage(usage),
          };
          break;
        }
        case "error":
          yield { type: "error", ...classifyProviderError(part.error) };
          break;
        case "start":
        case "start-step":
        case "finish-step":
        case "text-start":
        case "text-end":
        case "reasoning-start":
        case "reasoning-end":
        case "tool-input-end":
        case "tool-result":
        case "tool-error":
        case "tool-output-denied":
        case "tool-approval-request":
        case "source":
        case "file":
        case "raw":
        case "abort":
          break;
        default: {
          const _: never = part;
          void _;
        }
      }
    }
  }
}
