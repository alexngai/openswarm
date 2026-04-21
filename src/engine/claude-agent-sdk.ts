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
import type {
  AgentEngine,
  EngineCapabilities,
  RunConfig,
} from "./index.js";
import type { NormalizedEvent, PermissionMode } from "../core/types.js";
import { ZodObject, toJSONSchema as zodToJSONSchema } from "zod";

/**
 * Claude Agent SDK exposes MCP-registered tools to the model under the
 * synthetic namespace `mcp__<server>__<tool>`. `canUseTool` callbacks
 * therefore receive the prefixed name, but our dispatcher and permission
 * engine key by the bare tool name (e.g. `read_file`). We strip the prefix
 * at the engine boundary so the rest of the system sees unprefixed names.
 */
const MCP_PREFIX = "mcp__swarm-coder__";
function stripMcpPrefix(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}
import {
  translateSdkMessage,
  makeTranslatorState,
} from "./event-translator.js";

// ---------------------------------------------------------------------------
// Permission-mode mapping
// ---------------------------------------------------------------------------

type SDKPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";

function mapPermissionMode(mode: PermissionMode): SDKPermissionMode {
  switch (mode) {
    case "danger-full-access":
      return "bypassPermissions";
    case "read-only":
    case "workspace-write":
    default:
      return "default";
  }
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
      // not a ZodObject. Enforce at construction — tool authors who pass
      // a non-object schema get a clear error instead of a silent empty
      // shape (which would register a zero-arg tool and mislead the model).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rawShape: Record<string, any> = {};
      if (toolImpl.zodSchema != null) {
        if (!(toolImpl.zodSchema instanceof ZodObject)) {
          throw new TypeError(
            `Tool "${toolImpl.spec.name}" zodSchema must be a z.object({...}). ` +
              `Got ${toolImpl.zodSchema.constructor.name}.`,
          );
        }
        rawShape = toolImpl.zodSchema.shape as Record<string, unknown>;
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
      name: "swarm-coder",
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

    // 4. Permission mode + bypassPermissions safety flag.
    const sdkPermissionMode = mapPermissionMode(config.permissionMode);
    const allowDangerouslySkipPermissions =
      sdkPermissionMode === "bypassPermissions";

    // 5. System prompt shape.
    const systemPrompt =
      config.systemPrompt.length > 0
        ? config.systemPrompt
        : ({ type: "preset", preset: "claude_code" } as const);

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
        mcpServers: { "swarm-coder": mcpServer },
        canUseTool: sdkCanUseTool,
        permissionMode: sdkPermissionMode,
        ...(allowDangerouslySkipPermissions && {
          allowDangerouslySkipPermissions: true,
        }),
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
      },
    });

    // 9. Iterate and translate. When structuredOutput is configured, buffer
    //    all text_delta content so we can JSON.parse at message_stop.
    //    Wrap in try/catch so a mid-stream SDK exception (transport error,
    //    etc.) surfaces as a terminal `error` event instead of propagating up
    //    — callers (ink UI, headless JSONL) always see a clean end of stream.
    //    The translator strips the MCP prefix from tool names so outer code
    //    sees bare names everywhere (matches canUseTool wrapper).
    const state = makeTranslatorState(MCP_PREFIX);
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
}
