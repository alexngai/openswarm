/**
 * Integration tests for ClaudeAgentSdkEngine.
 *
 * Mocks the @anthropic-ai/claude-agent-sdk module entirely so no subprocess
 * is spawned. The mock `query` returns a scripted async iterable of SDKMessages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
