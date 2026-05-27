/**
 * GoogleTransportProvider — Vercel AI SDK v6 transport for Google Gemini models.
 *
 * Implements TransportProvider; wraps streamText() and translates the
 * TextStreamPart union into our ProviderEvent shape.
 *
 * Use the async factory `GoogleTransportProvider.create()` — it verifies auth
 * before construction. The constructor is private.
 */

import { streamText, type LanguageModel } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
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

// ---------------------------------------------------------------------------
// Capabilities helper
// ---------------------------------------------------------------------------

function computeCapabilities(modelId: string): ProviderCapabilities {
  const id = modelId.toLowerCase();

  // Vision: Gemini models support vision
  const vision = id.startsWith("gemini-");

  return {
    streaming: true,
    promptCache: false,
    // Conservative: parallelToolUse false until live-verified with Gemini.
    // TODO(M4b): upgrade to true after AC 23 live smoke confirms parallel tool support.
    parallelToolUse: false,
    vision,
    reasoning: false,
    maxContextTokens: 1_048_576,
    maxOutputTokens: 8_192,
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
      const _: never = reason;
      void _;
      return "error";
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class GoogleTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "google";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly modelId: string;

  private constructor(auth: AuthSource, modelId: string) {
    this.auth = auth;
    this.modelId = modelId;
    const client = createGoogleGenerativeAI({
      apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "",
    });
    this.model = client(modelId) as LanguageModel;
    this.capabilities = computeCapabilities(modelId);
  }

  /**
   * Async factory — verifies GOOGLE_GENERATIVE_AI_API_KEY is present before returning.
   */
  static async create(auth: AuthSource, modelId: string): Promise<GoogleTransportProvider> {
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: GoogleTransportProvider requires GOOGLE_GENERATIVE_AI_API_KEY env var. Set it and retry."
      );
    }
    return new GoogleTransportProvider(auth, modelId);
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
    if (req.topK !== undefined) extraOptions["topK"] = req.topK;

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
