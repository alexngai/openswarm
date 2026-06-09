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
    // Normalize CRLF → LF so frame-boundary (`\n\n`) detection and per-line
    // parsing work regardless of the server's line endings. Raw `\r` is only a
    // line-ending here (JSON escapes any literal CR as `\r`), so this is safe.
    buf += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
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
  // Per the SSE spec a single event's payload may span multiple `data:` lines,
  // which the client concatenates with `\n`. Collect them all rather than only
  // the first (large payloads can be split this way).
  const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
  if (dataLines.length === 0) return undefined;
  const data = dataLines
    .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)))
    .join("\n")
    .trim();
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
