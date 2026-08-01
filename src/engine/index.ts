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
 *   - NativeEngine (M4a) — composes finer-grained pieces: our turn loop,
 *     Provider (Vercel AI SDK transport), our Compactor, our MCP client,
 *     our session format. M4a ships the engine + OpenAI transport; M4b
 *     adds xAI / Google / DashScope + ChatGPT Codex subscription auth.
 *     NativeEngine declares `capabilities.mcp: false, compaction: false`
 *     — it composes these as separate concerns rather than absorbing
 *     them into the engine surface. Resume snapshots are keyed by
 *     `SessionSnapshot.engineId: "native"` and cannot cross over to
 *     the SDK engine (see Q3 stability policy).
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
import type { SwarmHost } from "../swarm/host.js";
import type { HooksConfigFile } from "../hooks/config.js";
import type { RetryPolicy } from "./retry-policy.js";
import type { ToolSpec } from "../core/types.js";

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

  /**
   * The engine's current conversation/session id, if it tracks one. Long-lived
   * swarm workers read this after a turn and resume from it on the next turn so
   * conversation context carries across `run_more`.
   * Engines without a session concept omit this.
   */
  getSessionId?(): string | undefined;

  /**
   * Optional server-side token preflight. Implementations that can't reach a
   * counting endpoint (e.g. OAuth-only auth) should NOT implement this —
   * callers fall back to a local estimate.
   */
  countTokens?(input: CountTokensInput): Promise<CountTokensResult>;
}

// ---------------------------------------------------------------------------
// M3b Phase 0.4 — token preflight types
// ---------------------------------------------------------------------------

export interface CountTokensInput {
  readonly systemPrompt?: string | readonly string[];
  readonly messages: readonly unknown[]; // SDK's shape
  readonly tools?: readonly ToolSpec[];
  readonly model?: string;
}

export interface CountTokensResult {
  readonly inputTokens: number;
  readonly source: "server" | "local-estimate";
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
  /** Engine supports retry on transient stream errors. */
  readonly retry?: boolean;
  /** Engine dispatches tools eagerly during streaming. */
  readonly eagerToolDispatch?: boolean;
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

  /**
   * Optional cap on engine turns (model round-trips). When omitted the loop is
   * unbounded (Codex-style) — termination comes from the model's stop reason,
   * abort, or another budget. When set, exhausting it produces a soft stop
   * (`message_stop` with `stopReason: "max_turns"`), not an error.
   */
  readonly maxTurns?: number;
  /**
   * Optional wall-clock budget in milliseconds for a single `run()`. Checked at
   * each turn boundary; on elapse the engine emits a soft stop
   * (`message_stop` with `stopReason: "max_wall_clock"`). A long single turn
   * can overshoot slightly since the check is between turns.
   */
  readonly maxWallClockMs?: number;
  /** Hard cap on output tokens per turn. */
  readonly maxOutputTokens?: number;

  /**
   * Sampling parameters, forwarded to the provider (docs/63 F3). Previously
   * unreachable: the transports read them off `ProviderRequest` but no engine
   * ever wrote them, so a self-hosted model could only be tuned through
   * `LITELLM_EXTRA_BODY`. Lowering temperature measurably improves tool-call
   * well-formedness on small open-weight models.
   *
   * Providers that reject a parameter for a given model family drop it — e.g.
   * OpenAI reasoning models strip temperature/topP/topK via openai-quirks.
   * `topK` has no OpenAI-wire equivalent, so OpenAI-compatible transports
   * (LiteLLM, Azure, DashScope) ignore it; use `LITELLM_EXTRA_BODY` there.
   */
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;

  /**
   * Force, suppress, or pin tool use for every turn of this run (docs/63 F2).
   * Defaults to the provider's own default (`auto`).
   *
   * `"required"` is the lever for an open-weight model that keeps answering in
   * prose instead of emitting a tool call. Note that it applies to EVERY turn:
   * a model that must always call a tool can never end the conversation
   * naturally, so pair it with `maxTurns`. Ignored when the run advertises no
   * tools, and a `{ name }` choice is ignored when that tool is not advertised.
   */
  readonly toolChoice?: "auto" | "required" | "none" | { readonly name: string };

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
   * Optional swarm host. Native engines dispatch tools through the
   * `dispatcher` directly (bypassing the SDK-path tool wrappers in
   * worker-entry.ts that inject `ctx.host`), so they must thread the host
   * into each tool request's execution context themselves. Without it,
   * Tier 2 TEAM tools (`agent`, `send_message`, `check_inbox`, `task_list`)
   * fail with "requires SwarmHost". The Claude Agent SDK engine ignores this
   * field because its wrapped tools already carry the host.
   */
  readonly host?: SwarmHost;

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
   * Hook configuration loaded from `.openswarm/hooks.json` (or Claude Code's
   * `settings.json.hooks` field). The engine translates each HookConfig into
   * a JS async callback via `new HookRuntime(hooks).buildSdkHooks()` and
   * passes the result to `query({ options: { hooks } })`.
   *
   * Dispatcher-level invocation (Tier 2 coverage, rev-2 Major M6) is wired
   * separately — callers construct `HookRuntime` directly and pass it to
   * the `ToolDispatcher` constructor.
   */
  readonly hooks?: HooksConfigFile;

  /**
   * Optional tool allowlist. When set, the ToolDispatcher filters the
   * registered tools array before passing to the engine — the model
   * never sees tools outside this list. Orthogonal to canUseTool
   * (per-call gate) and clampPermissionMode (permission ceiling).
   * Role-driven tool filtering writes to this field (M3a Phase 6).
   */
  readonly allowedTools?: readonly string[];

  /** Retry policy for provider stream errors. When absent, no retry. */
  readonly retryPolicy?: RetryPolicy;

  /** When true, tool calls are dispatched during streaming (eager).
   *  When false, dispatched after stream completes (batch). Default: false. */
  readonly eagerToolDispatch?: boolean;

  /** When true, compaction is checked after tool results mid-turn.
   *  Default: false (pre-turn compaction only). */
  readonly midTurnCompaction?: boolean;

  /**
   * How hard the engine tries to rescue a malformed tool call before dropping
   * it (docs/63-tool-call-repair.md). Matters almost exclusively for
   * open-weight models behind an OpenAI-compatible endpoint, where the serving
   * layer's tool-call parser — not the model — is usually what failed.
   *
   * Defaults to `OPENSWARM_TOOL_CALL_REPAIR`, itself defaulting to
   * `"standard"`. Set `"off"` to restore the prior drop-on-malformed
   * behaviour, `"aggressive"` to also mine undelimited JSON out of prose.
   */
  readonly toolCallRepair?: import("./tool-call-recovery.js").ToolCallRepairLevel;
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

/**
 * Receives the engine's resume state at each acknowledged turn boundary.
 *
 * The engines already knew when to persist — the turn boundaries were the right
 * places all along — but they only knew one destination, a per-engine file
 * written when `sessionDir` was set, which no production caller ever set. A sink
 * lets the surface decide where state goes (for the CLI, the kernel journal)
 * without the engine learning about journals (docs/67 `WP-08`).
 *
 * Rejecting aborts the turn, matching what the file write already did. A turn
 * whose state could not be recorded is not recoverable, and continuing as though
 * it were is how a resume silently loses the tail of a conversation.
 */
export type SnapshotSink = (snapshot: SessionSnapshot) => Promise<void>;
