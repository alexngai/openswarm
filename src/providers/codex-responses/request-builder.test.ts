import { describe, it, expect } from "vitest";
import { buildCodexRequest } from "./request-builder.js";
import type { ProviderRequest, ProviderMessage } from "../index.js";
import type { ToolSpec } from "../../core/types.js";

function req(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    messages: [],
    model: "gpt-5.5",
    ...overrides,
  };
}

describe("buildCodexRequest", () => {
  it("always sets the mandatory codex invariants", () => {
    const body = buildCodexRequest(req());
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("folds systemPrompt into instructions (not a message)", () => {
    const body = buildCodexRequest(req({ systemPrompt: ["You are ", "helpful."] }));
    expect(body.instructions).toBe("You are helpful.");
    expect(body.input).toHaveLength(0);
  });

  it("sets prompt_cache_key from sessionId for cache affinity", () => {
    const body = buildCodexRequest(req(), { sessionId: "sess-123" });
    expect(body.prompt_cache_key).toBe("sess-123");
  });

  it("omits prompt_cache_key when no sessionId", () => {
    const body = buildCodexRequest(req());
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it("maps tools to the flat Responses function shape", () => {
    const tool: ToolSpec = {
      name: "get_weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
      requiredPermission: "none",
      tier: 1,
    };
    const body = buildCodexRequest(req({ tools: [tool] }));
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "get_weather",
      description: "Get weather",
      parameters: tool.inputSchema,
      strict: false,
    });
  });

  it("converts a user text message to an input_text message item", () => {
    const msg: ProviderMessage = { role: "user", content: [{ type: "text", text: "hi" }] };
    const body = buildCodexRequest(req({ messages: [msg] }));
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("converts assistant tool_use → function_call and user tool_result → function_call_output", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "18C" }],
      },
    ];
    const body = buildCodexRequest(req({ messages }));
    expect(body.input).toEqual([
      {
        type: "function_call",
        id: expect.stringMatching(/^fc_[0-9a-f]{32}$/),
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"city":"Paris"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "18C" },
    ]);
  });

  it("synthesizes a deterministic fc_* item id for replayed function_call items", () => {
    const msg: ProviderMessage = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_ABC", name: "t", input: {} }],
    };
    const a = buildCodexRequest(req({ messages: [msg] })).input[0];
    const b = buildCodexRequest(req({ messages: [msg] })).input[0];
    expect(a).toMatchObject({ type: "function_call", id: expect.stringMatching(/^fc_[0-9a-f]{32}$/) });
    expect(a).toEqual(b); // deterministic
  });

  it("prefixes error tool_results so the model sees the failure", () => {
    const msg: ProviderMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_9", content: "boom", is_error: true }],
    };
    const body = buildCodexRequest(req({ messages: [msg] }));
    expect(body.input[0]).toEqual({ type: "function_call_output", call_id: "call_9", output: "ERROR: boom" });
  });

  it("maps toolChoice variants", () => {
    expect(buildCodexRequest(req({ toolChoice: "required" })).tool_choice).toBe("required");
    expect(buildCodexRequest(req({ toolChoice: { name: "x" } })).tool_choice).toEqual({
      type: "function",
      name: "x",
    });
    expect(buildCodexRequest(req()).tool_choice).toBe("auto");
  });
});
