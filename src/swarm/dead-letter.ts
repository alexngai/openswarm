import { openDurableAppend, type DurableAppendStream } from "./durable-append.js";

export interface DeadLetterLine {
  readonly id: string;
  readonly attempts: number;
  readonly lastStatus: string;
  readonly lastError?: string;
  readonly cumulativeUsage?: { input: number; output: number };
  readonly cumulativeWallClockMs?: number;
  readonly droppedAt: number;
}

/**
 * Append-only writer for dead-letter JSONL lines. Delta semantics are
 * per-orchestrator-instance: `hasDelta()` tracks bytes written by THIS
 * instance. Pre-existing file contents are never considered part of the
 * delta, so `--allow-dead-letter` decisions are scoped to the current run.
 *
 * Durable rather than merely appended (docs/63 `WP-07`), because this file is
 * read as evidence: `--allow-dead-letter` turns on whether a run dropped work, so
 * a line lost with the process turns a lossy run into a clean one, and the caller
 * has no way to tell. `write()` resolves against a committed line.
 *
 * The open is started in the constructor and awaited on first use. `Orchestrator`
 * builds this synchronously alongside everything else it owns, and the file is
 * created at construction as it always was.
 */
export class DeadLetterWriter {
  private readonly opening: Promise<DurableAppendStream | null>;
  private stream: DurableAppendStream | null = null;
  private failures = 0;

  constructor(readonly path: string) {
    this.opening = openDurableAppend(path).catch(() => {
      this.failures += 1;
      return null;
    });
    void this.opening.then((s) => {
      this.stream = s;
    });
  }

  async write(line: DeadLetterLine): Promise<void> {
    const stream = await this.opening;
    if (stream === null) return;
    await new Promise<void>((resolve) => {
      stream.write(`${JSON.stringify(line)}\n`, () => resolve());
    });
  }

  /** True when this run added any bytes to the dead-letter file. */
  hasDelta(): boolean {
    return (this.stream?.bytesWritten() ?? 0) > 0;
  }

  /** True when this run encountered any write failures. */
  hadWriteFailures(): boolean {
    return this.writeFailures() > 0;
  }

  /** Number of write failures encountered. */
  writeFailures(): number {
    return this.failures + (this.stream?.writeFailures() ?? 0);
  }

  async close(): Promise<void> {
    const stream = await this.opening;
    if (stream === null) return;
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
}
