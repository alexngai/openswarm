/**
 * Provider — finer-grained LLM transport abstraction.
 *
 * M4a: promoted from stub to real interfaces. Consumed by NativeEngine
 * (`src/engine/native.ts`). `ClaudeAgentSdkEngine` still bypasses this layer.
 *
 * TransportProvider wraps Vercel AI SDK; future FrameworkProvider (M4b)
 * wraps framework-specific clients (Claude Agent SDK, Codex App Server).
 *
 * See docs/03-interfaces.md §2 and docs/archive/13-m4a-plan.md.
 */

import type { LanguageModel } from "ai";
import type { ToolSpec, StopReason, Usage, ProviderError } from "../core/types.js";
import type { AuthSource } from "../auth/index.js";

// ---------------------------------------------------------------------------
// Core Provider interface
// ---------------------------------------------------------------------------

export interface Provider {
  /** Stable id: "anthropic" | "openai" | "google" | "xai" | "openai-compat" | "openai-codex". */
  readonly id: string;
  /**
   * Vercel AI SDK model handle. Omitted by providers that own their transport
   * and bypass the AI SDK entirely (e.g. CodexResponsesTransportProvider speaks
   * raw HTTPS+SSE). Engines never read this — they only call `stream()` — so it
   * is purely an internal handle for AI-SDK-backed providers.
   */
  readonly model?: LanguageModel;
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
  /**
   * Stable per-session identifier. When set, OpenAI Chat Completions
   * receives this as `prompt_cache_key` (routes to the same backend so
   * cache hits stay warm across turns). Other transports may use it for
   * similar eviction hints; transports that don't support it ignore the
   * field. Should be opaque and stable for the lifetime of one session.
   */
  readonly sessionId?: string;
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
  /**
   * A completed reasoning item, emitted once at item end. `signature` is an
   * opaque, provider-specific blob (e.g. the codex reasoning item incl. its
   * encrypted content) that the engine persists on the assistant message and
   * replays next turn for reasoning continuity. Display text rides on
   * `reasoning-delta`; this carries the replayable state.
   */
  | { readonly type: "reasoning"; readonly signature: string }
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
      readonly cause?: unknown;
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
        // Opaque reasoning state for continuity (see ProviderEvent "reasoning").
        // Providers that don't reason never produce these; consumers that don't
        // understand them (e.g. the Vercel replay path) filter them out.
        | { readonly type: "reasoning"; readonly signature: string }
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
  /**
   * Optional self-described auth. When present the caller uses it instead of the id-prefix lookup in
   * `buildAuthForProvider` — needed for providers whose auth can't be inferred from the (prefix-stripped)
   * model id, e.g. the LiteLLM gateway (arbitrary model names, keyed by LITELLM_API_KEY).
   */
  readonly authFactory?: () => AuthSource | Promise<AuthSource>;
  readonly message?: string;
}
