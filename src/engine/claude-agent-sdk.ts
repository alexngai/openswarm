/**
 * ClaudeAgentSdkEngine — AgentEngine implementation backed by
 * @anthropic-ai/claude-agent-sdk.
 *
 * Responsibilities:
 *   - Build an in-process MCP server wrapping our ToolImpls.
 *   - Wrap config.canUseTool into the SDK's CanUseTool shape.
 *   - Call query() with a streaming prompt iterable.
 *   - Translate each SDKMessage to a NormalizedEvent and yield it.
 */

import {
  query,
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { fingerprintSystemPrompt } from "./prompt-cache.js";
import type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
} from "./index.js";
import type { NormalizedEvent, PermissionMode } from "../core/types.js";
import { z, ZodObject, toJSONSchema as zodToJSONSchema } from "zod";

/**
 * Claude Agent SDK exposes MCP-registered tools to the model under the
 * synthetic namespace `mcp__<server>__<tool>`. `canUseTool` callbacks
 * therefore receive the prefixed name, but our dispatcher and permission
 * engine key by the bare tool name (e.g. `read_file`). We strip the prefix
 * at the engine boundary so the rest of the system sees unprefixed names.
 */
const MCP_PREFIX = "mcp__swarm-harness__";
function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}
import {
  translateSdkMessage,
  makeTranslatorState,
} from "./event-translator.js";
import { HookRuntime } from "../hooks/runtime.js";
import { countTokens } from "./token-preflight.js";
import type { CountTokensInput, CountTokensResult } from "./index.js";

// ---------------------------------------------------------------------------
// Permission-mode mapping
// ---------------------------------------------------------------------------

type SDKPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

/**
 * Always returns SDK `default` mode so canUseTool fires for every tool call,
 * regardless of swarm-harness PermissionMode. Our PermissionEngine returns
 * Allow for everything in danger-full-access — the SDK mode would just gate
 * a second time. Going through canUseTool in all modes lets bash-validation
 * (Phase 5 stage A) act as the safety floor even in danger mode.
 *
 * v0.2 reverses Phase 2 P2.Q10 (which mapped danger-full-access to
 * `bypassPermissions` + `allowDangerouslySkipPermissions: true`). Rationale:
 * v0.1 smoke surfaced that bash-validation Block / Warn never fired in
 * danger mode, leaving destructive commands unguarded. Always going through
 * canUseTool restores the validation gate without changing user UX for safe
 * paths (PermissionEngine returns Allow → no prompt fires).
 *
 * See docs/21-roadmap-v0.2-to-v0.4.md §v0.2.Q1 for the full rationale.
 */
function mapPermissionMode(_mode: PermissionMode): SDKPermissionMode {
  return "default";
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ClaudeAgentSdkEngine implements AgentEngine {
  readonly id = "claude-agent-sdk";

  readonly capabilities: EngineCapabilities = {
    streaming: true,
    promptCache: true,
    parallelToolUse: true,
    mcp: true,
    compaction: true,
    resume: true,
    maxContextTokens: 200_000,
    maxOutputTokens: 64_000,
  };

  private _cumulativeUsage: import("../core/types.js").Usage = {
    inputTokens: 0,
    outputTokens: 0,
  };

  getCumulativeUsage(): import("../core/types.js").Usage {
    return this._cumulativeUsage;
  }

  async *run(config: RunConfig): AsyncIterable<NormalizedEvent> {
    // 1. Build in-process MCP server wrapping our ToolImpls.
    const mcpTools = config.tools.map((toolImpl) => {
      // tool() wants a Zod raw shape (plain object of field → ZodType),
      // not a ZodObject. Tier 0/1/2 tools pass a ZodObject whose .shape is
      // the declared fields. Plugin + MCP tools register with a permissive
      // non-ZodObject schema (z.unknown() / z.record(...)) because their
      // true schema lives in spec.inputSchema (JSON Schema from the plugin
      // manifest or MCP descriptor) — for those we synthesize the raw
      // shape from spec.inputSchema.properties so the model sees accurate
      // field names, keyed with z.unknown() for permissive typing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rawShape: Record<string, any> = {};
      if (toolImpl.zodSchema instanceof ZodObject) {
        rawShape = toolImpl.zodSchema.shape as Record<string, unknown>;
      } else if (toolImpl.zodSchema != null) {
        // Non-ZodObject schema — derive field list from spec.inputSchema
        // (plugin/MCP path). Fall back to empty rawShape if inputSchema
        // isn't a JSON Schema object with `properties`.
        const inputSchema = toolImpl.spec.inputSchema as {
          properties?: Record<string, unknown>;
        } | undefined;
        if (inputSchema != null && typeof inputSchema === "object"
            && inputSchema.properties != null
            && typeof inputSchema.properties === "object") {
          rawShape = Object.fromEntries(
            Object.keys(inputSchema.properties).map((k) => [k, z.unknown()]),
          );
        }
      }

      return tool(
        toolImpl.spec.name,
        toolImpl.spec.description,
        rawShape,
        async (args: Record<string, unknown>) => {
          const ctx = { cwd: process.cwd() };
          const result = await toolImpl.execute(args, ctx);
          if (result.status === "ok") {
            return {
              content: [{ type: "text" as const, text: result.output }],
            };
          } else {
            return {
              content: [{ type: "text" as const, text: result.message }],
              isError: true,
            };
          }
        },
      );
    });

    const mcpServer = createSdkMcpServer({
      name: "swarm-harness",
      tools: mcpTools,
    });

    // 2. Build SDK's canUseTool wrapper. Strip the MCP prefix so the
    //    outer gate sees bare tool names (read_file, bash, ...).
    const sdkCanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      _options: unknown,
    ) => {
      const bareName = stripMcpPrefix(toolName);
      const decision = await config.canUseTool(bareName, input);
      if (decision.allow) {
        const resp: {
          behavior: "allow";
          updatedInput?: Record<string, unknown>;
        } = { behavior: "allow" };
        if (decision.updatedInput != null) {
          resp.updatedInput = decision.updatedInput as Record<string, unknown>;
        } else {
          resp.updatedInput = input;
        }
        return resp;
      } else {
        return {
          behavior: "deny" as const,
          message: decision.reason,
        };
      }
    };

    // 3. Build streaming prompt (required for canUseTool to fire).
    async function* buildPrompt(): AsyncIterable<SDKUserMessage> {
      yield {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: config.prompt }],
        },
        parent_tool_use_id: null,
      };
    }

    // 4. Permission mode. v0.2: always SDK `default` so canUseTool fires
    //    for every tool — bash-validation can Block/Warn in any mode (see
    //    mapPermissionMode docstring + docs/21-roadmap-v0.2-to-v0.4.md
    //    §v0.2.Q1). The `allowDangerouslySkipPermissions` flag is dropped
    //    here for the same reason.
    const sdkPermissionMode = mapPermissionMode(config.permissionMode);

    // 5. System prompt shape.
    //    If the caller passed an array, respect it (user-supplied boundary wins).
    //    If a non-empty string prefix is provided, pass it as a plain string —
    //    the SDK caches the full static string automatically. The dynamic-boundary
    //    ARRAY form ([prefix, BOUNDARY, dynamicSuffix]) is intended for callers
    //    that supply a non-empty dynamic suffix. Passing [prefix, BOUNDARY, ""]
    //    risks silently degrading cache behavior (SDK may emit a zero-token
    //    cacheable prefix or collapse the array). Until a dynamic suffix source
    //    exists (M4+ per-run context), plain-string is correct and sufficient.
    //    Otherwise fall back to the claude_code preset.
    let systemPrompt: string | string[] | { type: "preset"; preset: "claude_code" };
    const basePrefix = config.systemPrompt;
    if (Array.isArray(basePrefix)) {
      systemPrompt = basePrefix as string[];
    } else if (basePrefix.length > 0) {
      systemPrompt = basePrefix;
    } else {
      systemPrompt = { type: "preset", preset: "claude_code" } as const;
    }

    // Compute fingerprint for cache analytics (used in cache_hit/cache_miss events).
    const fingerprint = fingerprintSystemPrompt(
      Array.isArray(basePrefix) ? basePrefix.join("") : basePrefix,
      config.tools.map((t) => t.spec),
    );

    // 6. Abort controller: wrap config.abort if present.
    let abortController: AbortController | undefined;
    if (config.abort != null) {
      abortController = new AbortController();
      const signal = config.abort;
      if (signal.aborted) {
        abortController.abort();
      } else {
        // { once: true } avoids leaking listeners across multiple run() calls
        // that reuse the same AbortSignal.
        signal.addEventListener(
          "abort",
          () => abortController!.abort(),
          { once: true },
        );
      }
    }

    // 6b. Build SDK-shaped hooks map from RunConfig.hooks (if any). Empty
    //     config produces `undefined`, which we omit from the query() options
    //     below rather than passing `{}`.
    const sdkHooks =
      config.hooks != null
        ? new HookRuntime(config.hooks).buildSdkHooks()
        : undefined;
    const hasHooks = sdkHooks != null && Object.keys(sdkHooks).length > 0;

    // 7. Resolve outputFormat when structuredOutput is configured.
    let outputFormat: { type: "json_schema"; schema: Record<string, unknown> } | undefined;
    if (config.structuredOutput != null) {
      const { schema: schemaDef } = config.structuredOutput;
      const jsonSchema: Record<string, unknown> =
        schemaDef.kind === "zod"
          ? (zodToJSONSchema(schemaDef.schema) as Record<string, unknown>)
          : schemaDef.schema;
      outputFormat = { type: "json_schema", schema: jsonSchema };
    }

    // 8. Call query().
    const response = query({
      prompt: buildPrompt(),
      options: {
        systemPrompt,
        model: config.model,
        settingSources: ["project"],
        // Built-in SDK tools allowlisted via RunConfig.enabledBuiltinTools.
        // Our custom tools are MCP-registered via mcpServers below.
        // Built-in tools are permission-gated at engine-config time (not via
        // canUseTool — see RunConfig.enabledBuiltinTools JSDoc). Default is
        // empty (no built-in tools) unless explicitly enabled by the caller.
        tools: [...(config.enabledBuiltinTools ?? [])],
        mcpServers: { "swarm-harness": mcpServer },
        canUseTool: sdkCanUseTool,
        permissionMode: sdkPermissionMode,
        maxTurns: config.maxTurns,
        resume: config.resumeFrom?.data != null
          ? (config.resumeFrom.data as { sessionId?: string }).sessionId
          : undefined,
        includePartialMessages: true,
        // Hook-event messages (SDKHookStartedMessage, SDKHookProgressMessage,
        // SDKHookResponseMessage) propagate through the stream and are
        // translated to "hook_event" NormalizedEvents by the translator.
        includeHookEvents: true,
        ...(abortController != null && { abortController }),
        ...(outputFormat != null && { outputFormat }),
        ...(hasHooks && { hooks: sdkHooks }),
      },
    });

    // 9. Iterate and translate. When structuredOutput is configured, buffer
    //    all text_delta content so we can JSON.parse at message_stop.
    //    Wrap in try/catch so a mid-stream SDK exception (transport error,
    //    etc.) surfaces as a terminal `error` event instead of propagating up
    //    — callers (ink UI, headless JSONL) always see a clean end of stream.
    //    The translator strips the MCP prefix from tool names so outer code
    //    sees bare names everywhere (matches canUseTool wrapper).
    const state = makeTranslatorState(MCP_PREFIX, fingerprint);
    let textBuffer = "";
    const bufferingEnabled = config.structuredOutput != null;

    try {
      for await (const msg of response) {
        const result = translateSdkMessage(msg, state);
        if (result == null) continue;

        // translateSdkMessage may return a single event or an array (compact_boundary → begin+end).
        const events: readonly NormalizedEvent[] = Array.isArray(result)
          ? (result as readonly NormalizedEvent[])
          : [result as NormalizedEvent];

        for (const event of events) {
          // Accumulate cumulative usage at each message_stop.
          if (event.type === "message_stop") {
            const u = event.usage;
            const prev = this._cumulativeUsage;
            this._cumulativeUsage = {
              inputTokens: prev.inputTokens + u.inputTokens,
              outputTokens: prev.outputTokens + u.outputTokens,
              ...((prev.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) > 0
                ? {
                    cacheReadInputTokens:
                      (prev.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0),
                  }
                : {}),
              ...((prev.cacheWriteInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0) > 0
                ? {
                    cacheWriteInputTokens:
                      (prev.cacheWriteInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0),
                  }
                : {}),
            };
          }

          // Accumulate text deltas when structured output is expected.
          if (bufferingEnabled && event.type === "text_delta") {
            textBuffer += event.text;
          }

          // At message_stop, attempt to parse the buffered JSON.
          if (bufferingEnabled && event.type === "message_stop") {
            try {
              const parsed: unknown = JSON.parse(textBuffer);
              yield { ...event, structuredOutput: parsed };
            } catch {
              yield {
                type: "error" as const,
                error: {
                  code: "structured_output_parse_failed" as const,
                  message: `Failed to parse structured output as JSON: ${textBuffer.slice(0, 200)}`,
                  retryable: false,
                },
              };
              yield event;
            }
            continue;
          }

          yield event;

          // Post-compaction health probe: after compaction end, verify the
          // tool transport is still alive by dispatching a benign glob call.
          // Guard: only when a dispatcher is present (subprocess runs omit it).
          if (
            event.type === "compaction" &&
            event.payload.phase === "end" &&
            config.dispatcher != null
          ) {
            try {
              await config.dispatcher.dispatch("glob", { pattern: "*" }, { cwd: process.cwd() });
            } catch {
              yield {
                type: "error" as const,
                error: {
                  code: "transport" as const,
                  message: "post-compaction tool-transport health probe failed",
                  retryable: false,
                },
              };
            }
          }
        }
      }
    } catch (err: unknown) {
      yield {
        type: "error",
        error: {
          code: "transport",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
          cause: err,
        },
      };
    }
  }

  /**
   * M3b Phase 7 — local-estimate-only. No server path, so no failure
   * counter / preflight_degraded / preflight_disabled lane events fire
   * in this milestone. Those surface when M4 adds a server counter.
   */
  async countTokens(input: CountTokensInput): Promise<CountTokensResult> {
    return countTokens(input);
  }
}
