import { createWriteStream, type WriteStream } from "node:fs";

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
 */
export class DeadLetterWriter {
  private stream: WriteStream;
  private bytesWritten = 0;
  private failures = 0;

  constructor(readonly path: string) {
    this.stream = createWriteStream(path, { flags: "a" });
    this.stream.on("error", () => {
      this.failures += 1;
    });
  }

  async write(line: DeadLetterLine): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(line) + "\n";
      this.stream.write(payload, (err) => {
        if (err) {
          this.failures += 1;
          reject(err);
          return;
        }
        this.bytesWritten += Buffer.byteLength(payload);
        resolve();
      });
    });
  }

  /** True when this run added any bytes to the dead-letter file. */
  hasDelta(): boolean {
    return this.bytesWritten > 0;
  }

  /** True when this run encountered any write failures. */
  hadWriteFailures(): boolean {
    return this.failures > 0;
  }

  /** Number of write failures encountered. */
  writeFailures(): number {
    return this.failures;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
