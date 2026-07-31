/**
 * TranscriptWriter — the durable append path for session transcripts
 * (docs/63 `WP-07`).
 *
 * Transcripts were written through `createWriteStream`, which got three things
 * wrong at once.
 *
 * It opened for write rather than append, so every recorder that touched an
 * existing session truncated it. A long-lived worker records each turn under one
 * session id and the REPL reopens a session it is resuming, so in both cases the
 * history was deleted and replaced by the newest turn — silently, because the
 * write itself succeeded.
 *
 * Two streams on one file each kept their own offset, so two workers recording
 * the same session overwrote each other's bytes instead of appending. The result
 * was not interleaved lines, which would at least be recoverable; it was one
 * writer's events replaced by the other's at whatever offsets happened to
 * collide.
 *
 * And nothing was ever flushed. A stream acknowledges a write when it lands in a
 * userspace buffer, so a crash dropped whatever had not made it to the kernel,
 * with no way to tell how much that was.
 *
 * What replaces it is a group-committing appender. Lines queue, and the queue is
 * drained on the next tick as one write followed by one `fsync`. That is the
 * standard write-ahead log trade and it is the right one here specifically
 * because `text_delta` is recorded: a transcript is thousands of small lines, so
 * syncing each one would cost more than the model call it is recording, while
 * syncing a burst costs about the same as syncing its last line. Durability is
 * therefore at batch boundaries rather than per line — which is all `record()`
 * could ever promise anyway, since it returns void and no caller awaits it.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Cap on a single write. A write to an `O_APPEND` descriptor lands at the end of
 * the file as one indivisible step, which is what keeps two writers from
 * corrupting each other — but that holds for a write the kernel does not split,
 * so batches are bounded rather than unlimited.
 */
const MAX_BATCH_BYTES = 64 * 1024;

export interface TranscriptWriter {
  /** Queue a line. Never throws, never blocks the caller. */
  record(obj: unknown): void;
  /** Resolve once everything queued so far is on disk. */
  flush(): Promise<void>;
  /** Flush and release the descriptor. */
  close(): Promise<void>;
  readonly path: string;
}

/**
 * Open `filePath` for durable appending, creating parent directories.
 *
 * Returns null when the file cannot be opened, because recording is diagnostic:
 * a session that cannot be transcribed should still run.
 */
export async function openTranscript(filePath: string): Promise<TranscriptWriter | null> {
  let handle: fsp.FileHandle;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // "a" is O_APPEND: every write goes to the current end of the file, decided
    // by the kernel at write time rather than by a remembered offset.
    handle = await fsp.open(filePath, "a");
  } catch {
    return null;
  }

  let queue: Buffer[] = [];
  let queued = 0;
  let draining: Promise<void> | null = null;
  let closed = false;

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      // Take whole lines up to the cap. A line is never split across batches:
      // half a line on disk is unparseable and takes its neighbour with it.
      const batch: Buffer[] = [];
      let bytes = 0;
      while (queue.length > 0 && (batch.length === 0 || bytes + queue[0]!.length <= MAX_BATCH_BYTES)) {
        const next = queue.shift()!;
        batch.push(next);
        bytes += next.length;
      }
      queued -= bytes;
      try {
        await handle.write(Buffer.concat(batch));
        await handle.sync();
      } catch {
        // The transcript is diagnostic. Losing it must not take the session with
        // it, and retrying a failed write forever would.
      }
    }
    draining = null;
  };

  const schedule = (): void => {
    if (draining !== null || closed) return;
    // Coalesce the burst that a streaming turn produces: everything recorded
    // before the next tick becomes one write and one sync.
    draining = Promise.resolve().then(drain);
  };

  const flush = async (): Promise<void> => {
    if (draining !== null) await draining;
    if (queue.length > 0) await drain();
  };

  return {
    path: filePath,
    flush,

    record(obj: unknown): void {
      if (closed) return;
      let line: Buffer;
      try {
        line = Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
      } catch {
        // Unserializable payload — drop the line rather than the session.
        return;
      }
      queue.push(line);
      queued += line.length;
      schedule();
    },

    async close(): Promise<void> {
      if (closed) return;
      await flush();
      closed = true;
      queue = [];
      queued = 0;
      await handle.close().catch(() => {});
    },
  };
}
