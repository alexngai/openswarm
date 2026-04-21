/**
 * Unit tests for translateSdkMessage.
 *
 * Uses inline fixtures cast via `as unknown as SDKMessage` to avoid coupling
 * tests to the SDK's internal type structure.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { NormalizedEvent } from "../core/types.js";
import {
  translateSdkMessage,
  makeTranslatorState,
  type TranslatorState,
} from "./event-translator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(): TranslatorState {
  return makeTranslatorState();
}

function msg(shape: object): SDKMessage {
  return shape as unknown as SDKMessage;
}

// ---------------------------------------------------------------------------
// stream_event: text_delta
// ---------------------------------------------------------------------------

describe("stream_event / text_delta", () => {
  it("emits text_delta for content_block_delta with text_delta", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello, world!" },
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({ type: "text_delta", text: "Hello, world!" });
  });

  it("returns null for message_start event inside stream_event", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: { type: "message_start", message: {} },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for message_delta event inside stream_event", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
          usage: { output_tokens: 10 },
          context_management: null,
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stream_event: tool_use start / input / end sequence
// ---------------------------------------------------------------------------

describe("stream_event / tool_use sequence", () => {
  let state: TranslatorState;

  beforeEach(() => {
    state = makeState();
  });

  it("emits tool_use_start on content_block_start with tool_use block", () => {
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_abc", name: "read_file", input: {} },
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({ type: "tool_use_start", id: "tu_abc", name: "read_file" });
    expect(state.openToolUseIds).toEqual(["tu_abc"]);
  });

  it("emits tool_use_input for input_json_delta with open tool_use id", () => {
    // Seed state with an open tool-use id
    state.openToolUseIds.push("tu_abc");

    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({
      type: "tool_use_input",
      id: "tu_abc",
      jsonDelta: '{"path":',
    });
  });

  it("emits tool_use_end on content_block_stop and pops the id", () => {
    state.openToolUseIds.push("tu_abc");

    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({ type: "tool_use_end", id: "tu_abc" });
    expect(state.openToolUseIds).toHaveLength(0);
  });

  it("returns null on content_block_stop when no open tool_use ids", () => {
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("full start → input → end sequence produces correct 3 events", () => {
    const events = [
      msg({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tu_xyz", name: "bash", input: {} },
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      msg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
        },
        session_id: "s1",
        uuid: "u2",
        parent_tool_use_id: null,
      }),
      msg({
        type: "stream_event",
        event: { type: "content_block_stop", index: 1 },
        session_id: "s1",
        uuid: "u3",
        parent_tool_use_id: null,
      }),
    ];

    const results = events.map((m) => translateSdkMessage(m, state));
    expect(results).toEqual([
      { type: "tool_use_start", id: "tu_xyz", name: "bash" },
      { type: "tool_use_input", id: "tu_xyz", jsonDelta: '{"command":"ls"}' },
      { type: "tool_use_end", id: "tu_xyz" },
    ]);
  });

  it("returns null for content_block_start with non-tool_use block", () => {
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for input_json_delta when no open tool_use", () => {
    const result = translateSdkMessage(
      msg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        },
        session_id: "s1",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// user message: tool_result extraction
// ---------------------------------------------------------------------------

describe("user message / tool_result", () => {
  it("emits tool_result from a user message with tool_result content block", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_abc",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "tu_abc",
      content: "file contents here",
      isError: false,
    });
  });

  it("emits tool_result with isError true when is_error is set", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_err",
              content: "Permission denied",
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "tu_err",
      content: "Permission denied",
      isError: true,
    });
  });

  it("extracts text from array content in tool_result", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_arr",
              content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toEqual({
      type: "tool_result",
      toolUseId: "tu_arr",
      content: "line1line2",
      isError: false,
    });
  });

  it("returns null for user message with string content", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "user",
        message: { role: "user", content: "plain text" },
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for user message with non-tool_result blocks", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        parent_tool_use_id: null,
      }),
      state,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// result message: message_stop and usage mapping
// ---------------------------------------------------------------------------

describe("result message / message_stop", () => {
  it("emits message_stop with end_turn and usage for success result", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "done",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
        duration_ms: 500,
        duration_api_ms: 400,
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.001,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toEqual({
      type: "message_stop",
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 10,
      },
    });
  });

  it("maps tool_use stop reason", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "success",
        stop_reason: "tool_use",
        result: "",
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toMatchObject({ type: "message_stop", stopReason: "tool_use" });
  });

  it("maps max_tokens stop reason", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "success",
        stop_reason: "max_tokens",
        result: "",
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toMatchObject({ type: "message_stop", stopReason: "max_tokens" });
  });

  it("maps unknown stop reason to error", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "success",
        stop_reason: "something_new",
        result: "",
        usage: { input_tokens: 1, output_tokens: 1 },
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toMatchObject({ type: "message_stop", stopReason: "error" });
  });

  it("maps null stop_reason to error", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "success",
        stop_reason: null,
        result: "",
        usage: { input_tokens: 1, output_tokens: 1 },
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toMatchObject({ type: "message_stop", stopReason: "error" });
  });

  it("omits optional cache tokens when absent", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "",
        usage: { input_tokens: 10, output_tokens: 5 },
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toEqual({
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });
});

// ---------------------------------------------------------------------------
// Error result → error event
// ---------------------------------------------------------------------------

describe("result message / error subtypes", () => {
  it("emits error event for error_max_turns", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "error_max_turns",
        stop_reason: null,
        errors: ["Max turns exceeded"],
        usage: { input_tokens: 50, output_tokens: 10 },
        duration_ms: 200,
        duration_api_ms: 150,
        is_error: true,
        num_turns: 10,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toEqual({
      type: "error",
      error: {
        code: "unknown",
        message: "Max turns exceeded",
        retryable: false,
      },
    });
  });

  it("emits error event for error_during_execution", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "error_during_execution",
        stop_reason: null,
        errors: ["Something went wrong", "Details here"],
        usage: { input_tokens: 5, output_tokens: 2 },
        duration_ms: 50,
        duration_api_ms: 30,
        is_error: true,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toMatchObject({
      type: "error",
      error: {
        code: "unknown",
        message: "Something went wrong; Details here",
        retryable: false,
      },
    });
  });

  it("falls back to subtype in error message when errors array is empty", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "result",
        subtype: "error_max_budget_usd",
        stop_reason: null,
        errors: [],
        usage: { input_tokens: 5, output_tokens: 2 },
        duration_ms: 50,
        duration_api_ms: 30,
        is_error: true,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toMatchObject({
      type: "error",
      error: {
        code: "unknown",
        message: "SDK error: error_max_budget_usd",
        retryable: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// assistant message → null (already surfaced via stream_event)
// ---------------------------------------------------------------------------

describe("assistant message", () => {
  it("returns null for full assistant message", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hi!" }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 3 },
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// system / hook / status / misc → null
// ---------------------------------------------------------------------------

describe("system and misc messages → null", () => {
  it("returns null for system init message", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "system",
        subtype: "init",
        apiKeySource: "user",
        claude_code_version: "1.0.0",
        cwd: "/tmp",
        model: "claude-sonnet-4-6",
        tools: [],
        mcp_servers: [],
        slash_commands: [],
        output_style: "text",
        skills: [],
        plugins: [],
        permissionMode: "default",
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("translates compact_boundary to begin+end compaction event pair", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 100 },
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(Array.isArray(result)).toBe(true);
    const events = result as NormalizedEvent[];
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "compaction",
      payload: { phase: "begin", trigger: "auto", compact_metadata: { pre_tokens: 100 } },
    });
    expect(events[1]).toEqual({
      type: "compaction",
      payload: { phase: "end", trigger: "auto", compact_metadata: { pre_tokens: 100 } },
    });
  });

  it("translates compact_boundary with trigger manual and full metadata", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "manual",
          pre_tokens: 180000,
          post_tokens: 5000,
          duration_ms: 1200,
        },
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(Array.isArray(result)).toBe(true);
    const events = result as NormalizedEvent[];
    expect(events[0]).toMatchObject({
      type: "compaction",
      payload: { phase: "begin", trigger: "manual" },
    });
    expect(events[1]).toMatchObject({
      type: "compaction",
      payload: { phase: "end", trigger: "manual" },
    });
    const meta = (events[0] as { payload: { compact_metadata?: Record<string, unknown> } }).payload.compact_metadata;
    expect(meta?.post_tokens).toBe(5000);
    expect(meta?.duration_ms).toBe(1200);
  });

  it("returns null for tool_progress message", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "tool_progress",
        tool_use_id: "tu1",
        tool_name: "bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 1,
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for tool_use_summary message", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "tool_use_summary",
        summary: "Used bash 3 times",
        preceding_tool_use_ids: ["tu1", "tu2", "tu3"],
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for rate_limit_event", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for prompt_suggestion message", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({
        type: "prompt_suggestion",
        suggestion: "What next?",
        session_id: "s1",
        uuid: "u1",
      }),
      state,
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown/new SDK message type (forward compat)", () => {
    const state = makeState();
    const result = translateSdkMessage(
      msg({ type: "some_future_type_v99", data: {} }),
      state,
    );
    expect(result).toBeNull();
  });
});
