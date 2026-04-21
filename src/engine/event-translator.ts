/**
 * Pure event translator: SDKMessage → NormalizedEvent | null.
 *
 * No side effects, no I/O. Stateful only for tracking open tool-use IDs
 * within a single stream so content_block_stop can emit tool_use_end.
 * Callers that need a stateless translator can use makeTranslator() to get
 * a fresh instance per run.
 */

import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedEvent, StopReason, Usage } from "../core/types.js";

// ---------------------------------------------------------------------------
// Translator state (per-run)
// ---------------------------------------------------------------------------

/**
 * Mutable state carried across calls for a single stream.
 * Tracks the most-recently opened tool_use block so content_block_stop
 * can emit tool_use_end with the right id. Also holds the MCP tool-name
 * prefix the engine wants stripped from emitted event names, so consumers
 * see a single canonical bare name (e.g. "read_file") instead of the
 * SDK-internal "mcp__<server>__read_file".
 */
export interface TranslatorState {
  /** Stack of open tool-use ids in document order. */
  openToolUseIds: string[];
  /** Prefix to strip from tool names in emitted events. Default "". */
  stripPrefix: string;
}

export function makeTranslatorState(stripPrefix = ""): TranslatorState {
  return { openToolUseIds: [], stripPrefix };
}

function stripToolName(name: string, prefix: string): string {
  if (prefix && name.startsWith(prefix)) {
    return name.slice(prefix.length);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Stop reason mapping
// ---------------------------------------------------------------------------

function mapStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_use":
      return "tool_use";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Usage mapping
// ---------------------------------------------------------------------------

function mapUsage(sdkUsage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}): Usage {
  return {
    inputTokens: sdkUsage.input_tokens,
    outputTokens: sdkUsage.output_tokens,
    ...(sdkUsage.cache_read_input_tokens != null && {
      cacheReadInputTokens: sdkUsage.cache_read_input_tokens,
    }),
    ...(sdkUsage.cache_creation_input_tokens != null && {
      cacheWriteInputTokens: sdkUsage.cache_creation_input_tokens,
    }),
  };
}

// ---------------------------------------------------------------------------
// stream_event handler (SDKPartialAssistantMessage)
// ---------------------------------------------------------------------------

function handleStreamEvent(
  msg: SDKPartialAssistantMessage,
  state: TranslatorState,
): NormalizedEvent | null {
  const event = msg.event;

  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block.type === "tool_use") {
      state.openToolUseIds.push(block.id);
      return {
        type: "tool_use_start",
        id: block.id,
        name: stripToolName(block.name, state.stripPrefix),
      };
    }
    return null;
  }

  if (event.type === "content_block_delta") {
    const delta = event.delta;

    if (delta.type === "text_delta") {
      return {
        type: "text_delta",
        text: delta.text,
      };
    }

    if (delta.type === "input_json_delta") {
      // The most recently opened tool_use id is at the top of the stack.
      const id = state.openToolUseIds[state.openToolUseIds.length - 1];
      if (id == null) return null;
      return {
        type: "tool_use_input",
        id,
        jsonDelta: delta.partial_json,
      };
    }

    return null;
  }

  if (event.type === "content_block_stop") {
    const id = state.openToolUseIds.pop();
    if (id == null) return null;
    return {
      type: "tool_use_end",
      id,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// user message handler (tool_result extraction)
// ---------------------------------------------------------------------------

function handleUserMessage(msg: SDKUserMessage): NormalizedEvent | null {
  const { message } = msg;
  // content is string | Array<ContentBlockParam>
  if (typeof message.content !== "object" || !Array.isArray(message.content)) {
    return null;
  }
  for (const block of message.content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "tool_result"
    ) {
      const b = block as {
        type: "tool_result";
        tool_use_id: string;
        content?: unknown;
        is_error?: boolean;
      };
      // Flatten content to string
      let contentStr = "";
      if (typeof b.content === "string") {
        contentStr = b.content;
      } else if (Array.isArray(b.content)) {
        contentStr = b.content
          .map((c: unknown) => {
            if (
              typeof c === "object" &&
              c !== null &&
              "type" in c &&
              (c as { type: string }).type === "text" &&
              "text" in c
            ) {
              return String((c as { text: unknown }).text);
            }
            return "";
          })
          .join("");
      }
      return {
        type: "tool_result",
        toolUseId: b.tool_use_id,
        content: contentStr,
        isError: b.is_error === true,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// result message handler
// ---------------------------------------------------------------------------

function handleResultMessage(msg: SDKResultMessage): NormalizedEvent {
  if (msg.subtype === "success") {
    return {
      type: "message_stop",
      stopReason: mapStopReason(msg.stop_reason),
      usage: mapUsage(msg.usage),
    };
  }

  // Error subtypes: error_during_execution | error_max_turns | error_max_budget_usd | ...
  const errorMessage =
    msg.errors != null && msg.errors.length > 0
      ? msg.errors.join("; ")
      : `SDK error: ${msg.subtype}`;

  return {
    type: "error",
    error: {
      code: "unknown",
      message: errorMessage,
      retryable: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Hook-event message handler
// ---------------------------------------------------------------------------

/**
 * Translate SDK hook lifecycle messages to a NormalizedEvent.
 *
 * The SDK emits three hook message subtypes (all with type === "system"):
 *   - SDKHookStartedMessage  (subtype "hook_started")
 *   - SDKHookProgressMessage (subtype "hook_progress")
 *   - SDKHookResponseMessage (subtype "hook_response")
 *
 * These are visible in the stream only when includeHookEvents: true is set
 * on the SDK query() options (which ClaudeAgentSdkEngine sets unconditionally).
 */
function handleHookStarted(msg: SDKHookStartedMessage): NormalizedEvent {
  return {
    type: "hook_event",
    payload: {
      hookId: msg.hook_id,
      hookName: msg.hook_name,
      event: msg.hook_event,
      subtype: "hook_started",
    },
  };
}

function handleHookProgress(msg: SDKHookProgressMessage): NormalizedEvent {
  return {
    type: "hook_event",
    payload: {
      hookId: msg.hook_id,
      hookName: msg.hook_name,
      event: msg.hook_event,
      subtype: "hook_progress",
      stdout: msg.stdout,
      stderr: msg.stderr,
    },
  };
}

function handleHookResponse(msg: SDKHookResponseMessage): NormalizedEvent {
  return {
    type: "hook_event",
    payload: {
      hookId: msg.hook_id,
      hookName: msg.hook_name,
      event: msg.hook_event,
      subtype: "hook_response",
      stdout: msg.stdout,
      stderr: msg.stderr,
      exitCode: msg.exit_code,
      outcome: msg.outcome,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate one SDKMessage into a NormalizedEvent (or null to discard).
 *
 * @param msg   The raw SDK message.
 * @param state Mutable translator state (call makeTranslatorState() once per run).
 */
export function translateSdkMessage(
  msg: SDKMessage,
  state: TranslatorState,
): NormalizedEvent | null {
  switch (msg.type) {
    case "stream_event":
      return handleStreamEvent(msg as SDKPartialAssistantMessage, state);

    case "assistant":
      // Full assistant message at end of turn — deltas already surfaced via stream_event.
      return null;

    case "user":
      return handleUserMessage(msg as SDKUserMessage);

    case "result":
      return handleResultMessage(msg as SDKResultMessage);

    case "system": {
      // SDK hook lifecycle messages: SDKHookStartedMessage, SDKHookProgressMessage,
      // SDKHookResponseMessage all carry type === "system" with a subtype discriminant.
      // Visible only when includeHookEvents: true is set (ClaudeAgentSdkEngine sets this
      // unconditionally). Other "system" subtypes (auth_status, rate_limit_event, etc.)
      // are discarded here — they are observable via lane events in a future phase.
      const sys = msg as { subtype?: string };
      if (sys.subtype === "hook_started") {
        return handleHookStarted(msg as unknown as SDKHookStartedMessage);
      }
      if (sys.subtype === "hook_progress") {
        return handleHookProgress(msg as unknown as SDKHookProgressMessage);
      }
      if (sys.subtype === "hook_response") {
        return handleHookResponse(msg as unknown as SDKHookResponseMessage);
      }
      return null;
    }

    // All other message types (tool_progress, tool_use_summary,
    // prompt_suggestion, etc.) are not surfaced. Observable via lane events in a future phase.
    default:
      return null;
  }
}
