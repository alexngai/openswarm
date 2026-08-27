import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { runHeadless } from "./headless.js";
import type { NormalizedEvent } from "../core/types.js";

function makeCollector(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0),
  };
}

async function* makeStream(
  events: NormalizedEvent[],
): AsyncIterable<NormalizedEvent> {
  for (const event of events) {
    yield event;
  }
}

describe("runHeadless", () => {
  it("writes one JSONL object per event", async () => {
    const { stream, lines } = makeCollector();
    const events: NormalizedEvent[] = [
      { type: "text_delta", text: "hello" },
      { type: "text_delta", text: " world" },
    ];
    await runHeadless(makeStream(events), { out: stream });
    expect(lines()).toHaveLength(2);
  });

  it("each line is valid JSON parseable back to the original event", async () => {
    const { stream, lines } = makeCollector();
    const events: NormalizedEvent[] = [
      { type: "text_delta", text: "hello" },
      {
        type: "tool_use_start",
        id: "tool-1",
        name: "read_file",
      },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ];
    await runHeadless(makeStream(events), { out: stream });
    const parsed = lines().map((l) => JSON.parse(l) as NormalizedEvent);
    expect(parsed).toEqual(events);
  });

  it("terminates cleanly when the generator ends", async () => {
    const { stream, lines } = makeCollector();
    await runHeadless(makeStream([]), { out: stream });
    expect(lines()).toHaveLength(0);
  });

  it("handles the error event variant", async () => {
    const { stream, lines } = makeCollector();
    const events: NormalizedEvent[] = [
      {
        type: "error",
        error: {
          code: "unknown",
          message: "something went wrong",
          retryable: false,
        },
      },
    ];
    await runHeadless(makeStream(events), { out: stream });
    const parsed = lines().map((l) => JSON.parse(l) as NormalizedEvent);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe("error");
    const errEvt = parsed[0] as Extract<NormalizedEvent, { type: "error" }>;
    expect(errEvt.error.message).toBe("something went wrong");
  });

  it("emits events in order without buffering", async () => {
    const { stream, lines } = makeCollector();
    const texts = ["a", "b", "c", "d", "e"];
    const events: NormalizedEvent[] = texts.map((t) => ({
      type: "text_delta",
      text: t,
    }));
    await runHeadless(makeStream(events), { out: stream });
    const parsed = lines().map((l) => JSON.parse(l) as NormalizedEvent);
    expect(parsed.map((e) => (e as { type: "text_delta"; text: string }).text)).toEqual(texts);
  });

  it("adds reconstructed tool input to tool_use_end", async () => {
    const { stream, lines } = makeCollector();
    const events: NormalizedEvent[] = [
      { type: "tool_use_start", id: "tool-1", name: "bash" },
      { type: "tool_use_input", id: "tool-1", jsonDelta: '{"command":' },
      { type: "tool_use_input", id: "tool-1", jsonDelta: '"pwd"}' },
      { type: "tool_use_end", id: "tool-1" },
    ];
    await runHeadless(makeStream(events), { out: stream });
    const parsed = lines().map((l) => JSON.parse(l) as NormalizedEvent);
    expect(parsed[3]).toEqual({
      type: "tool_use_end",
      id: "tool-1",
      input: { command: "pwd" },
    });
  });
});
