/**
 * BedrockTransportProvider — Vercel AI SDK v6 transport for AWS Bedrock
 * open-weight models (Meta Llama, Amazon Nova) via the native Converse API.
 *
 * Uses createAmazonBedrock with bearer-token auth (AWS_BEARER_TOKEN_BEDROCK).
 * When `apiKey` is supplied it takes precedence over AWS SigV4, so no AWS
 * access keys are required.
 *
 * Use the async factory `BedrockTransportProvider.create()` — it verifies
 * auth before construction. The constructor is private.
 */

import { streamText, type LanguageModel } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
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
import { getBedrockModelCapability } from "./capability-catalog.js";

const DEFAULT_REGION = "us-east-1";

// ---------------------------------------------------------------------------
// Capabilities helper
// ---------------------------------------------------------------------------

function computeCapabilities(modelId: string): ProviderCapabilities {
  const cap = getBedrockModelCapability(modelId);
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
      const _: never = reason;
      void _;
      return "error";
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class BedrockTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "bedrock";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly modelId: string;

  private constructor(auth: AuthSource, modelId: string) {
    this.auth = auth;
    // Defense-in-depth: strip awsbedrock/ prefix if still present.
    this.modelId = modelId.replace(/^awsbedrock\//, "");
    const client = createAmazonBedrock({
      apiKey: process.env["AWS_BEARER_TOKEN_BEDROCK"] ?? "",
      region: process.env["AWS_REGION"] ?? DEFAULT_REGION,
    });
    this.model = client(this.modelId) as LanguageModel;
    this.capabilities = computeCapabilities(this.modelId);
  }

  /**
   * Async factory — verifies AWS_BEARER_TOKEN_BEDROCK is present before returning.
   */
  static async create(auth: AuthSource, modelId: string): Promise<BedrockTransportProvider> {
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: BedrockTransportProvider requires AWS_BEARER_TOKEN_BEDROCK env var. Set it and retry."
      );
    }
    return new BedrockTransportProvider(auth, modelId);
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
