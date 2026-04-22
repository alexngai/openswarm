/**
 * Integration tests for ClaudeAgentSdkEngine.
 *
 * Mocks the @anthropic-ai/claude-agent-sdk module entirely so no subprocess
 * is spawned. The mock `query` returns a scripted async iterable of SDKMessages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { NormalizedEvent } from "../core/types.js";

// ---------------------------------------------------------------------------
// Mock SDK — must be declared before any import that uses it.
// ---------------------------------------------------------------------------

const mockQueryMessages: object[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn((_params: unknown) => {
      async function* gen() {
        for (const m of mockQueryMessages) {
          yield m;
        }
      }
      const it = gen();
      // query() returns a Query (AsyncGenerator) — wrap with Symbol.asyncIterator
      return {
        [Symbol.asyncIterator]: () => it,
        next: it.next.bind(it),
        return: it.return.bind(it),
        throw: it.throw.bind(it),
      };
    }),

    createSdkMcpServer: vi.fn((_opts: unknown) => ({
      type: "sdk" as const,
      instance: { name: "swarm-coder" },
    })),

    tool: vi.fn(
      (
        name: string,
        description: string,
        _schema: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => ({
        name,
        description,
        inputSchema: {},
        handler,
      }),
    ),

    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
  };
});

// ---------------------------------------------------------------------------
// Now import the engine (after mock is established).
// ---------------------------------------------------------------------------

import { ClaudeAgentSdkEngine } from "./claude-agent-sdk.js";
import type { RunConfig } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sdkMsg(shape: object): object {
  return shape;
}

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    systemPrompt: "",
    prompt: "say hi",
    model: "claude-sonnet-4-6",
    auth: {
      kind: "api-key" as const,
      providerId: "anthropic",
      isAuthenticated: async () => true,
      headers: async () => ({}),
    },
    tools: [],
    canUseTool: async (_name, _input) => ({ allow: true }),
    permissionMode: "workspace-write",
    ...overrides,
  };
}

async function collectEvents(config: RunConfig): Promise<NormalizedEvent[]> {
  const engine = new ClaudeAgentSdkEngine();
  const events: NormalizedEvent[] = [];
  for await (const event of engine.run(config)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Scenario 1: Simple text-only response
// ---------------------------------------------------------------------------

describe("Scenario 1: simple text-only response", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      // Partial streaming text
      sdkMsg({
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
      sdkMsg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        session_id: "s1",
        uuid: "u2",
        parent_tool_use_id: null,
      }),
      sdkMsg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: ", world!" },
        },
        session_id: "s1",
        uuid: "u3",
        parent_tool_use_id: null,
      }),
      sdkMsg({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        session_id: "s1",
        uuid: "u4",
        parent_tool_use_id: null,
      }),
      // Full assistant message (should be suppressed)
      sdkMsg({
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello, world!" }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 10 },
        },
        parent_tool_use_id: null,
        session_id: "s1",
        uuid: "u5",
      }),
      // Result
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "Hello, world!",
        usage: { input_tokens: 20, output_tokens: 10 },
        duration_ms: 300,
        duration_api_ms: 200,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.0001,
        modelUsage: {},
        permission_denials: [],
        session_id: "s1",
        uuid: "u6",
      }),
    );
  });

  it("emits text_deltas followed by message_stop; suppresses assistant message", async () => {
    const events = await collectEvents(makeConfig());

    // Filter by type
    const textDeltas = events.filter((e) => e.type === "text_delta");
    const stops = events.filter((e) => e.type === "message_stop");

    expect(textDeltas).toEqual([
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world!" },
    ]);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 20, outputTokens: 10 },
    });

    // Verify no assistant type leaked through
    expect(events.find((e) => e.type === "error")).toBeUndefined();
  });

  it("stream ends with message_stop as the last event", async () => {
    const events = await collectEvents(makeConfig());
    expect(events[events.length - 1]?.type).toBe("message_stop");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Tool-use round trip
// ---------------------------------------------------------------------------

describe("Scenario 2: tool-use round trip", () => {
  const toolUseId = "tu_read_001";

  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      // Tool-use start
      sdkMsg({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: toolUseId,
            name: "swarm-coder__read_file",
            input: {},
          },
        },
        session_id: "s2",
        uuid: "u1",
        parent_tool_use_id: null,
      }),
      // Tool-use input delta
      sdkMsg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: '{"path":"package.json"}',
          },
        },
        session_id: "s2",
        uuid: "u2",
        parent_tool_use_id: null,
      }),
      // Tool-use end
      sdkMsg({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
        session_id: "s2",
        uuid: "u3",
        parent_tool_use_id: null,
      }),
      // Tool result (user message from SDK)
      sdkMsg({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: '{"name":"swarm-coder"}',
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: toolUseId,
        session_id: "s2",
        uuid: "u4",
      }),
      // Result
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "The package is swarm-coder",
        usage: { input_tokens: 50, output_tokens: 15 },
        duration_ms: 400,
        duration_api_ms: 300,
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.0002,
        modelUsage: {},
        permission_denials: [],
        session_id: "s2",
        uuid: "u5",
      }),
    );
  });

  it("emits tool_use_start, tool_use_input, tool_use_end, tool_result, message_stop in order", async () => {
    const events = await collectEvents(makeConfig());

    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({
      type: "tool_use_start",
      id: toolUseId,
      name: "swarm-coder__read_file",
    });
    expect(events[1]).toEqual({
      type: "tool_use_input",
      id: toolUseId,
      jsonDelta: '{"path":"package.json"}',
    });
    expect(events[2]).toEqual({ type: "tool_use_end", id: toolUseId });
    expect(events[3]).toEqual({
      type: "tool_result",
      toolUseId,
      content: '{"name":"swarm-coder"}',
      isError: false,
    });
    expect(events[4]).toMatchObject({ type: "message_stop", stopReason: "end_turn" });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Permission deny — canUseTool returns deny
// ---------------------------------------------------------------------------

describe("Scenario 3: permission deny via canUseTool", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    // Simulate SDK honoring deny by returning a tool_result with is_error: true
    // (In reality the SDK calls canUseTool before invoking the MCP handler.)
    mockQueryMessages.push(
      sdkMsg({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_write_001",
              content: "Operation not permitted: write_file denied by permission policy",
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: "tu_write_001",
        session_id: "s3",
        uuid: "u1",
      }),
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "I cannot write the file due to permissions.",
        usage: { input_tokens: 30, output_tokens: 20 },
        duration_ms: 200,
        duration_api_ms: 150,
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.0001,
        modelUsage: {},
        permission_denials: [
          {
            tool_name: "write_file",
            tool_use_id: "tu_write_001",
            tool_input: { path: "test.txt", content: "hello" },
          },
        ],
        session_id: "s3",
        uuid: "u2",
      }),
    );
  });

  it("passes deny decision through canUseTool and surfaces tool_result error event", async () => {
    const canUseTool = vi.fn(async (name: string, _input: unknown) => {
      if (name === "write_file") {
        return { allow: false as const, reason: "write_file denied by permission policy" };
      }
      return { allow: true as const };
    });

    const events = await collectEvents(
      makeConfig({
        permissionMode: "read-only",
        canUseTool,
      }),
    );

    const toolResultEvent = events.find((e) => e.type === "tool_result");
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent).toMatchObject({
      type: "tool_result",
      toolUseId: "tu_write_001",
      isError: true,
    });

    const stopEvent = events.find((e) => e.type === "message_stop");
    expect(stopEvent).toBeDefined();
  });

  it("builds canUseTool wrapper that maps allow:false to deny behavior", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    // Reset and use a simple text-only flow to just verify query is called
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "ok",
        usage: { input_tokens: 5, output_tokens: 5 },
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s3",
        uuid: "u1",
      }),
    );

    const canUseTool = vi.fn(async () => ({
      allow: false as const,
      reason: "denied",
    }));

    await collectEvents(makeConfig({ canUseTool }));

    // Verify query was called with a canUseTool function in options
    expect(mockQuery).toHaveBeenCalled();
    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      options?: { canUseTool?: unknown };
    };
    expect(typeof callArgs.options?.canUseTool).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Error result propagates as error event
// ---------------------------------------------------------------------------

describe("Scenario 4: error_max_turns propagates as error event", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "error_max_turns",
        stop_reason: null,
        errors: ["Reached maximum turns limit"],
        usage: { input_tokens: 200, output_tokens: 80 },
        duration_ms: 5000,
        duration_api_ms: 4800,
        is_error: true,
        num_turns: 10,
        total_cost_usd: 0.005,
        modelUsage: {},
        permission_denials: [],
        session_id: "s4",
        uuid: "u1",
      }),
    );
  });

  it("emits a single error event for error_max_turns", async () => {
    const events = await collectEvents(makeConfig());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      error: {
        code: "unknown",
        message: "Reached maximum turns limit",
        retryable: false,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Engine capabilities and id
// ---------------------------------------------------------------------------

describe("Engine metadata", () => {
  it("has correct id", () => {
    const engine = new ClaudeAgentSdkEngine();
    expect(engine.id).toBe("claude-agent-sdk");
  });

  it("has correct capabilities", () => {
    const engine = new ClaudeAgentSdkEngine();
    expect(engine.capabilities).toEqual({
      streaming: true,
      promptCache: true,
      parallelToolUse: true,
      mcp: true,
      compaction: true,
      resume: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 64_000,
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Resume passes sessionId to query options
// ---------------------------------------------------------------------------


describe("Scenario 6: resume passes sessionId", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "resumed",
        usage: { input_tokens: 5, output_tokens: 5 },
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "session-abc",
        uuid: "u1",
      }),
    );
  });

  it("passes resumeFrom sessionId to query options.resume", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    const config = makeConfig({
      resumeFrom: {
        engineId: "claude-agent-sdk",
        data: { sessionId: "session-abc" },
      },
    });

    await collectEvents(config);

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { resume?: string };
    };
    expect(callArgs?.options?.resume).toBe("session-abc");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: enabledBuiltinTools passthrough
// ---------------------------------------------------------------------------

describe("Scenario 7: enabledBuiltinTools passthrough", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "ok",
        usage: { input_tokens: 5, output_tokens: 5 },
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s7",
        uuid: "u1",
      }),
    );
  });

  it("passes enabledBuiltinTools to query options.tools", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    await collectEvents(makeConfig({ enabledBuiltinTools: ["WebSearch"] }));

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { tools?: unknown };
    };
    expect(callArgs?.options?.tools).toEqual(["WebSearch"]);
  });

  it("defaults to empty tools array when enabledBuiltinTools is omitted", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    await collectEvents(makeConfig());

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { tools?: unknown };
    };
    expect(callArgs?.options?.tools).toEqual([]);
  });

  it("passes includeHookEvents: true unconditionally", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    await collectEvents(makeConfig());

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { includeHookEvents?: boolean };
    };
    expect(callArgs?.options?.includeHookEvents).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Hook-event translator
// ---------------------------------------------------------------------------

describe("Scenario 8: hook-event translator", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    // hook_started → hook_progress → hook_response sequence
    mockQueryMessages.push(
      sdkMsg({
        type: "system",
        subtype: "hook_started",
        hook_id: "hk_001",
        hook_name: "log-bash.sh",
        hook_event: "PreToolUse",
        uuid: "u1",
        session_id: "s8",
      }),
      sdkMsg({
        type: "system",
        subtype: "hook_progress",
        hook_id: "hk_001",
        hook_name: "log-bash.sh",
        hook_event: "PreToolUse",
        stdout: "running...",
        stderr: "",
        output: "",
        uuid: "u2",
        session_id: "s8",
      }),
      sdkMsg({
        type: "system",
        subtype: "hook_response",
        hook_id: "hk_001",
        hook_name: "log-bash.sh",
        hook_event: "PreToolUse",
        stdout: "done",
        stderr: "",
        output: "",
        exit_code: 0,
        outcome: "success",
        uuid: "u3",
        session_id: "s8",
      }),
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "ok",
        usage: { input_tokens: 5, output_tokens: 5 },
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s8",
        uuid: "u4",
      }),
    );
  });

  it("translates hook_started to hook_event with correct fields", async () => {
    const events = await collectEvents(makeConfig());
    const hookEvents = events.filter((e) => e.type === "hook_event");

    expect(hookEvents).toHaveLength(3);
    expect(hookEvents[0]).toEqual({
      type: "hook_event",
      payload: {
        hookId: "hk_001",
        hookName: "log-bash.sh",
        event: "PreToolUse",
        subtype: "hook_started",
      },
    });
  });

  it("translates hook_progress with stdout/stderr", async () => {
    const events = await collectEvents(makeConfig());
    const hookEvents = events.filter((e) => e.type === "hook_event");

    expect(hookEvents[1]).toMatchObject({
      type: "hook_event",
      payload: {
        subtype: "hook_progress",
        event: "PreToolUse",
        stdout: "running...",
        stderr: "",
      },
    });
  });

  it("translates hook_response with exit_code and outcome", async () => {
    const events = await collectEvents(makeConfig());
    const hookEvents = events.filter((e) => e.type === "hook_event");

    expect(hookEvents[2]).toMatchObject({
      type: "hook_event",
      payload: {
        subtype: "hook_response",
        event: "PreToolUse",
        exitCode: 0,
        outcome: "success",
        stdout: "done",
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: structuredOutput
// ---------------------------------------------------------------------------

/** Minimal result message for structured output scenarios. */
function makeResultMsg(sessionId = "s9"): object {
  return sdkMsg({
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    result: '{"foo":"bar"}',
    usage: { input_tokens: 10, output_tokens: 5 },
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: "u-result",
  });
}

function makeTextDelta(text: string, sessionId = "s9", uuidSuffix = "td"): object {
  return sdkMsg({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    session_id: sessionId,
    uuid: `u-${uuidSuffix}`,
    parent_tool_use_id: null,
  });
}

describe("Scenario 9: structuredOutput", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
  });

  it("Zod schema is converted to JSON Schema and passed as outputFormat", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    mockQueryMessages.push(makeResultMsg());

    const zodSchema = z.object({ foo: z.string() });
    await collectEvents(
      makeConfig({
        structuredOutput: { schema: { kind: "zod", schema: zodSchema } },
      }),
    );

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { outputFormat?: { type: string; schema: Record<string, unknown> } };
    };
    const outputFormat = callArgs?.options?.outputFormat;
    expect(outputFormat?.type).toBe("json_schema");
    expect(outputFormat?.schema?.type).toBe("object");
    expect(
      (outputFormat?.schema?.properties as Record<string, unknown>)?.foo,
    ).toBeDefined();
  });

  it("pre-built JSON Schema passes through unchanged to outputFormat", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    mockQueryMessages.push(makeResultMsg());

    const rawSchema = { type: "object", properties: { bar: { type: "number" } } };
    await collectEvents(
      makeConfig({
        structuredOutput: { schema: { kind: "json-schema", schema: rawSchema } },
      }),
    );

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { outputFormat?: { type: string; schema: Record<string, unknown> } };
    };
    expect(callArgs?.options?.outputFormat?.schema).toEqual(rawSchema);
  });

  it("successful parse attaches structuredOutput to message_stop event", async () => {
    mockQueryMessages.push(
      makeTextDelta('{"foo":', "s9", "1"),
      makeTextDelta('"bar"}', "s9", "2"),
      makeResultMsg(),
    );

    const events = await collectEvents(
      makeConfig({
        structuredOutput: { schema: { kind: "json-schema", schema: { type: "object" } } },
      }),
    );

    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    expect((stop as { structuredOutput?: unknown }).structuredOutput).toEqual({ foo: "bar" });
  });

  it("parse failure emits error event with code structured_output_parse_failed", async () => {
    mockQueryMessages.push(
      makeTextDelta("not valid json!!", "s9", "bad"),
      makeResultMsg(),
    );

    const events = await collectEvents(
      makeConfig({
        structuredOutput: { schema: { kind: "json-schema", schema: { type: "object" } } },
      }),
    );

    const errorEvent = events.find(
      (e) => e.type === "error" &&
        (e as { error: { code: string } }).error.code === "structured_output_parse_failed",
    );
    expect(errorEvent).toBeDefined();

    // message_stop still emitted after the error
    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    // structuredOutput should be absent on the stop event
    expect((stop as { structuredOutput?: unknown }).structuredOutput).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: getCumulativeUsage accumulates across runs
// ---------------------------------------------------------------------------

describe("Scenario 10: getCumulativeUsage", () => {
  const makeResultMsg = (input: number, output: number, sessionId = "s10") =>
    sdkMsg({
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
      result: "ok",
      usage: { input_tokens: input, output_tokens: output },
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      session_id: sessionId,
      uuid: "u-result",
    });

  it("returns zero usage before any runs", () => {
    const engine = new ClaudeAgentSdkEngine();
    expect(engine.getCumulativeUsage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("accumulates usage across two consecutive runs", async () => {
    const engine = new ClaudeAgentSdkEngine();

    // First run
    mockQueryMessages.length = 0;
    mockQueryMessages.push(makeResultMsg(100, 50, "s10a"));
    for await (const _ of engine.run(makeConfig())) { /* consume */ }

    // Second run
    mockQueryMessages.length = 0;
    mockQueryMessages.push(makeResultMsg(200, 75, "s10b"));
    for await (const _ of engine.run(makeConfig())) { /* consume */ }

    const usage = engine.getCumulativeUsage();
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: compact_boundary → compaction events + health probe
// ---------------------------------------------------------------------------

describe("Scenario 11: compact_boundary events", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      sdkMsg({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 150000 },
        session_id: "s11",
        uuid: "u-compact",
      }),
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "ok",
        usage: { input_tokens: 5, output_tokens: 5 },
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s11",
        uuid: "u-result",
      }),
    );
  });

  it("emits compaction begin then end events from compact_boundary", async () => {
    const events = await collectEvents(makeConfig());
    const compactionEvents = events.filter((e) => e.type === "compaction");
    expect(compactionEvents).toHaveLength(2);
    expect(compactionEvents[0]).toMatchObject({
      type: "compaction",
      payload: { phase: "begin", trigger: "auto" },
    });
    expect(compactionEvents[1]).toMatchObject({
      type: "compaction",
      payload: { phase: "end", trigger: "auto" },
    });
  });

  it("emits error event when dispatcher health probe fails after compaction end", async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockRejectedValue(new Error("transport closed")),
    };

    const events = await collectEvents(
      makeConfig({ dispatcher: mockDispatcher as unknown as import("../tools/dispatcher.js").ToolDispatcher }),
    );

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      "glob",
      { pattern: "*" },
      expect.objectContaining({ cwd: expect.any(String) }),
    );

    const errorEvent = events.find(
      (e) =>
        e.type === "error" &&
        (e as { error: { code: string } }).error.code === "transport" &&
        (e as { error: { message: string } }).error.message.includes("health probe"),
    );
    expect(errorEvent).toBeDefined();
  });

  it("does NOT invoke health probe when dispatcher is absent", async () => {
    // No dispatcher — should complete without error events from health probe.
    const events = await collectEvents(makeConfig());
    const probeErrors = events.filter(
      (e) =>
        e.type === "error" &&
        (e as { error: { message: string } }).error.message.includes("health probe"),
    );
    expect(probeErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: /resume threading via RunConfig.resumeFrom
// ---------------------------------------------------------------------------

describe("Scenario 12: resume threading", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "resumed",
        usage: { input_tokens: 5, output_tokens: 5 },
        duration_ms: 50,
        duration_api_ms: 40,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "resume-session",
        uuid: "u1",
      }),
    );
  });

  it("passes resumeFrom.data.sessionId to query options.resume", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    const config = makeConfig({
      resumeFrom: {
        engineId: "claude-agent-sdk",
        data: { sessionId: "resume-session" },
      },
    });

    await collectEvents(config);

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { resume?: string };
    };
    expect(callArgs?.options?.resume).toBe("resume-session");
  });

  it("passes undefined to query options.resume when no resumeFrom", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    await collectEvents(makeConfig());

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { resume?: string };
    };
    expect(callArgs?.options?.resume).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: Non-ZodObject schemas (plugin + MCP tools)
// ---------------------------------------------------------------------------

describe("Scenario 10: non-ZodObject schema acceptance", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
    vi.clearAllMocks();
    mockQueryMessages.push(sdkMsg({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "ok",
      session_id: "s",
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });

  it("accepts ToolImpl with ZodRecord schema + derives rawShape from spec.inputSchema.properties", async () => {
    const { tool: mockTool } = await import("@anthropic-ai/claude-agent-sdk");

    const pluginTool = {
      spec: {
        name: "plugin__p__echo",
        description: "Echoes input back",
        inputSchema: {
          type: "object",
          properties: { marker: { type: "string" }, extra: { type: "number" } },
        },
        requiredPermission: "write" as const,
        tier: 3 as const,
      },
      zodSchema: z.record(z.string(), z.unknown()),
      execute: async (args: unknown) => ({
        status: "ok" as const,
        output: JSON.stringify(args),
      }),
    };

    await collectEvents(makeConfig({ tools: [pluginTool] }));

    const toolCall = (mockTool as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "plugin__p__echo",
    );
    expect(toolCall).toBeDefined();
    const rawShape = toolCall![2] as Record<string, unknown>;
    // Fields derived from inputSchema.properties — not empty.
    expect(Object.keys(rawShape).sort()).toEqual(["extra", "marker"]);
  });

  it("accepts ToolImpl with z.unknown() schema (MCP bridge path)", async () => {
    const { tool: mockTool } = await import("@anthropic-ai/claude-agent-sdk");

    const mcpTool = {
      spec: {
        name: "mcp__srv__get_time",
        description: "Returns ISO time",
        inputSchema: { type: "object", properties: {} },
        requiredPermission: "none" as const,
        tier: 4 as const,
      },
      zodSchema: z.unknown(),
      execute: async () => ({ status: "ok" as const, output: "2026-01-01T00:00:00Z" }),
    };

    await expect(collectEvents(makeConfig({ tools: [mcpTool] }))).resolves.toBeDefined();
    const toolCall = (mockTool as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "mcp__srv__get_time",
    );
    expect(toolCall).toBeDefined();
  });

  it("falls back to empty rawShape when inputSchema has no properties", async () => {
    const { tool: mockTool } = await import("@anthropic-ai/claude-agent-sdk");

    const mcpTool = {
      spec: {
        name: "mcp__srv__noarg",
        description: "No-arg tool",
        inputSchema: { type: "object" }, // no properties
        requiredPermission: "none" as const,
        tier: 4 as const,
      },
      zodSchema: z.unknown(),
      execute: async () => ({ status: "ok" as const, output: "" }),
    };

    await collectEvents(makeConfig({ tools: [mcpTool] }));
    const toolCall = (mockTool as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "mcp__srv__noarg",
    );
    expect(toolCall).toBeDefined();
    expect(Object.keys(toolCall![2] as object)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13: SYSTEM_PROMPT_DYNAMIC_BOUNDARY wiring
// ---------------------------------------------------------------------------

describe("Scenario 13: SYSTEM_PROMPT_DYNAMIC_BOUNDARY in systemPrompt", () => {
  const minimalResult = sdkMsg({
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    result: "ok",
    usage: { input_tokens: 5, output_tokens: 5 },
    duration_ms: 50,
    duration_api_ms: 40,
    is_error: false,
    num_turns: 1,
    total_cost_usd: 0,
    modelUsage: {},
    permission_denials: [],
    session_id: "s13",
    uuid: "u1",
  });

  beforeEach(() => {
    mockQueryMessages.length = 0;
    mockQueryMessages.push(minimalResult);
  });

  it("passes systemPrompt as array with BOUNDARY marker when systemPrompt is a non-empty string", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    await collectEvents(makeConfig({ systemPrompt: "You are a helpful assistant." }));

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { systemPrompt?: unknown };
    };
    const sp = callArgs?.options?.systemPrompt;
    expect(Array.isArray(sp)).toBe(true);
    const arr = sp as string[];
    expect(arr[0]).toBe("You are a helpful assistant.");
    expect(arr[1]).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
    expect(arr[2]).toBe("");
  });

  it("falls back to preset when systemPrompt is empty string", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    await collectEvents(makeConfig({ systemPrompt: "" }));

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { systemPrompt?: unknown };
    };
    const sp = callArgs?.options?.systemPrompt;
    expect(sp).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("respects user-supplied array systemPrompt without adding boundary", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    const customArray = ["static-prefix", "__CUSTOM_BOUNDARY__", "dynamic-part"];
    await collectEvents(makeConfig({ systemPrompt: customArray as unknown as string }));

    const callArgs = (mockQuery as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
      options?: { systemPrompt?: unknown };
    };
    const sp = callArgs?.options?.systemPrompt;
    expect(sp).toEqual(customArray);
  });
});

// ---------------------------------------------------------------------------
// Scenario 14: cache_hit event in stream when cacheReadInputTokens > 0
// ---------------------------------------------------------------------------

describe("Scenario 14: cache_hit + cache_miss events from engine", () => {
  beforeEach(() => {
    mockQueryMessages.length = 0;
  });

  it("emits cache_hit event when result has cacheReadInputTokens > 0", async () => {
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "ok",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 200,
        },
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s14a",
        uuid: "u1",
      }),
    );

    const events = await collectEvents(makeConfig({ systemPrompt: "sys" }));
    const cacheHit = events.find((e) => e.type === "cache_hit");
    expect(cacheHit).toBeDefined();
    expect(cacheHit?.type === "cache_hit" && cacheHit.payload.tokens).toBe(200);
  });

  it("emits cache_miss event when result has cacheWriteInputTokens > 0", async () => {
    mockQueryMessages.push(
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: "ok",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 300,
        },
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s14b",
        uuid: "u1",
      }),
    );

    const events = await collectEvents(makeConfig({ systemPrompt: "sys" }));
    const cacheMiss = events.find((e) => e.type === "cache_miss");
    expect(cacheMiss).toBeDefined();
    expect(cacheMiss?.type === "cache_miss" && cacheMiss.payload.tokens).toBe(300);
  });

  it("structuredOutput + cache boundary: both parsed JSON and cache_hit fire", async () => {
    mockQueryMessages.push(
      sdkMsg({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: '{"result":"ok"}' },
        },
        session_id: "s14c",
        uuid: "u-td",
        parent_tool_use_id: null,
      }),
      sdkMsg({
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        result: '{"result":"ok"}',
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          cache_read_input_tokens: 150,
        },
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: {},
        permission_denials: [],
        session_id: "s14c",
        uuid: "u-result",
      }),
    );

    const events = await collectEvents(
      makeConfig({
        systemPrompt: "You are a JSON assistant.",
        structuredOutput: { schema: { kind: "json-schema", schema: { type: "object" } } },
      }),
    );

    // cache_hit should be present
    const cacheHit = events.find((e) => e.type === "cache_hit");
    expect(cacheHit).toBeDefined();

    // message_stop with structuredOutput should be present
    const stop = events.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    expect((stop as { structuredOutput?: unknown }).structuredOutput).toEqual({ result: "ok" });
  });
});
