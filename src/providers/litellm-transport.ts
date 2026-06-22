/**
 * LiteLLMTransportProvider — Vercel AI SDK transport for a LiteLLM gateway
 * (OpenAI-compatible /v1). One endpoint, many providers: the gateway routes the
 * model name to Bedrock / Azure OpenAI / OpenAI-compatible open-weight (vLLM,
 * Together) deployments, so swarm-harness reaches all of them through a single
 * `litellm/<gateway-model-name>` model id without native Bedrock/Azure transports.
 *
 * Config (env):
 *   LITELLM_BASE_URL  — the gateway base URL, e.g. http://127.0.0.1:4000/v1 (must end in /v1)
 *   LITELLM_API_KEY   — the gateway master key (or a per-run virtual key)
 *
 * Modeled on DashScopeTransportProvider (the other OpenAI-compat transport).
 * Use the async factory `LiteLLMTransportProvider.create()`.
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
import { classifyProviderError } from "./error-classifier.js";

/** Generic capabilities — the gateway model is arbitrary, so assume the common SWE-agent baseline. */
function defaultCapabilities(): ProviderCapabilities {
  return {
    streaming: true,
    promptCache: false,
    parallelToolUse: true,
    vision: false,
    reasoning: false,
    maxContextTokens: 200_000,
    maxOutputTokens: 8_192,
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

export class LiteLLMTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "litellm";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly modelId: string;

  private constructor(auth: AuthSource, modelId: string) {
    this.auth = auth;
    this.modelId = modelId;
    const baseURL = process.env["LITELLM_BASE_URL"] ?? "";
    const client = createOpenAI({
      apiKey: process.env["LITELLM_API_KEY"] ?? "",
      baseURL,
    });
    this.model = client(this.modelId) as LanguageModel;
    this.capabilities = defaultCapabilities();
  }

  /** Async factory — verifies LITELLM_BASE_URL + LITELLM_API_KEY are present. */
  static async create(auth: AuthSource, modelId: string): Promise<LiteLLMTransportProvider> {
    if (!process.env["LITELLM_BASE_URL"]) {
      throw new Error(
        "error: LiteLLMTransportProvider requires LITELLM_BASE_URL env var (the gateway /v1 URL). Set it and retry.",
      );
    }
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: LiteLLMTransportProvider requires LITELLM_API_KEY env var. Set it and retry.",
      );
    }
    return new LiteLLMTransportProvider(auth, modelId);
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

    const result = streamText({
      model: this.model,
      messages: providerMessagesToVercel(req.messages),
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      tools: toolSpecsToVercelTools(req.tools ?? []),
      ...(req.abort !== undefined ? { abortSignal: req.abort } : {}),
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
            usage: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              ...(usage.inputTokenDetails?.cacheReadTokens !== undefined
                ? { cacheReadInputTokens: usage.inputTokenDetails.cacheReadTokens }
                : {}),
            },
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
