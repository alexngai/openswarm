/**
 * Orchestrator — drives a batch of TaskPackets through the WorkerPool,
 * streaming results to a JSONL file as each task completes.
 *
 * Signal handling (M1):
 *   - First SIGINT: closes the pool (no new acquires), in-flight tasks
 *     continue until their subprocess exits naturally or is killed by
 *     handle.kill(). The spawner uses detached:false so children are
 *     reaped when the orchestrator exits.
 *   - Second SIGINT: force-exits with code 130.
 *
 * TODO (post-M1): unified SIGTERM → SIGKILL escalation with configurable
 *   grace period. For now, handle.kill() sends SIGTERM and the OS reaps.
 */

import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { PermissionMode } from "../core/types.js";
import type { AgentResult, TaskPacket } from "./host.js";
import type { LaneEvent } from "./events.js";
import { StandaloneHost } from "./standalone-host.js";
import { WorkerPool } from "./worker-pool.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  readonly concurrency: number;
  readonly permissionMode: PermissionMode;
  readonly resultsOut: Writable;
  readonly eventsOut?: Writable;
  /** Inject a pre-built host for testing. */
  readonly host?: StandaloneHost;
}

export interface RunResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly timeout: number;
  readonly cancelled: number;
  readonly resultWriteFailures: number;
}

export interface ResultLine {
  readonly id: string;
  readonly status: "succeeded" | "failed" | "timeout" | "cancelled";
  readonly output?: string;
  readonly error?: string;
  readonly usage?: import("../core/types.js").Usage;
  readonly wallClockMs: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly completedAt: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator extends EventEmitter {
  private readonly host: StandaloneHost;
  private readonly pool: WorkerPool;
  private resultWriteFailures = 0;
  private shuttingDown = false;
  private sigintHandler?: () => void;

  constructor(private readonly opts: OrchestratorOptions) {
    super();
    this.host = opts.host ?? new StandaloneHost({ permissionMode: opts.permissionMode });
    this.pool = new WorkerPool(opts.concurrency);
    // Prevent resultsOut stream errors from becoming uncaught exceptions.
    // Write errors are surfaced via the writeResult() promise rejection instead.
    opts.resultsOut.on("error", () => {
      // Handled in writeResult(); swallow here to avoid double-reporting.
    });
  }

  /**
   * Run a batch of tasks, streaming results.jsonl as they complete.
   * Resolves when every task has reached a terminal state.
   */
  async run(tasks: readonly TaskPacket[]): Promise<RunResult> {
    // Install SIGINT handler for graceful shutdown.
    this.sigintHandler = () => {
      if (this.shuttingDown) {
        // Second Ctrl-C — force exit.
        process.stderr.write("[swarm-coder] second SIGINT — forcing exit\n");
        process.exit(130);
      }
      this.shuttingDown = true;
      process.stderr.write(
        "[swarm-coder] SIGINT received; draining workers...\n",
      );
      this.pool.close();
    };
    process.once("SIGINT", this.sigintHandler);

    const counts = { succeeded: 0, failed: 0, timeout: 0, cancelled: 0 };
    let firstResultWriteError: unknown;

    // Kick off all tasks concurrently — pool.acquire() gates the actual spawn.
    const runs = tasks.map(async (task) => {
      let token;
      try {
        token = await this.pool.acquire();
      } catch {
        // Pool closed before we got a slot — cancelled.
        const line = this.buildCancelled(task);
        await this.writeResult(line).catch((e) => {
          firstResultWriteError ??= e;
        });
        counts.cancelled++;
        return;
      }

      if (this.shuttingDown) {
        token.release();
        const line = this.buildCancelled(task);
        await this.writeResult(line).catch((e) => {
          firstResultWriteError ??= e;
        });
        counts.cancelled++;
        return;
      }

      const startedAt = Date.now();
      let result: AgentResult;
      let handle;
      try {
        // NOTE: we intentionally omit `taskId` — StandaloneHost treats
        // non-undefined taskId as "look up an EXISTING record", which we
        // don't have (orchestrator-level task ids are user-supplied and
        // never registered here). Letting the host create a fresh
        // TaskRecord is fine; result lines still use `task.id` from the
        // user's input via buildResultLine().
        handle = await this.host.spawn({
          task,
          permissionMode: this.opts.permissionMode,
          parentAgentId: this.host.agentId,
        });
        result = await handle.wait();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          status: "failure",
          error: msg,
          wallClockMs: Date.now() - startedAt,
        };
      } finally {
        token.release();
      }

      const line = this.buildResultLine(
        task,
        result,
        handle?.agentId,
        handle?.sessionId,
      );
      await this.writeResult(line).catch((e) => {
        firstResultWriteError ??= e;
      });
      switch (line.status) {
        case "succeeded":
          counts.succeeded++;
          break;
        case "failed":
          counts.failed++;
          break;
        case "timeout":
          counts.timeout++;
          break;
        case "cancelled":
          counts.cancelled++;
          break;
      }
    });

    await Promise.all(runs);

    // Clean up SIGINT handler.
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = undefined;
    }

    if (firstResultWriteError) {
      process.stderr.write(
        `[swarm-coder] ${this.resultWriteFailures} task result(s) failed to persist; first error: ${String(firstResultWriteError)}\n`,
      );
    }

    return { ...counts, resultWriteFailures: this.resultWriteFailures };
  }

  private async writeResult(line: ResultLine): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify(line) + "\n";
      this.opts.resultsOut.write(payload, (err) => {
        if (err) {
          this.resultWriteFailures++;
          // Emit an error lane event to eventsOut if available.
          if (this.opts.eventsOut) {
            const event: LaneEvent = {
              ts: Date.now(),
              agentId: this.host.agentId,
              type: "error",
              payload: {
                class: "transport",
                message: `results.jsonl write failed for task ${line.id}: ${err.message}`,
                retryable: false,
              },
            };
            this.opts.eventsOut.write(JSON.stringify(event) + "\n", () => {
              // Swallow eventsOut write errors — best-effort diagnostic only.
            });
          }
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private buildResultLine(
    task: TaskPacket,
    result: AgentResult,
    agentId: string | undefined,
    sessionId: string | undefined,
  ): ResultLine {
    const base = {
      id: task.id,
      agentId: agentId ?? "unknown",
      sessionId: sessionId ?? "unknown",
      completedAt: Date.now(),
    };
    switch (result.status) {
      case "success":
        return {
          ...base,
          status: "succeeded",
          output: result.output,
          usage: result.usage,
          wallClockMs: result.wallClockMs,
        };
      case "failure":
        return {
          ...base,
          status: "failed",
          error: result.error,
          ...(result.partialOutput !== undefined && {
            output: result.partialOutput,
          }),
          ...(result.usage !== undefined && { usage: result.usage }),
          wallClockMs: result.wallClockMs,
        };
      case "timeout":
        return {
          ...base,
          status: "timeout",
          error: "task exceeded wall-clock budget",
          ...(result.partialOutput !== undefined && {
            output: result.partialOutput,
          }),
          ...(result.usage !== undefined && { usage: result.usage }),
          wallClockMs: result.wallClockMs,
        };
      case "killed":
        return {
          ...base,
          status: "cancelled",
          wallClockMs: result.wallClockMs,
        };
    }
  }

  private buildCancelled(task: TaskPacket): ResultLine {
    return {
      id: task.id,
      status: "cancelled",
      wallClockMs: 0,
      agentId: this.host.agentId,
      sessionId: "none",
      completedAt: Date.now(),
    };
  }
}
