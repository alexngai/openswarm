/**
 * OpenAITransportProvider — Vercel AI SDK v6 transport for OpenAI models.
 *
 * Implements TransportProvider; wraps streamText() and translates the
 * TextStreamPart union into our ProviderEvent shape.
 *
 * Use the async factory `OpenAITransportProvider.create()` — it verifies auth
 * before construction. The constructor is private.
 */

import { streamText, type LanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import type { FinishReason } from "ai";
import type { AuthSource } from "../auth/index.js";
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
} from "./index.js";
import type { StopReason } from "../core/types.js";
import { isReasoningModel, isGpt5, normalizeProviderOptions } from "./openai-quirks.js";
import { providerMessagesToVercel } from "./message-replay.js";
import { toolSpecsToVercelTools } from "./tool-translation.js";

// ---------------------------------------------------------------------------
// Capabilities helper
// ---------------------------------------------------------------------------

function computeCapabilities(modelId: string): ProviderCapabilities {
  const id = modelId.toLowerCase();
  const isReasoning = isReasoningModel(modelId);
  const isGpt5Model = isGpt5(modelId);

  // Vision: gpt-4o family, gpt-5 family, gpt-4-vision; not o-series
  const vision =
    !isReasoning &&
    (id.startsWith("gpt-4o") ||
      id.startsWith("gpt-5") ||
      id.includes("gpt-4-vision") ||
      id.includes("gpt-4v"));

  // maxContextTokens estimates per model family
  let maxContextTokens = 128_000; // default (gpt-4o)
  if (isGpt5Model || id.startsWith("gpt-5")) {
    maxContextTokens = 400_000;
  } else if (isReasoning) {
    maxContextTokens = 200_000;
  }

  return {
    streaming: true,
    promptCache: false, // M4a: disabled; wiring deferred to M4b
    parallelToolUse: true,
    vision,
    reasoning: isReasoning,
    maxContextTokens,
    maxOutputTokens: 16_384,
  };
}

// ---------------------------------------------------------------------------
// FinishReason → StopReason mapping
// ---------------------------------------------------------------------------

function mapFinishReason(reason: FinishReason): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool-calls":
      return "tool_use";
    case "content-filter":
      return "error";
    case "error":
      return "error";
    case "other":
      return "error";
    default: {
      // Exhaustive guard — FinishReason is a closed union
      const _: never = reason;
      void _;
      return "error";
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OpenAITransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "openai";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly modelId: string;

  private constructor(auth: AuthSource, modelId: string) {
    this.auth = auth;
    this.modelId = modelId;
    this.model = openai(modelId) as LanguageModel;
    this.capabilities = computeCapabilities(modelId);
  }

  /**
   * Async factory — verifies OPENAI_API_KEY is present before returning.
   * Throws a user-facing error with the exact message from AC 23a.
   */
  static async create(
    auth: AuthSource,
    modelId: string
  ): Promise<OpenAITransportProvider> {
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: OpenAITransportProvider requires OPENAI_API_KEY env var. Set it and retry."
      );
    }
    return new OpenAITransportProvider(auth, modelId);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const systemPrompt: string | undefined = req.systemPrompt
      ? Array.isArray(req.systemPrompt)
        ? (req.systemPrompt as readonly string[]).join("")
        : (req.systemPrompt as string)
      : undefined;

    const extraOptions = normalizeProviderOptions(req, this.modelId);

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
          yield {
            type: "tool-call",
            id: part.toolCallId,
            name: part.toolName,
            input: part.input,
          };
          break;

        case "finish": {
          const stopReason = mapFinishReason(part.finishReason);
          const usage = part.totalUsage;
          yield {
            type: "finish",
            stopReason,
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
          yield {
            type: "error",
            code: "provider",
            message: String(part.error),
            retryable: false,
          };
          break;

        // Lifecycle and other frames we don't consume in M4a
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
          // Exhaustive guard for forward-compat
          const _: never = part;
          void _;
        }
      }
    }
  }
}
