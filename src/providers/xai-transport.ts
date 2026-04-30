/**
 * XaiTransportProvider — Vercel AI SDK v6 transport for xAI (Grok) models.
 *
 * Implements TransportProvider; wraps streamText() and translates the
 * TextStreamPart union into our ProviderEvent shape.
 *
 * Use the async factory `XaiTransportProvider.create()` — it verifies auth
 * before construction. The constructor is private.
 */

import { streamText, type LanguageModel } from "ai";
import { createXai } from "@ai-sdk/xai";
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

// ---------------------------------------------------------------------------
// Reasoning model detection
// ---------------------------------------------------------------------------

function isXaiReasoningModel(modelId: string): boolean {
  return /^grok-3-mini/i.test(modelId);
}

// ---------------------------------------------------------------------------
// Capabilities helper
// ---------------------------------------------------------------------------

function computeCapabilities(modelId: string): ProviderCapabilities {
  const isReasoning = isXaiReasoningModel(modelId);

  let parallelToolUse = true;
  if (isReasoning) {
    parallelToolUse = false;
  }

  return {
    streaming: true,
    promptCache: false,
    parallelToolUse,
    vision: false,
    reasoning: isReasoning,
    maxContextTokens: 131_072,
    maxOutputTokens: 64_000,
  };
}

// ---------------------------------------------------------------------------
// Parameter normalisation for reasoning models
// ---------------------------------------------------------------------------

function normalizeXaiOptions(req: ProviderRequest, modelId: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (isXaiReasoningModel(modelId)) {
    // Reasoning models: strip temperature/topP/topK/presencePenalty/frequencyPenalty
    if (req.maxOutputTokens !== undefined) result["maxOutputTokens"] = req.maxOutputTokens;
  } else {
    if (req.maxOutputTokens !== undefined) result["maxOutputTokens"] = req.maxOutputTokens;
    if (req.temperature !== undefined) result["temperature"] = req.temperature;
    if (req.topP !== undefined) result["topP"] = req.topP;
    if (req.topK !== undefined) result["topK"] = req.topK;
  }

  return result;
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
      const _: never = reason;
      void _;
      return "error";
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class XaiTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "xai";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly modelId: string;

  private constructor(auth: AuthSource, modelId: string) {
    this.auth = auth;
    this.modelId = modelId;
    const client = createXai({ apiKey: process.env["XAI_API_KEY"] ?? "" });
    this.model = client(modelId) as LanguageModel;
    this.capabilities = computeCapabilities(modelId);
  }

  /**
   * Async factory — verifies XAI_API_KEY is present before returning.
   */
  static async create(auth: AuthSource, modelId: string): Promise<XaiTransportProvider> {
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: XaiTransportProvider requires XAI_API_KEY env var. Set it and retry."
      );
    }
    return new XaiTransportProvider(auth, modelId);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const systemPrompt: string | undefined = req.systemPrompt
      ? Array.isArray(req.systemPrompt)
        ? (req.systemPrompt as readonly string[]).join("")
        : (req.systemPrompt as string)
      : undefined;

    const extraOptions = normalizeXaiOptions(req, this.modelId);

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
