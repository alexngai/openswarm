import { describe, it, expect } from "vitest";
import { parseCodexSse } from "./sse.js";
import type { CodexSseEvent } from "./types.js";

async function* bytes(...chunks: string[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  for (const c of chunks) yield enc.encode(c);
}

async function collect(it: AsyncIterable<CodexSseEvent>): Promise<CodexSseEvent[]> {
  const out: CodexSseEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("parseCodexSse", () => {
  it("parses well-formed data frames", async () => {
    const out = await collect(
      parseCodexSse(
        bytes(
          'event: x\ndata: {"type":"response.created"}\n\n',
          'data: {"type":"response.completed","response":{}}\n\n',
        ),
      ),
    );
    expect(out.map((e) => e.type)).toEqual(["response.created", "response.completed"]);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const out = await collect(parseCodexSse(bytes('data: {"type":"resp', 'onse.created"}\n\n')));
    expect(out).toEqual([{ type: "response.created" }]);
  });

  it("skips [DONE] sentinels and non-data frames", async () => {
    const out = await collect(parseCodexSse(bytes("data: [DONE]\n\n", ": keep-alive\n\n")));
    expect(out).toHaveLength(0);
  });

  it("ignores malformed JSON without throwing", async () => {
    const out = await collect(
      parseCodexSse(bytes("data: {not json}\n\n", 'data: {"type":"ok"}\n\n')),
    );
    expect(out).toEqual([{ type: "ok" }]);
  });

  it("flushes a trailing frame with no terminating blank line", async () => {
    const out = await collect(parseCodexSse(bytes('data: {"type":"tail"}')));
    expect(out).toEqual([{ type: "tail" }]);
  });
});
