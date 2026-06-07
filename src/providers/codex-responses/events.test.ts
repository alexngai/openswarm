import { describe, it, expect } from "vitest";
import { CodexEventTranslator } from "./events.js";
import type { CodexSseEvent } from "./types.js";
import type { ProviderEvent } from "../index.js";

function run(events: CodexSseEvent[]): ProviderEvent[] {
  const t = new CodexEventTranslator();
  return events.flatMap((e) => t.translate(e));
}

describe("CodexEventTranslator", () => {
  it("maps output_text deltas to text-delta", () => {
    const out = run([
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
    ]);
    expect(out).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
    ]);
  });

  it("surfaces reasoning text as reasoning-delta", () => {
    const out = run([{ type: "response.reasoning_text.delta", delta: "thinking" }]);
    expect(out).toEqual([{ type: "reasoning-delta", text: "thinking" }]);
  });

  it("correlates a streamed tool call by item_id and emits call_id downstream", () => {
    const out = run([
      {
        type: "response.output_item.added",
        item: { id: "fc_1", type: "function_call", call_id: "call_abc", name: "get_weather" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"ci' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: 'ty":"Paris"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"city":"Paris"}' },
    ]);
    expect(out).toEqual([
      { type: "tool-input-start", id: "call_abc", name: "get_weather" },
      { type: "tool-input-delta", id: "call_abc", delta: '{"ci' },
      { type: "tool-input-delta", id: "call_abc", delta: 'ty":"Paris"}' },
      { type: "tool-call", id: "call_abc", name: "get_weather", input: { city: "Paris" } },
    ]);
  });

  it("falls back to accumulated args when the done event omits them", () => {
    const out = run([
      {
        type: "response.output_item.added",
        item: { id: "fc_2", type: "function_call", call_id: "call_x", name: "noop" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: "{}" },
      { type: "response.function_call_arguments.done", item_id: "fc_2" },
    ]);
    expect(out.at(-1)).toEqual({ type: "tool-call", id: "call_x", name: "noop", input: {} });
  });

  it("finish is tool_use when a tool call occurred", () => {
    const out = run([
      {
        type: "response.output_item.added",
        item: { id: "fc_3", type: "function_call", call_id: "c3", name: "t" },
      },
      { type: "response.function_call_arguments.done", item_id: "fc_3", arguments: "{}" },
      { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } },
    ]);
    expect(out.at(-1)).toEqual({
      type: "finish",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });

  it("finish is end_turn for plain text and carries cached tokens", () => {
    const out = run([
      { type: "response.output_text.delta", delta: "ok" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 96 } },
        },
      },
    ]);
    expect(out.at(-1)).toEqual({
      type: "finish",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 96 },
    });
  });

  it("maps max-output-tokens truncation to max_tokens", () => {
    const out = run([
      {
        type: "response.completed",
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: {} },
      },
    ]);
    expect((out.at(-1) as { stopReason: string }).stopReason).toBe("max_tokens");
  });

  it("handles two sequential tool calls in one turn without cross-talk", () => {
    const out = run([
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_a", name: "x" } },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"a":1}' },
      { type: "response.output_item.added", item: { id: "fc_2", type: "function_call", call_id: "call_b", name: "y" } },
      { type: "response.function_call_arguments.done", item_id: "fc_2", arguments: '{"b":2}' },
      { type: "response.completed", response: { usage: {} } },
    ]);
    const calls = out.filter((e) => e.type === "tool-call");
    expect(calls).toEqual([
      { type: "tool-call", id: "call_a", name: "x", input: { a: 1 } },
      { type: "tool-call", id: "call_b", name: "y", input: { b: 2 } },
    ]);
    expect(out.at(-1)).toMatchObject({ stopReason: "tool_use" });
  });

  it("interleaves reasoning then a tool call in order", () => {
    const out = run([
      { type: "response.reasoning_text.delta", delta: "hmm" },
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "c", name: "t" } },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" },
      { type: "response.completed", response: {} },
    ]);
    expect(out.map((e) => e.type)).toEqual(["reasoning-delta", "tool-input-start", "tool-call", "finish"]);
  });

  it("falls back to output_item.done when function_call_arguments.done is dropped (C3)", () => {
    const out = run([
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "c1", name: "t" } },
      // no function_call_arguments.done — only the item.done arrives
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", call_id: "c1", name: "t", arguments: '{"k":1}' } },
      { type: "response.completed", response: {} },
    ]);
    expect(out).toContainEqual({ type: "tool-call", id: "c1", name: "t", input: { k: 1 } });
    expect(out.at(-1)).toMatchObject({ stopReason: "tool_use" });
  });

  it("does not double-emit when both args.done and item.done arrive", () => {
    const out = run([
      { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "c1", name: "t" } },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: "{}" },
      { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", call_id: "c1", name: "t", arguments: "{}" } },
    ]);
    expect(out.filter((e) => e.type === "tool-call")).toHaveLength(1);
  });

  it("maps the top-level error event variant", () => {
    const out = run([{ type: "error", error: { code: "rate_limit", message: "slow" } }]);
    expect(out).toEqual([{ type: "error", code: "provider_unavailable", message: "slow", retryable: true }]);
  });

  it("completed with no usage yields zeroed usage and no cache key", () => {
    const out = run([{ type: "response.completed", response: {} }]);
    expect(out.at(-1)).toEqual({ type: "finish", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  it("maps response.failed to a known engine code; transient codes stay retryable", () => {
    expect(run([{ type: "response.failed", response: { error: { code: "server_error", message: "boom" } } }])).toEqual([
      { type: "error", code: "provider_unavailable", message: "boom", retryable: true },
    ]);
    // Non-transient failure → not retryable, still a known code.
    expect(run([{ type: "response.failed", response: { error: { code: "invalid", message: "nope" } } }])).toEqual([
      { type: "error", code: "provider_unavailable", message: "nope", retryable: false },
    ]);
  });
});
