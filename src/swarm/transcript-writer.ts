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
 * And nothing was ever flushed. An acknowledged write is further along than that
 * description of it suggested — it is past the syscall and in the page cache, so
 * it survives the process dying. What it does not survive is the machine dying.
 * The sharper problem is that `record()` returns void and no caller awaits it, so
 * the tail of every burst is unacknowledged: killed there, the file is short by
 * however much the last turn produced, with nothing to say how much that was.
 *
 * What replaces it is `openDurableAppend`, which every JSONL writer in the
 * repository now shares: append-only, group-committing, `fsync` per batch.
 * Durability is therefore at batch boundaries rather than per line — which is all
 * `record()` could ever promise anyway, since it returns void and no caller
 * awaits it.
 *
 * This wrapper survives the consolidation for one reason: recording is diagnostic,
 * so a transcript that cannot be opened must degrade to no transcript rather than
 * to a failed session. `openTranscript` returns null; `openDurableAppend` throws.
 */

import { openDurableAppend, type DurableAppendStream } from "./durable-append.js";

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
 * a session that cannot be transcribed should still run. That is the whole reason
 * this exists as a wrapper rather than callers using `openDurableAppend`
 * directly — the recorder's contract is that it degrades to nothing.
 */
export async function openTranscript(filePath: string): Promise<TranscriptWriter | null> {
  let stream: DurableAppendStream;
  try {
    stream = await openDurableAppend(filePath);
  } catch {
    return null;
  }

  let closed = false;

  return {
    path: filePath,

    record(obj: unknown): void {
      if (closed) return;
      let line: string;
      try {
        line = `${JSON.stringify(obj)}\n`;
      } catch {
        // Unserializable payload — drop the line rather than the session.
        return;
      }
      stream.write(line);
    },

    flush(): Promise<void> {
      return stream.flush();
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => stream.end(() => resolve()));
    },
  };
}
