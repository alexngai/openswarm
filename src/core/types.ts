/**
 * Shared primitives used across providers, auth, swarm, tools.
 *
 * Keep this file small. Anything used by only one module belongs in that module.
 */

/**
 * Permission modes control what a tool call is allowed to do.
 * Evaluation order (see docs/03-interfaces.md, docs/research/03-runtime.md §4):
 *   deny rules → hook override → ask rule → mode-required → prompt → deny
 */
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

/**
 * What a tool needs to be allowed.
 * Compared against the active PermissionMode by the permission engine.
 */
export type RequiredPermission = "none" | "read" | "write" | "exec" | "network";

/** Token usage for a single turn. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

/** Why a streaming response stopped. Normalized across providers. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "error";

/**
 * Branded string for agent identity. Construct via helpers in `src/swarm/`.
 * Branding prevents accidentally passing arbitrary strings as AgentIds.
 */
export type AgentId = string & { readonly __brand: "AgentId" };

/** Opaque session id. */
export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * Tool specification exposed to the model.
 * The `execute` field is intentionally absent — execution goes through our
 * dispatcher + permission engine, not via AI SDK auto-execute.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema describing the tool input. Validated before dispatch. */
  readonly inputSchema: JsonSchema;
  readonly requiredPermission: RequiredPermission;
  /** 0..5 — see docs/04-tool-tiers.md */
  readonly tier: 0 | 1 | 2 | 3 | 4 | 5;
  /**
   * When true (default), the tool can be dispatched in parallel with other
   * tools in a batch. When false, the dispatcher serializes calls to this
   * tool even when parallel_tool_use is enabled. Stateful tools (e.g.
   * todo_write with a module-level singleton) must set this to false.
   */
  readonly concurrencySafe?: boolean;
}

/**
 * Minimal JSON Schema shape we accept.
 * Full validation is provided by `zod` or `@sinclair/typebox` at the boundary —
 * here we only type-check structural consistency.
 */
export interface JsonSchema {
  readonly type: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly description?: string;
  readonly [k: string]: unknown;
}

/** Error shape surfaced by engines, providers, and tools. */
export interface ProviderError {
  readonly code:
    | "auth"
    | "rate_limit"
    | "context_overflow"
    | "invalid_request"
    | "provider_unavailable"
    | "transport"
    | "structured_output_parse_failed"
    | "prompt_cache_unavailable"
    | "unknown";
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

/**
 * Provider-agnostic streaming event. Produced by AgentEngine.run() and (in
 * M4+) by Provider.stream(). Consumed by session store, ink UI, and the
 * headless JSONL emitter. One shape across all engines and all providers.
 */
export type NormalizedEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_use_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_use_input"; readonly id: string; readonly jsonDelta: string }
  | { readonly type: "tool_use_end"; readonly id: string; readonly input?: unknown }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | {
      readonly type: "message_stop";
      readonly stopReason: StopReason;
      readonly usage: Usage;
      /**
       * Present when `RunConfig.structuredOutput` was set and the model's
       * response parsed successfully as JSON. `unknown` — callers that
       * supplied a Zod schema should re-parse with `.safeParse()` for type
       * safety.
       */
      readonly structuredOutput?: unknown;
    }
  | { readonly type: "error"; readonly error: ProviderError }
  /**
   * Fallback for Codex-specific notifications that don't map to a known event
   * type. The original method name and params are preserved verbatim so callers
   * can inspect or log them without the provider silently dropping them.
   */
  | {
      readonly type: "info";
      /** Identifies the producer, e.g. "codex". */
      readonly source: string;
      /** The original JSON-RPC method name, e.g. "thread/started". */
      readonly method: string;
      /** Raw params from the notification, preserved verbatim. */
      readonly payload: unknown;
    }
  /**
   * Emitted when the SDK fires a hook lifecycle message (hook_started,
   * hook_progress, hook_response). Requires includeHookEvents: true on
   * the SDK query() options (set unconditionally in ClaudeAgentSdkEngine).
   *
   * SDK type names mapped: SDKHookStartedMessage (subtype "hook_started"),
   * SDKHookProgressMessage (subtype "hook_progress"),
   * SDKHookResponseMessage (subtype "hook_response") — all have type "system".
   */
  | {
      readonly type: "hook_event";
      readonly payload: {
        readonly hookId: string;
        readonly hookName: string;
        /** The HookEvent name, e.g. "PreToolUse", "PostToolUse", "SessionStart". */
        readonly event: string;
        readonly subtype: "hook_started" | "hook_progress" | "hook_response";
        readonly stdout?: string;
        readonly stderr?: string;
        readonly exitCode?: number;
        readonly outcome?: "success" | "error" | "cancelled";
      };
    }
  /**
   * Emitted when the SDK fires a compact_boundary system message.
   * The translator emits a `begin` event immediately followed by an `end`
   * event (the SDK emits a single boundary message per compaction, not two).
   *
   * SDK shape: SDKCompactBoundaryMessage — type "system", subtype "compact_boundary",
   * compact_metadata: { trigger: "manual" | "auto", pre_tokens, post_tokens?, ... }
   */
  | {
      readonly type: "compaction";
      readonly payload: {
        /**
         * "begin"/"end" bracket a compaction (micro or full — see
         * compact_metadata.micro). "warn" is a standalone context-low notice
         * (Claude Code's "Context low" level; docs/48-compaction-design.md §L1).
         */
        readonly phase: "begin" | "end" | "warn";
        readonly trigger: "auto" | "manual";
        readonly compact_metadata?: Record<string, unknown>;
      };
    }
  /** Emitted when a cached system-prompt prefix was read (cache hit). */
  | {
      readonly type: "cache_hit";
      readonly payload: {
        readonly tokens: number;
        readonly fingerprint?: string;
      };
    }
  /** Emitted when a system-prompt prefix was written to cache (cache miss/write). */
  | {
      readonly type: "cache_miss";
      readonly payload: {
        readonly tokens: number;
        readonly fingerprint?: string;
      };
    }
  /**
   * Emitted by HardenedNativeEngine when a retryable stream error occurs and
   * the engine will retry after a backoff delay. Maps to Codex's
   * `handle_retryable_response_stream_error` (responses_retry.rs:22-79).
   */
  | {
      readonly type: "retry";
      readonly attempt: number;
      readonly maxRetries: number;
      readonly error: ProviderError;
      readonly delayMs: number;
    }
  // Phase 5 — Multi-agent events (emitted by SwarmHost when workers spawn/transition)
  | {
      readonly type: "agent_spawned";
      readonly agentId: string;
      readonly name: string;
      readonly role: string;
      readonly parentId?: string;
    }
  | {
      readonly type: "agent_status";
      readonly agentId: string;
      readonly phase: AgentPhase;
      readonly toolCount?: number;
      readonly tokenUsage?: number;
    }
  | {
      readonly type: "task_update";
      readonly taskId: string;
      readonly title: string;
      readonly status: TaskStatus;
      readonly assignee?: string;
    };

export type AgentPhase = "spawning" | "running" | "idle" | "done" | "failed";
export type TaskStatus = "pending" | "active" | "done" | "failed";
