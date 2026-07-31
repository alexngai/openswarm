/**
 * Durable append-only stream (docs/63 `WP-07`).
 *
 * Every JSONL writer in the repository was a `createWriteStream(p, {flags:"a"})`.
 * Measured rather than assumed, that gets more right than the `WP-07` survey
 * credited it with: the flag is `O_APPEND`, so concurrent writers do not collide,
 * and the write callback fires after the syscall, so an acknowledged line is in
 * the page cache and survives even `SIGKILL`. Two gaps are left.
 *
 * A write that has not been acknowledged yet is only in the stream's queue. Kill
 * the process there and the file is not merely short — in the probe it did not
 * exist at all. That matters because almost nothing awaits these writes: they are
 * fire-and-forget calls on an event handler, so at any moment the unacknowledged
 * tail is however much the last burst produced.
 *
 * And the page cache is not the disk. Without an `fsync` the window is a machine
 * that stops rather than a process that stops — smaller, but it is the window
 * that matters for the files these are: `results.jsonl` is the outcome record a
 * caller parses, `dead-letter.jsonl` decides whether a run silently dropped work,
 * and the two `events.jsonl` spines are what `WP-08` resumes from and `WP-12`
 * audits.
 *
 * The kernel's `FileEventStore` is deliberately not the answer for these. It owns
 * its path layout, stamps a typed envelope with a gap-free sequence, and syncs
 * per record because it answers "did this effect already run?". These writers
 * take a caller-chosen path, have their own record shapes that consumers parse,
 * and stream at `text_delta` rate. Moving them into the kernel journal would
 * break every consumer's format to buy a guarantee they do not need. What they
 * need is for the bytes to be there.
 *
 * So this is a `Writable` rather than a new interface: it drops into each call
 * site unchanged, including the ones that hand the stream to something typed as
 * `Writable`, and the migration cannot quietly change a file's shape.
 *
 * Durability is at batch boundaries. Node buffers writes that arrive while one is
 * in flight and hands them over as a group, so a burst becomes one write and one
 * `fsync` — the standard write-ahead log trade, and the right one when a
 * streaming turn produces thousands of small lines: syncing each would cost more
 * than the model call being recorded, while syncing a burst costs about what
 * syncing its last line costs. `flush()` is there for a caller that needs a
 * stronger promise at a specific point.
 */

import { Writable } from "node:stream";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface DurableAppendOptions {
  /**
   * Written once, and only by the writer that creates the file.
   *
   * Callers used to do this themselves by stat-ing for size 0 and then
   * appending, which is a race with a second writer: both see an empty file and
   * both write a header. Creation is the only fact that is exclusive, so the
   * header is tied to it.
   */
  readonly header?: unknown;
}

/**
 * An append-only stream that has actually committed what it acknowledges.
 *
 * Write failures are counted rather than thrown at the caller. These files are
 * records of work, not the work, and a full disk should not take down a run that
 * is otherwise fine — but a caller that reports on completeness needs to know
 * the record is short, so the count is readable.
 */
export class DurableAppendStream extends Writable {
  private failures = 0;
  private bytes = 0;

  constructor(
    private readonly handle: fsp.FileHandle,
    readonly path: string,
  ) {
    // decodeStrings gives _writev buffers regardless of what callers wrote.
    super({ decodeStrings: true, autoDestroy: false });
  }

  /** Bytes this stream has committed. */
  bytesWritten(): number {
    return this.bytes;
  }

  /** Write failures this stream has swallowed. */
  writeFailures(): number {
    return this.failures;
  }

  private async commit(payload: Buffer): Promise<void> {
    try {
      // One write for the batch: a write to an O_APPEND descriptor lands at the
      // end of the file as one step, which is what keeps two writers on one file
      // from interleaving inside a line.
      await this.handle.write(payload);
      await this.handle.sync();
      this.bytes += payload.length;
    } catch {
      this.failures += 1;
    }
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.commit(chunk).then(() => callback());
  }

  override _writev(
    chunks: ReadonlyArray<{ chunk: Buffer }>,
    callback: (error?: Error | null) => void,
  ): void {
    const payload = Buffer.concat(chunks.map((c) => c.chunk));
    void this.commit(payload).then(() => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.handle
      .close()
      .catch(() => {
        this.failures += 1;
      })
      .then(() => callback());
  }

  /**
   * Resolve once everything written so far is on disk.
   *
   * `write()` already resolves against a committed batch, so this is for callers
   * holding no reference to the last write — it waits for the queue to drain.
   */
  async flush(): Promise<void> {
    if (this.writableLength === 0 && !this.writableNeedDrain) return;
    await new Promise<void>((resolve) => {
      this.write(Buffer.alloc(0), () => resolve());
    });
  }
}

/**
 * Open `filePath` for durable appending, creating parent directories.
 *
 * Throws if the file cannot be opened. Callers for whom recording is diagnostic
 * rather than required should catch — `openTranscript` is the example.
 */
export async function openDurableAppend(
  filePath: string,
  options: DurableAppendOptions = {},
): Promise<DurableAppendStream> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });

  // Try to create it exclusively so "did I create this file?" is answered by the
  // filesystem rather than by a stat that another writer can invalidate.
  let handle: fsp.FileHandle;
  let created = false;
  try {
    handle = await fsp.open(filePath, "ax");
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    handle = await fsp.open(filePath, "a");
  }

  if (created) {
    // A newly created file is only durable once its directory entry is synced;
    // without this a crash can leave committed records in a file the filesystem
    // does not list.
    const dirHandle = await fsp.open(dir, "r").catch(() => null);
    if (dirHandle !== null) {
      await dirHandle.sync().catch(() => {});
      await dirHandle.close().catch(() => {});
    }
  }

  const stream = new DurableAppendStream(handle, filePath);

  if (created && options.header !== undefined) {
    stream.write(`${JSON.stringify(options.header)}\n`);
  }

  return stream;
}
