/**
 * SSE parser for the codex Responses stream.
 *
 * Reads a byte stream (e.g. `Response.body`), splits on blank-line frame
 * boundaries, and yields the JSON object from each `data:` line. `[DONE]`
 * sentinels and non-data frames are skipped. Pure transform — no network.
 */

import type { CodexSseEvent } from "./types.js";

/** Yield parsed SSE event objects from a Uint8Array byte stream. */
export async function* parseCodexSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<CodexSseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev !== undefined) yield ev;
    }
  }
  // Flush a trailing frame with no terminating blank line.
  const tail = parseFrame(buf);
  if (tail !== undefined) yield tail;
}

function parseFrame(frame: string): CodexSseEvent | undefined {
  const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine === undefined) return undefined;
  const data = dataLine.slice(5).trim();
  if (data === "" || data === "[DONE]") return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (parsed !== null && typeof parsed === "object" && "type" in parsed) {
      return parsed as CodexSseEvent;
    }
  } catch {
    // Ignore malformed frames — the stream may interleave keep-alives.
  }
  return undefined;
}
