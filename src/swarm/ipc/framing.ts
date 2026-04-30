/**
 * Framing — line-delimited JSON codec for IPC stdio.
 *
 * - encodeFrame(frame): string + "\n"
 * - LineSplitter: incremental byte-stream splitter with cap
 *
 * Rules:
 *   - Malformed lines → skipped (caller gets {error: ...} on the decode
 *     function for that line; LineSplitter just emits raw strings).
 *   - Max frame size cap (10 MiB) — lines exceeding it are rejected as
 *     malformed to prevent OOM on hostile input.
 *   - Partial line at end-of-stream → held in buffer; caller decides
 *     whether to discard or report.
 */

import type { IpcFrame } from "./protocol.js";

export const MAX_FRAME_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

export function encodeFrame(frame: IpcFrame): string {
  return JSON.stringify(frame) + "\n";
}

export type DecodeResult =
  | { ok: true; frame: IpcFrame }
  | { ok: false; error: string };

export function decodeFrame(line: string): DecodeResult {
  if (line.length > MAX_FRAME_SIZE_BYTES) {
    return { ok: false, error: `frame exceeds ${MAX_FRAME_SIZE_BYTES} bytes` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse error: ${msg}` };
  }
  if (!isPlausibleFrame(parsed)) {
    return { ok: false, error: "frame missing required fields" };
  }
  return { ok: true, frame: parsed as IpcFrame };
}

function isPlausibleFrame(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { kind?: unknown };
  return (
    o.kind === "request" || o.kind === "response" || o.kind === "notification"
  );
}

/**
 * Streaming line splitter. Feed bytes/chunks via `push(chunk)`, consume
 * complete lines via the iterator returned by `lines()`. Caller is
 * responsible for calling `flush()` at EOF if a partial line should be
 * discarded (it's dropped by default).
 */
export class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_SIZE_BYTES) {
      // Guard against unbounded growth even without a newline.
      // Reset and signal overflow via an empty emission + caller decision.
      this.buffer = "";
      throw new Error(
        `LineSplitter: buffered bytes exceeded ${MAX_FRAME_SIZE_BYTES}`,
      );
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? ""; // keep incomplete trailing
    return lines.filter((l) => l.length > 0);
  }

  /**
   * Return and clear any partial trailing content at EOF. Caller decides
   * whether to decode or discard.
   */
  flush(): string {
    const trailing = this.buffer;
    this.buffer = "";
    return trailing;
  }

  /** Whether anything is currently buffered. */
  get bufferedBytes(): number {
    return this.buffer.length;
  }
}
