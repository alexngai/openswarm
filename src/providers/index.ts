/**
 * Provider — finer-grained LLM transport abstraction.
 *
 * Placeholder stub. NOT consumed by outer code in M0–M3.
 *
 * Outer code (CLI, SwarmHost, tool dispatcher, ink UI) talks to AgentEngine
 * (see `src/engine/`). The default M0 engine, ClaudeAgentSdkEngine, wraps the
 * Anthropic Agent SDK and does not use this abstraction at all.
 *
 * In M4 we add NativeEngine, which composes `Provider` (one of these) with
 * our own turn loop, Compactor, and MCP client. That's when these stubs
 * become real implementations.
 *
 * See docs/03-interfaces.md §2 and docs/07-implementation-plan.md M4.
 */

// ---------------------------------------------------------------------------
// Placeholder types
// ---------------------------------------------------------------------------

/**
 * Structural stand-in for `LanguageModel` from `ai` (Vercel AI SDK).
 * Replaced with `import type { LanguageModel } from "ai";` when M4 ships.
 */
export interface LanguageModel {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
}

export interface Provider {
  /** Stable id: "anthropic" | "openai" | "google" | "xai" | "openai-compat" | "codex-chatgpt". */
  readonly id: string;
  readonly model: LanguageModel;
  readonly capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  readonly streaming: boolean;
  readonly promptCache: boolean;
  readonly parallelToolUse: boolean;
  readonly vision: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}
