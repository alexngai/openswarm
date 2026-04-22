/**
 * DashScopeTransportProvider — Vercel AI SDK v6 transport for DashScope
 * (Alibaba Cloud) via OpenAI-compatible endpoint.
 *
 * Uses createOpenAI with a custom baseURL. Implements the preflight hook
 * to enforce the 6 MB body cap.
 *
 * Use the async factory `DashScopeTransportProvider.create()` — it verifies
 * auth before construction. The constructor is private.
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
  ProviderMessage,
} from "./index.js";
import type { StopReason, ProviderError } from "../core/types.js";
import { providerMessagesToVercel } from "./message-replay.js";
import { toolSpecsToVercelTools } from "./tool-translation.js";
import { dashscopePreflight } from "./dashscope-preflight.js";

const DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

// ---------------------------------------------------------------------------
// Capabilities helper
// ---------------------------------------------------------------------------

function computeCapabilities(modelId: string): ProviderCapabilities {
  const id = modelId.toLowerCase();

  if (id.startsWith("kimi")) {
    return {
      streaming: true,
      promptCache: false,
      parallelToolUse: false,
      vision: false,
      reasoning: false,
      maxContextTokens: 131_072,
      maxOutputTokens: 8_192,
    };
  }

  // qwen-plus, qwen-max, etc.
  return {
    streaming: true,
    promptCache: false,
    parallelToolUse: true,
    vision: false,
    reasoning: false,
    maxContextTokens: 131_072,
    maxOutputTokens: 8_192,
  };
}

// ---------------------------------------------------------------------------
// Kimi is_error strip
// ---------------------------------------------------------------------------

/**
 * For Kimi models: strip `is_error` key from tool_result blocks in user messages.
 * Kimi does not support this field and rejects requests that include it.
 * Phase 6 will centralize this quirk; for now it's inlined here.
 */
function stripKimiIsError(messages: readonly ProviderMessage[]): readonly ProviderMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block.type !== "tool_result") return block;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { is_error: _removed, ...rest } = block;
        return rest as typeof block;
      }),
    };
  });
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

export class DashScopeTransportProvider implements TransportProvider {
  readonly kind = "transport" as const;
  readonly id = "dashscope";
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;

  private readonly auth: AuthSource;
  private readonly modelId: string;

  private constructor(auth: AuthSource, modelId: string) {
    this.auth = auth;
    // Defense-in-depth: strip qwen/ or kimi/ prefix if still present
    this.modelId = modelId.replace(/^(qwen|kimi)\//, "");
    const client = createOpenAI({
      apiKey: process.env["DASHSCOPE_API_KEY"] ?? "",
      baseURL: DASHSCOPE_BASE_URL,
    });
    this.model = client(this.modelId) as LanguageModel;
    this.capabilities = computeCapabilities(this.modelId);
  }

  /**
   * Async factory — verifies DASHSCOPE_API_KEY is present before returning.
   */
  static async create(auth: AuthSource, modelId: string): Promise<DashScopeTransportProvider> {
    if (!(await auth.isAuthenticated())) {
      throw new Error(
        "error: DashScopeTransportProvider requires DASHSCOPE_API_KEY env var. Set it and retry."
      );
    }
    return new DashScopeTransportProvider(auth, modelId);
  }

  /**
   * Preflight hook: rejects requests that exceed the 6 MB DashScope body cap.
   */
  preflight(req: ProviderRequest): ProviderError | null {
    return dashscopePreflight(req);
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const isKimi = this.modelId.toLowerCase().startsWith("kimi");
    const messages = isKimi ? stripKimiIsError(req.messages) : req.messages;

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
      messages: providerMessagesToVercel(messages),
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
