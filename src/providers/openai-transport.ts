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
import { normalizeProviderOptions } from "./openai-quirks.js";
import { providerMessagesToVercel } from "./message-replay.js";
import { toolSpecsToVercelTools } from "./tool-translation.js";
import { mapVercelUsage } from "./vercel-usage.js";
import { classifyProviderError } from "./error-classifier.js";
import { toolChoiceOption } from "./tool-choice.js";
import { getOpenAIModelCapability } from "./capability-catalog.js";

// ---------------------------------------------------------------------------
// Capabilities helper
// ---------------------------------------------------------------------------

function computeCapabilities(modelId: string): ProviderCapabilities {
  const cap = getOpenAIModelCapability(modelId);
  return {
    streaming: true,
    promptCache: cap.promptCache,
    parallelToolUse: cap.parallelToolUse,
    vision: cap.imageIn,
    reasoning: cap.thinking,
    maxContextTokens: cap.maxContextTokens,
    maxOutputTokens: cap.maxOutputTokens,
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

    // OpenAI prompt-cache eviction hint: per-session stable key keeps cache
    // entries warm across turns. Capability-gated so we don't send it to
    // legacy models that ignore (or error on) the field.
    const providerOptions =
      req.sessionId !== undefined && this.capabilities.promptCache
        ? { openai: { promptCacheKey: req.sessionId } }
        : undefined;

    const result = streamText({
      model: this.model,
      messages: providerMessagesToVercel(req.messages),
      ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
      tools: toolSpecsToVercelTools(req.tools ?? []),
      ...toolChoiceOption(req),
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
            usage: mapVercelUsage(usage),
          };
          break;
        }

        case "error":
          yield { type: "error", ...classifyProviderError(part.error) };
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
