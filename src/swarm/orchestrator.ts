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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import type { PermissionMode } from "../core/types.js";
import type { AgentResult, TaskPacket, BranchPolicy, CommitPolicy } from "./host.js";
import type { LaneEvent } from "./events.js";
import { StandaloneHost } from "./standalone-host.js";
import { WorkerPool } from "./worker-pool.js";
import { planRetry } from "./retry-policy.js";
import { DeadLetterWriter } from "./dead-letter.js";

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
  /** Path for dead-letter JSONL file. Default: ./dead-letter.jsonl */
  readonly deadLetterPath?: string;
  /**
   * When true, a non-empty dead-letter delta does NOT cause the run to exit
   * non-zero. Default: false.
   */
  readonly allowDeadLetter?: boolean;
}

export interface RunResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly timeout: number;
  readonly cancelled: number;
  readonly resultWriteFailures: number;
  /** True when tasks were written to dead-letter AND allowDeadLetter is false. */
  readonly deadLetterViolation: boolean;
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
  /** Present when a task was cancelled via task_stop; identifies who stopped it. */
  readonly stoppedBy?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator extends EventEmitter {
  private readonly host: StandaloneHost;
  private readonly pool: WorkerPool;
  private readonly deadLetter: DeadLetterWriter;
  private resultWriteFailures = 0;
  private shuttingDown = false;
  private sigintHandler?: () => void;

  // Per-task retry state (keyed by task.id).
  private readonly attempts = new Map<string, number>();
  private readonly cumulativeTokens = new Map<string, number>();
  private readonly perAttemptDurations = new Map<string, number[]>();

  constructor(private readonly opts: OrchestratorOptions) {
    super();
    this.host = opts.host ?? new StandaloneHost({ permissionMode: opts.permissionMode });
    this.pool = new WorkerPool(opts.concurrency);
    this.deadLetter = new DeadLetterWriter(opts.deadLetterPath ?? "./dead-letter.jsonl");
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

      // Pre-flight policy validation before spawn.
      const preflightError = this.runPreflightValidators(task);
      if (preflightError !== null) {
        token.release();
        const line: ResultLine = {
          id: task.id,
          status: "failed",
          error: preflightError,
          wallClockMs: 0,
          agentId: this.host.agentId,
          sessionId: "none",
          completedAt: Date.now(),
        };
        await this.writeResult(line).catch((e) => {
          firstResultWriteError ??= e;
        });
        counts.failed++;
        return;
      }

      // Initialize per-task retry state.
      this.attempts.set(task.id, 0);
      this.cumulativeTokens.set(task.id, 0);
      this.perAttemptDurations.set(task.id, []);

      let finalResult: AgentResult | undefined;
      let finalHandle: Awaited<ReturnType<StandaloneHost["spawn"]>> | undefined;

      // Retry loop — runs at least once.
      retryLoop: while (true) {
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
        }

        const attemptDurationMs = Date.now() - startedAt;
        this.perAttemptDurations.get(task.id)!.push(attemptDurationMs);

        const isFailure =
          result.status === "failure" ||
          result.status === "timeout" ||
          result.status === "killed";

        if (!isFailure || task.escalationPolicy.kind === "none") {
          // Success, cancelled, or no-retry policy — exit the loop.
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        // Accumulate token usage.
        if ("usage" in result && result.usage != null) {
          const prev = this.cumulativeTokens.get(task.id) ?? 0;
          this.cumulativeTokens.set(
            task.id,
            prev + (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          );
        }

        // Budget exhaustion checks.
        const cumTokens = this.cumulativeTokens.get(task.id) ?? 0;
        const cumWallClock = (this.perAttemptDurations.get(task.id) ?? []).reduce(
          (a, b) => a + b,
          0,
        );

        if (
          task.budget?.maxTokens != null &&
          cumTokens > task.budget.maxTokens
        ) {
          await this.sendToDeadLetter(task, result, cumTokens, cumWallClock, "token_budget_exceeded");
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        if (
          task.budget?.maxWallClockMs != null &&
          cumWallClock > task.budget.maxWallClockMs
        ) {
          await this.sendToDeadLetter(task, result, cumTokens, cumWallClock, "wall_clock_budget_exceeded");
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        const currentAttempt = this.attempts.get(task.id) ?? 0;
        const plan = planRetry(task.escalationPolicy, currentAttempt);

        if (plan.shouldRetry) {
          // Emit retry_scheduled lane event.
          this.host.emit({
            type: "retry_scheduled",
            payload: {
              taskId: task.id,
              attempt: currentAttempt,
              delayMs: plan.delayMs,
              policyKind: task.escalationPolicy.kind,
            },
          });
          if (plan.delayMs > 0) {
            await new Promise<void>((r) => setTimeout(r, plan.delayMs));
          }
          this.attempts.set(task.id, currentAttempt + 1);
          // Loop again.
          continue retryLoop;
        }

        // Retries exhausted or handoff.
        if (task.escalationPolicy.kind === "handoff") {
          // Minimal M3a: redispatch-or-dead-letter handled by handoff method.
          await this.handleHandoff(task, task.escalationPolicy.targetRole, result, cumTokens, cumWallClock);
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        // Retry exhausted — dead-letter.
        await this.sendToDeadLetter(task, result, cumTokens, cumWallClock, result.status);
        finalResult = result;
        finalHandle = handle;
        break retryLoop;
      }

      token.release();

      const result = finalResult!;
      const handle = finalHandle;

      // When a task is killed (via task_stop), fetch stoppedBy from the
      // registry so the results.jsonl line carries it. Registry lookup is
      // async; pre-fetch before the sync buildResultLine call.
      let stoppedBy: string | undefined;
      if (result.status === "killed") {
        const record = await this.host.task.get(task.id).catch(() => undefined);
        stoppedBy = record?.stoppedBy;
      }
      const line = this.buildResultLine(
        task,
        result,
        handle?.agentId,
        handle?.sessionId,
        stoppedBy,
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

    await this.deadLetter.close();

    const deadLetterViolation =
      this.deadLetter.hasDelta() && !(this.opts.allowDeadLetter ?? false);

    return { ...counts, resultWriteFailures: this.resultWriteFailures, deadLetterViolation };
  }

  private async sendToDeadLetter(
    task: TaskPacket,
    result: AgentResult,
    cumTokens: number,
    cumWallClockMs: number,
    lastStatus: string,
  ): Promise<void> {
    const lastError =
      "error" in result && result.error != null ? result.error : undefined;
    const attempts = this.attempts.get(task.id) ?? 0;

    this.host.emit({
      type: "retry_exhausted",
      payload: { taskId: task.id, attempts, lastStatus },
    });

    try {
      await this.deadLetter.write({
        id: task.id,
        attempts,
        lastStatus,
        ...(lastError !== undefined && { lastError }),
        cumulativeUsage: { input: cumTokens, output: 0 },
        cumulativeWallClockMs: cumWallClockMs,
        droppedAt: Date.now(),
      });
      this.host.emit({
        type: "dead_letter_written",
        payload: { taskId: task.id },
      });
    } catch (err) {
      this.host.emit({
        type: "error",
        payload: {
          class: "transport",
          message: `dead-letter write failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      });
    }
  }

  /**
   * Minimal M3a handoff: redispatch to targetRole's agents, or dead-letter if
   * no agent of that role exists. Full handoff tracking deferred to M3b.
   */
  private async handleHandoff(
    task: TaskPacket,
    targetRole: string,
    result: AgentResult,
    cumTokens: number,
    cumWallClockMs: number,
  ): Promise<void> {
    this.host.emit({
      type: "retry_exhausted",
      payload: { taskId: task.id, reason: `handoff to role ${targetRole}` },
    });
    // M3a: always dead-letter with handoff_not_supported status.
    // Full role-based redispatch is M3b work.
    try {
      await this.deadLetter.write({
        id: task.id,
        attempts: this.attempts.get(task.id) ?? 0,
        lastStatus: "handoff_not_supported",
        cumulativeUsage: { input: cumTokens, output: 0 },
        cumulativeWallClockMs: cumWallClockMs,
        droppedAt: Date.now(),
      });
      this.host.emit({
        type: "dead_letter_written",
        payload: { taskId: task.id },
      });
    } catch (err) {
      this.host.emit({
        type: "error",
        payload: {
          class: "transport",
          message: `dead-letter write failed for handoff task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        },
      });
    }
  }

  /**
   * Run pre-flight policy validators before spawning a worker.
   * Returns an error string if the task should fail immediately, null otherwise.
   * Emits advisory lane events for no-op policies.
   */
  private runPreflightValidators(task: TaskPacket): string | null {
    const branchError = this.validateBranchPolicy(task);
    if (branchError !== null) return branchError;
    this.emitCommitPolicyNoop(task);
    return null;
  }

  private validateBranchPolicy(task: TaskPacket): string | null {
    const policy = task.branchPolicy as BranchPolicy;

    if (policy.kind === "reuse") {
      const result = spawnSync("git", ["rev-parse", "--verify", policy.branch], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      if (result.status !== 0) {
        return `branch ${policy.branch} not found`;
      }
      // Branch exists — emit noop event (git ops deferred to M3b).
      this.host.emit({
        type: "branch_policy_noop",
        payload: { id: task.id, kind: "reuse", branch: policy.branch },
      });
      return null;
    }

    if (policy.kind === "create") {
      const result = spawnSync("git", ["rev-parse", "--verify", policy.from], {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      if (result.status !== 0) {
        return `branch ${policy.from} not found`;
      }
      // Generate name if absent.
      const name =
        policy.name ??
        `task-${task.id}-${createHash("sha256").update(task.id).digest("hex").slice(0, 7)}`;
      this.host.emit({
        type: "branch_policy_noop",
        payload: { id: task.id, kind: "create", from: policy.from, name },
      });
      return null;
    }

    // kind === "none" — no git operation needed.
    return null;
  }

  private emitCommitPolicyNoop(task: TaskPacket): void {
    const policy = task.commitPolicy as CommitPolicy;
    this.host.emit({
      type: "commit_policy_noop",
      payload: { id: task.id, kind: policy.kind },
    });
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
    stoppedBy?: string,
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
          ...(stoppedBy !== undefined ? { stoppedBy } : {}),
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
