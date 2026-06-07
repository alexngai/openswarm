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

  it("emits an error event on response.failed", () => {
    const out = run([
      { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } },
    ]);
    expect(out).toEqual([{ type: "error", code: "server_error", message: "boom", retryable: false }]);
  });
});
