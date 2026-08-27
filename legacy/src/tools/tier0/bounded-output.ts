/**
 * Memory-bounded capture of a child process's output.
 *
 * The tools that read from a child used to push every chunk into an array and
 * truncate at close. Truncation at close bounds what the *model* sees, which is
 * a different property from bounding what the process can make us hold: a
 * command that writes faster than it exits — `yes`, a build with progress
 * spam, `cat` on a large file — grows the array until the harness dies, and it
 * dies before the truncation that was supposed to protect it ever runs. A
 * persistent shell session is worse, since it holds its buffers for the
 * session's lifetime rather than one command's.
 *
 * So the bound belongs on the read path. This keeps a head and a tail and
 * discards the middle as it arrives, which is the same shape the truncation at
 * close produced, decided early enough to matter.
 *
 * Retention is deliberately far larger than the ~30k chars a tool result shows.
 * Any output that fits in the retained window is preserved byte for byte, so
 * every case that used to work is unaffected and the discarding path is
 * reached only by output that was going to be truncated anyway.
 */

/** Bytes retained at each end. Output within one window is kept whole. */
export const DEFAULT_RETAIN_BYTES = 256 * 1024;

export interface BoundedOutputOptions {
  /** Bytes kept from the start of the stream. */
  readonly headBytes?: number;
  /** Bytes kept from the end of the stream. */
  readonly tailBytes?: number;
}

/**
 * Accumulates a byte stream in bounded memory, keeping the first `headBytes`
 * and the last `tailBytes` and counting what it drops in between.
 */
export class BoundedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;

  private readonly headChunks: Buffer[] = [];
  private headBytes = 0;

  /** Most recent bytes, oldest first. Trimmed from the front as it grows. */
  private tailChunks: Buffer[] = [];
  private tailBytes = 0;

  private total = 0;
  private dropped = 0;

  constructor(options: BoundedOutputOptions = {}) {
    this.headLimit = options.headBytes ?? DEFAULT_RETAIN_BYTES;
    this.tailLimit = options.tailBytes ?? DEFAULT_RETAIN_BYTES;
  }

  /** Total bytes the process wrote, including bytes since discarded. */
  get totalBytes(): number {
    return this.total;
  }

  /** Bytes discarded from the middle. Zero while everything still fits. */
  get droppedBytes(): number {
    return this.dropped;
  }

  /** Whether anything has been discarded, i.e. whether `bytes()` is a gap. */
  get truncated(): boolean {
    return this.dropped > 0;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;

    // Fill the head first, splitting the chunk that crosses the boundary so the
    // head is exactly `headLimit` rather than however far a chunk happened to
    // reach.
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const room = this.headLimit - this.headBytes;
      const take = rest.subarray(0, room);
      this.headChunks.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
      if (rest.length === 0) return;
    }

    this.tailChunks.push(rest);
    this.tailBytes += rest.length;
    this.trimTail();
  }

  /**
   * Drop whole chunks, then partially consume one, until the tail is within
   * its limit. Trimming here rather than at read time keeps the high-water
   * mark bounded instead of merely the reported result.
   */
  private trimTail(): void {
    while (this.tailBytes > this.tailLimit) {
      const oldest = this.tailChunks[0]!;
      const excess = this.tailBytes - this.tailLimit;
      if (oldest.length <= excess) {
        this.tailChunks.shift();
        this.tailBytes -= oldest.length;
        this.dropped += oldest.length;
        continue;
      }
      this.tailChunks[0] = oldest.subarray(excess);
      this.tailBytes -= excess;
      this.dropped += excess;
    }
  }

  /**
   * Retained bytes, head followed by tail. When nothing was dropped this is
   * the complete stream; otherwise the two ends are adjacent with the gap
   * described by `droppedBytes`.
   */
  bytes(): Buffer {
    return Buffer.concat([...this.headChunks, ...this.tailChunks]);
  }

  /** Retained bytes as UTF-8. */
  text(): string {
    return this.bytes().toString("utf8");
  }

  /** Retained head and tail separately, for callers inserting their own marker. */
  parts(): { readonly head: Buffer; readonly tail: Buffer } {
    return {
      head: Buffer.concat(this.headChunks),
      tail: Buffer.concat(this.tailChunks),
    };
  }

  reset(): void {
    this.headChunks.length = 0;
    this.headBytes = 0;
    this.tailChunks = [];
    this.tailBytes = 0;
    this.total = 0;
    this.dropped = 0;
  }
}
