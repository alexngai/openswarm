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
} from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedEvent, StopReason, Usage } from "../core/types.js";

// ---------------------------------------------------------------------------
// Translator state (per-run)
// ---------------------------------------------------------------------------

/**
 * Mutable state carried across calls for a single stream.
 * Tracks the most-recently opened tool_use block so content_block_stop
 * can emit tool_use_end with the right id.
 */
export interface TranslatorState {
  /** Stack of open tool-use ids in document order. */
  openToolUseIds: string[];
}

export function makeTranslatorState(): TranslatorState {
  return { openToolUseIds: [] };
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
        name: block.name,
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

    // All other message types (system, tool_progress, tool_use_summary,
    // auth_status, rate_limit_event, prompt_suggestion, etc.) are not
    // surfaced in M0. They are observable via lane events in a future phase.
    default:
      return null;
  }
}
