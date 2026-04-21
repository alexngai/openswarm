/**
 * AgentEngine — the primary abstraction.
 *
 * "Run a conversation to completion, streaming events back."
 *
 * This is the stable boundary between outer code and whatever drives the
 * turn loop. Outer code (CLI, SwarmHost, ink UI, tool dispatcher) only
 * sees AgentEngine. Implementations fill the abstraction at different
 * granularities:
 *
 *   - ClaudeAgentSdkEngine (M0) — thin wrapper over
 *     @anthropic-ai/claude-agent-sdk. Engine internally owns loop,
 *     streaming, MCP, compaction, session, prompt cache. Ships with
 *     OAuth for Claude Max subscription.
 *
 *   - NativeEngine (M4) — composes finer-grained pieces: our turn loop,
 *     Provider (Vercel AI SDK transport), our Compactor, our MCP client,
 *     our session format. Adds OpenAI / Google / xAI + ChatGPT Codex
 *     subscription auth.
 *
 * Both implementations present the same surface. Swapping engines is
 * transparent to outer code.
 *
 * See docs/03-interfaces.md §1 and docs/07-implementation-plan.md.
 */

import type { AuthSource } from "../auth/index.js";
import type {
  NormalizedEvent,
  PermissionMode,
} from "../core/types.js";
import type { ToolImpl } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface AgentEngine {
  /** Stable engine id: "claude-agent-sdk" | "native" | ... */
  readonly id: string;
  readonly capabilities: EngineCapabilities;

  /**
   * Drive a multi-turn conversation. The engine:
   *   - owns the turn loop
   *   - streams text deltas
   *   - surfaces tool calls via `NormalizedEvent`
   *   - calls back through `canUseTool` for permission gating
   *   - invokes `ToolImpl.execute` directly from its MCP handler after gates pass
   *   - emits `message_stop` when the model ends the conversation
   *
   * Iteration completes when the engine reaches a terminal stop reason,
   * the abort signal fires, or `maxTurns` is exceeded.
   */
  run(config: RunConfig): AsyncIterable<NormalizedEvent>;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface EngineCapabilities {
  /** Streams text deltas (vs. one final chunk per turn). */
  readonly streaming: boolean;
  /** Engine handles prompt caching internally. */
  readonly promptCache: boolean;
  /** Multiple tool calls in a single turn. */
  readonly parallelToolUse: boolean;
  /** Engine has a built-in MCP client. If false, outer code runs the bridge. */
  readonly mcp: boolean;
  /** Engine owns compaction. If false, outer code drives it. */
  readonly compaction: boolean;
  /** Engine supports resume from a SessionSnapshot. */
  readonly resume: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

// ---------------------------------------------------------------------------
// RunConfig
// ---------------------------------------------------------------------------

export interface RunConfig {
  readonly systemPrompt: string;
  readonly prompt: string;
  /** Model id or alias ("sonnet", "claude-sonnet-4-6", etc.). */
  readonly model: string;
  readonly auth: AuthSource;

  /**
   * Tools available to the model this run. Engine calls ToolImpl.execute
   * directly from inside its MCP handler after canUseTool gates.
   */
  readonly tools: readonly ToolImpl[];

  /** Engine calls this when a tool needs permission. */
  readonly canUseTool: PermissionGate;

  readonly permissionMode: PermissionMode;

  /** Hard cap on turns to prevent runaway loops. */
  readonly maxTurns?: number;
  /** Hard cap on output tokens per turn. */
  readonly maxOutputTokens?: number;

  /** Opaque resume state from a prior session. */
  readonly resumeFrom?: SessionSnapshot;

  readonly abort?: AbortSignal;

  /**
   * Built-in SDK tools to allowlist. When present, these tool names are
   * passed through to `options.tools` on the SDK's query() call.
   *
   * Permission gating for built-in tools happens here at engine-config
   * time — `canUseTool` does NOT fire for SDK built-ins. If a caller
   * wants to deny e.g. `WebSearch` under `read-only` permission mode,
   * they simply omit it from this list. Our MCP-registered tools
   * continue to use `canUseTool` for per-call gating — unchanged.
   *
   * Known values: "WebSearch" (Anthropic's first-party web search).
   * Phase 4 uses this to enable web_search.
   */
  readonly enabledBuiltinTools?: readonly string[];
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

/**
 * Engine → outer permission check.
 *
 * Returning `{ allow: true, updatedInput }` lets the engine continue with
 * possibly-modified input (useful for hooks that sanitize args).
 * Returning `{ allow: false, reason }` aborts the tool call; the engine
 * feeds the denial back to the model via a tool_result error, keeping the
 * turn loop alive.
 */
export type PermissionGate = (
  toolName: string,
  input: unknown,
) => Promise<PermissionDecision>;

export type PermissionDecision =
  | { readonly allow: true; readonly updatedInput?: unknown }
  | { readonly allow: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Session snapshot
// ---------------------------------------------------------------------------

/**
 * Opaque per-engine session state used to resume a conversation.
 *
 * Outer code never reads the `data` payload — that is engine-specific.
 * Our SessionStore stores the snapshot alongside our own JSONL log so
 * `--resume` works against whichever engine produced the session.
 *
 * Cross-engine resume (start on ClaudeAgentSdkEngine, resume on
 * NativeEngine) is NOT supported in v0 — see docs/06-open-questions.md
 * if this becomes a requirement later.
 */
export interface SessionSnapshot {
  readonly engineId: string;
  readonly data: unknown;
}
