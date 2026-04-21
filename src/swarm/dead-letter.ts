import { createWriteStream, statSync, type WriteStream } from "node:fs";

export interface DeadLetterLine {
  readonly id: string;
  readonly attempts: number;
  readonly lastStatus: string;
  readonly lastError?: string;
  readonly cumulativeUsage?: { input: number; output: number };
  readonly cumulativeWallClockMs?: number;
  readonly droppedAt: number;
}

export class DeadLetterWriter {
  private stream: WriteStream;
  private readonly initialSize: number;
  private bytesWritten = 0;
  private failures = 0;

  constructor(readonly path: string) {
    // Capture pre-run file size so --allow-dead-letter evaluates DELTA only.
    try {
      this.initialSize = statSync(path).size;
    } catch {
      this.initialSize = 0;
    }
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

  /** Number of write failures encountered. */
  writeFailures(): number {
    return this.failures;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}
