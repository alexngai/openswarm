/**
 * Provider — finer-grained LLM transport abstraction.
 *
 * M4a: promoted from stub to real interfaces. Consumed by NativeEngine
 * (`src/engine/native.ts`). `ClaudeAgentSdkEngine` still bypasses this layer.
 *
 * TransportProvider wraps Vercel AI SDK; future FrameworkProvider (M4b)
 * wraps framework-specific clients (Claude Agent SDK, Codex App Server).
 *
 * See docs/03-interfaces.md §2 and docs/13-m4a-plan.md.
 */

import type { LanguageModel } from "ai";
import type { ToolSpec, StopReason, Usage, ProviderError } from "../core/types.js";
import type { AuthSource } from "../auth/index.js";

// ---------------------------------------------------------------------------
// Core Provider interface
// ---------------------------------------------------------------------------

export interface Provider {
  /** Stable id: "anthropic" | "openai" | "google" | "xai" | "openai-compat" | "codex-chatgpt". */
  readonly id: string;
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;
  /**
   * Stream a single provider turn. Yields ProviderEvents that NativeEngine
   * translates to NormalizedEvents. The async iterator completes when the
   * provider emits a `finish` or `error` event.
   */
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
  /**
   * Optional preflight hook. Return `null` to proceed, or a ProviderError
   * to short-circuit the request before any network I/O (M4b §0.1).
   * Used by DashScope to enforce the 6 MB body-size cap.
   */
  preflight?(request: ProviderRequest): ProviderError | null;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly promptCache: boolean;
  readonly parallelToolUse: boolean;
  readonly vision: boolean;
  /** Reasoning-model support (o1*, o3*, etc.); surfaces reasoning-delta events. */
  readonly reasoning: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Marker interface for providers that speak through the Vercel AI SDK.
 * Contrast with a future `FrameworkProvider` (M4b) for Claude-Agent-SDK /
 * Codex App Server paths that own their own transport.
 */
export interface TransportProvider extends Provider {
  readonly kind: "transport";
}

// ---------------------------------------------------------------------------
// ProviderRequest / ProviderEvent
// ---------------------------------------------------------------------------

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  /** Dispatcher-filtered already (role allowlists applied upstream). */
  readonly tools?: readonly ToolSpec[];
  readonly systemPrompt?: string | readonly string[];
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stop?: readonly string[];
  readonly abort?: AbortSignal;
  readonly toolChoice?: "auto" | "required" | "none" | { name: string };
  /** Hint: prefer caching the prefix of systemPrompt. Provider may ignore. */
  readonly promptCacheHint?: boolean;
}

/**
 * Provider-level streaming event. A semantic rename of the subset of the
 * Vercel AI SDK's `TextStreamPart` union that NativeEngine consumes.
 *
 * Names match the SDK's `part.type` discriminator values exactly (see
 * .omc/research/vercel-sdk-spike.md). NativeEngine translates this to
 * our NormalizedEvent shape (src/core/types.ts).
 */
export type ProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-input-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-input-delta"; readonly id: string; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "finish";
      readonly stopReason: StopReason;
      readonly usage: Usage;
    }
  | {
      readonly type: "error";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * ProviderMessage mirrors the subset of NormalizedEvent we replay back to
 * the provider. Converted to the SDK's `ModelMessage` shape via
 * `providerMessagesToVercel()` inside each TransportProvider.
 */
export type ProviderMessage =
  | {
      readonly role: "system";
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
    }
  | {
      readonly role: "user";
      readonly content: readonly (
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "tool_result";
            readonly tool_use_id: string;
            readonly content: string;
            readonly is_error?: boolean;
          }
      )[];
    }
  | {
      readonly role: "assistant";
      readonly content: readonly (
        | { readonly type: "text"; readonly text: string }
        | {
            readonly type: "tool_use";
            readonly id: string;
            readonly name: string;
            readonly input: unknown;
          }
      )[];
    };

// ---------------------------------------------------------------------------
// Routing — resolve model id → provider/engine factory
// ---------------------------------------------------------------------------

/**
 * Result of `resolveProvider(modelId)`. Outer code uses `kind` to decide:
 *   - "native" → construct TransportProvider via providerFactory + wrap in NativeEngine
 *   - "sdk"    → use engineFactory (ClaudeAgentSdkEngine)
 *   - "error"  → show `message` to user, exit non-zero
 */
export interface ResolvedProvider {
  readonly kind: "native" | "sdk" | "error";
  readonly providerFactory?: (auth: AuthSource, modelId: string) => Provider | Promise<Provider>;
  readonly engineFactory?: () => import("../engine/index.js").AgentEngine;
  readonly modelId?: string;
  readonly message?: string;
}
