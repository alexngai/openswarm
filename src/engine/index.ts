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
  Usage,
} from "../core/types.js";
import type { ToolImpl } from "../tools/types.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { HooksConfigFile } from "../hooks/config.js";

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

  /**
   * Return the cumulative token usage across all `run()` calls since this
   * engine instance was created. Returns zero-valued Usage when no runs have
   * completed yet.
   */
  getCumulativeUsage(): Usage;
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
   * Optional tool dispatcher. When present, the engine may invoke it for
   * post-compaction health probes (Phase 5). Swarm subprocess runs that do
   * not own a dispatcher omit this field.
   */
  readonly dispatcher?: ToolDispatcher;

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

  /**
   * When present, forces the engine to produce a JSON object matching
   * the supplied schema. Translates to the SDK's `outputFormat:
   * { type: "json_schema", schema }` option. When set, the model's
   * output is expected to be a single JSON document parseable against
   * this schema; text_delta events still stream as usual, and the
   * final parsed object is surfaced via RunResult.
   *
   * Accepts either a Zod schema (converted to JSON Schema via Zod v4's
   * built-in `z.toJSONSchema()`) or a pre-built JSON Schema object.
   */
  readonly structuredOutput?: {
    readonly schema:
      | { kind: "zod"; schema: import("zod").ZodTypeAny }
      | { kind: "json-schema"; schema: Record<string, unknown> };
    /** Name for the schema — SDK uses this in the prompt. Default: "Output". */
    readonly name?: string;
  };

  /**
   * Hook configuration loaded from `.swarm-coder/hooks.json` (or Claude Code's
   * `settings.json.hooks` field). The engine translates each HookConfig into
   * a JS async callback via `new HookRuntime(hooks).buildSdkHooks()` and
   * passes the result to `query({ options: { hooks } })`.
   *
   * Dispatcher-level invocation (Tier 2 coverage, rev-2 Major M6) is wired
   * separately — callers construct `HookRuntime` directly and pass it to
   * the `ToolDispatcher` constructor.
   */
  readonly hooks?: HooksConfigFile;
}

// ---------------------------------------------------------------------------
// RunResult
// ---------------------------------------------------------------------------

/**
 * Final result of a run. Returned after the stream ends.
 *
 * `structuredOutput` is populated when `RunConfig.structuredOutput` was set
 * and the model's response parsed successfully as JSON. The value is `unknown`
 * — callers that supplied a Zod schema should re-parse with `.safeParse()` for
 * type safety. On parse failure an error event is emitted instead and this
 * field is absent.
 */
export interface RunResult {
  readonly structuredOutput?: unknown;
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
