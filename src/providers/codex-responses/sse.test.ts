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

  it("handles CRLF line endings and frame boundaries", async () => {
    const out = await collect(
      parseCodexSse(bytes('event: x\r\ndata: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\n')),
    );
    expect(out.map((e) => e.type)).toEqual(["a", "b"]);
  });

  it("concatenates a payload split across multiple data: lines", async () => {
    const out = await collect(parseCodexSse(bytes('data: {"type":"big",\ndata: "x":1}\n\n')));
    expect(out).toEqual([{ type: "big", x: 1 }]);
  });

  it("reassembles a multibyte char split across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const full = enc.encode('data: {"type":"t","e":"😀"}\n\n');
    // Split inside the emoji's 4-byte sequence.
    const cut = full.indexOf(0xf0); // first byte of 😀
    async function* split(): AsyncGenerator<Uint8Array> {
      yield full.slice(0, cut + 2);
      yield full.slice(cut + 2);
    }
    const out = await collect(parseCodexSse(split()));
    expect(out).toEqual([{ type: "t", e: "😀" }]);
  });
});
