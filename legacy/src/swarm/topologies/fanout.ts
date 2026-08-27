/**
 * FanoutTopology — today's "swarm run" coordination shape.
 *
 * Each MemberSpec becomes one parallel task; the topology fans out across the
 * pool, runs the per-task retry/budget/dead-letter loop, and emits one result
 * line per terminal transition.
 *
 * This is a refactor of the Orchestrator.run() body in stage 4C. Behavior is
 * byte-identical to v0.3 — the only structural change is that per-task state
 * (attempts, cumulative usage, branch locks) lives in local Maps inside
 * `run()` rather than on the Orchestrator instance.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  AgentResult,
  TaskPacket,
  BranchPolicy,
  CommitPolicy,
} from "../host.js";
import type { LaneEvent } from "../events.js";
import type { StandaloneHost } from "../standalone-host.js";
import { planRetry } from "../retry-policy.js";
import type { Role } from "../roles.js";
import * as branchLock from "../git/branch-lock.js";
import * as staleBase from "../git/stale-base.js";
import type { TeamSpec, MemberSpec } from "../team-spec.js";
import { applyDefaultBranchPolicy } from "./branch-policy-defaults.js";
import type {
  Topology,
  TopologyContext,
  TeamResult,
} from "../topologies-types.js";
import type { ResultLine } from "../orchestrator.js";

/**
 * Crash-recovery T2 — prepended to the prompt when re-dispatching a unit that
 * was mid-flight when the daemon crashed. The worker also resumes its prior
 * engine session (per-unit sidecar), so this frames the resumed conversation.
 */
const RESUME_PREAMBLE =
  "[Resumed after interruption] The team was interrupted and restarted, and " +
  "you may have already partially completed this task. Before doing anything " +
  "else, verify the current state of your work (inspect files, git status, " +
  "and any outputs you already produced). Then continue from where you left " +
  "off — do not redo steps that are already complete. If the task is already " +
  "fully done, just report completion.\n\n---\n\n";

export class FanoutTopology implements Topology {
  readonly name = "fanout" as const;

  async run(specIn: TeamSpec, ctx: TopologyContext): Promise<TeamResult> {
    // v0.7 stage 7G — when the host's branch-policy adapter is stream-aware,
    // default each member to its own stream/worktree per docs/25 §10.4.
    // Spec overrides win. The optional-chaining + ?? false handles fakes
    // (and older host adapters) that don't implement supportsStreams yet.
    const spec = ctx.host.supportsStreams?.() ?? false
      ? applyDefaultBranchPolicy(specIn, { kind: "stream" })
      : specIn;
    const counts = { succeeded: 0, failed: 0, timeout: 0, cancelled: 0 };
    let firstResultWriteError: unknown;
    let resultWriteFailures = 0;

    // Per-task state — local to this run. Previously instance fields on
    // Orchestrator; never exposed externally so moving here is safe.
    const attempts = new Map<string, number>();
    const cumulativeInputTokens = new Map<string, number>();
    const cumulativeOutputTokens = new Map<string, number>();
    const perAttemptDurations = new Map<string, number[]>();
    const branchLocks = new Map<string, branchLock.LockHandle>();

    // Materialize MemberSpec[] back into TaskPackets. Each member becomes one
    // fanout task. Existing TaskPacket fields are derived from MemberSpec.
    // Default values mirror what the orchestrator's legacy run(tasks) path
    // accepts when the CLI passes TaskPacket[] straight through.
    const tasks: TaskPacket[] = spec.members.map((m, idx) =>
      memberToTaskPacket(m, idx),
    );

    // Per-task processing — copy of legacy Orchestrator.run() body.
    const runs = tasks.map(async (task) => {
      // Team crash-recovery (T1): if this task already succeeded in a prior
      // (crashed) run, replay its stored result line and skip re-dispatch —
      // before consuming a pool slot. Non-success prior outcomes fall through
      // and re-run normally (auto-resume skips proven-good work only).
      const priorUnit = ctx.checkpoint?.get(task.id);
      if (priorUnit?.status === "succeeded") {
        const line = buildResumedResultLine(task, priorUnit, ctx);
        await writeResult(line, ctx).catch((e) => {
          firstResultWriteError ??= e;
          resultWriteFailures++;
        });
        counts.succeeded++;
        ctx.host.emit({
          type: "team_note",
          payload: {
            teamName: spec.name,
            scope: `swarm:${spec.name}`,
            note: `task ${task.id} skipped (resumed from checkpoint)`,
          },
        });
        return;
      }

      let token;
      try {
        token = await ctx.pool.acquire();
      } catch {
        // Pool closed before we got a slot — cancelled.
        const line = buildCancelled(task, ctx);
        await writeResult(line, ctx).catch((e) => {
          firstResultWriteError ??= e;
          resultWriteFailures++;
        });
        counts.cancelled++;
        return;
      }

      if (ctx.abort?.aborted) {
        token.release();
        const line = buildCancelled(task, ctx);
        await writeResult(line, ctx).catch((e) => {
          firstResultWriteError ??= e;
          resultWriteFailures++;
        });
        counts.cancelled++;
        return;
      }

      // Pre-flight policy validation before spawn.
      const preflightError = runPreflightValidators(task, ctx);
      if (preflightError !== null) {
        token.release();
        const line: ResultLine = {
          id: task.id,
          status: "failed",
          error: preflightError,
          wallClockMs: 0,
          agentId: ctx.host.agentId,
          sessionId: "none",
          completedAt: Date.now(),
        };
        await writeResult(line, ctx).catch((e) => {
          firstResultWriteError ??= e;
          resultWriteFailures++;
        });
        counts.failed++;
        return;
      }

      // M3b Phase 2: acquire branch lock (advisory for create/reuse).
      // Release is guaranteed via releaseBranchLock() on terminal transition.
      const lockKey = computeBranchLockKey(task, ctx);
      if (lockKey !== null) {
        try {
          const handle = await branchLock.acquire(lockKey, {
            agentId: ctx.host.agentId,
            timeoutMs: 60_000,
            cwd: process.cwd(),
          });
          branchLocks.set(task.id, handle);
          ctx.host.emit({
            type: "branch_lock_acquired",
            payload: { branch: lockKey, laneId: task.id },
          });
        } catch (err) {
          token.release();
          const msg = err instanceof Error ? err.message : String(err);
          ctx.host.emit({
            type: "branch_lock_timeout",
            payload: {
              branch: lockKey,
              laneId: task.id,
              waitedMs: 60_000,
            },
          });
          const line: ResultLine = {
            id: task.id,
            status: "failed",
            error: msg,
            wallClockMs: 0,
            agentId: ctx.host.agentId,
            sessionId: "none",
            completedAt: Date.now(),
          };
          await writeResult(line, ctx).catch((e) => {
            firstResultWriteError ??= e;
            resultWriteFailures++;
          });
          counts.failed++;
          return;
        }

        // M3b Phase 2: stale-base check (best-effort, non-blocking).
        try {
          const result = await staleBase.check({ cwd: process.cwd() });
          if (result.kind === "diverged") {
            ctx.host.emit({
              type: "stale_base_diverged",
              payload: {
                branch: lockKey,
                baseBranch: result.expected,
                behindBy: 0, // unknown at this layer; payload shape requires a number
              },
            });
          } else if (result.kind === "matches") {
            ctx.host.emit({
              type: "stale_base_ok",
              payload: { branch: lockKey, baseBranch: "" },
            });
          }
          // no-expected-base / not-a-git-repo → silent, no event.
        } catch {
          // stale_base.check should not throw, but swallow any surprise so
          // advisory check never fails a task dispatch.
        }
      }

      // Resolve role (per-task override beats orchestrator default). Unknown
      // role → fail-fast at dispatch with a clear error.
      const roleName = task.role ?? ctx.defaultRole;
      let role: Role | undefined;
      if (roleName !== undefined) {
        role = ctx.roles?.get(roleName);
        if (role === undefined) {
          token.release();
          const line: ResultLine = {
            id: task.id,
            status: "failed",
            error: `unknown role: ${roleName}`,
            wallClockMs: 0,
            agentId: ctx.host.agentId,
            sessionId: "none",
            completedAt: Date.now(),
          };
          await writeResult(line, ctx).catch((e) => {
            firstResultWriteError ??= e;
            resultWriteFailures++;
          });
          counts.failed++;
          return;
        }
        ctx.host.emit({
          type: "role_applied",
          payload: { taskId: task.id, role: role.name },
        });
      }

      // Initialize per-task retry state.
      attempts.set(task.id, 0);
      cumulativeInputTokens.set(task.id, 0);
      cumulativeOutputTokens.set(task.id, 0);
      perAttemptDurations.set(task.id, []);

      // Crash-recovery T2: when a checkpoint is present, give this unit a
      // stable per-unit session sidecar and mark it in-flight before spawning.
      // If it was mid-flight in a prior (crashed) run, re-dispatch with a
      // verify-then-continue preamble; the worker resumes its prior engine
      // session from the same sidecar.
      const sidecar = ctx.checkpoint?.sidecarPathFor(task.id);
      const priorInFlight = ctx.checkpoint?.wasInFlight(task.id);
      const dispatchTask: TaskPacket =
        priorInFlight !== undefined
          ? { ...task, prompt: RESUME_PREAMBLE + task.prompt }
          : task;
      if (ctx.checkpoint !== undefined) {
        if (priorInFlight !== undefined) {
          ctx.host.emit({
            type: "team_note",
            payload: {
              teamName: spec.name,
              scope: `swarm:${spec.name}`,
              note: `task ${task.id} re-dispatching (in-flight at crash; verify then continue)`,
            },
          });
        }
        await ctx.checkpoint
          .markDispatched({
            id: task.id,
            dispatchedAt: Date.now(),
            ...(sidecar !== undefined && { sidecarPath: sidecar }),
          })
          .catch(() => {});
      }

      let finalResult: AgentResult | undefined;
      let finalHandle: Awaited<ReturnType<StandaloneHost["spawn"]>> | undefined;

      // Retry loop — runs at least once.
      retryLoop: while (true) {
        const startedAt = Date.now();
        let result: AgentResult;
        let handle;
        const perAttemptCeiling = task.budget?.maxWallClockMsPerAttempt;
        // Set when the ceiling timer wins the race below. Authoritative: the
        // clock-based check further down cannot re-derive this reliably,
        // because a timer scheduled for N ms can settle at exactly N and the
        // comparison there is strictly greater-than.
        let perAttemptCeilingHit = false;
        try {
          // NOTE: we intentionally omit `taskId` — StandaloneHost treats
          // non-undefined taskId as "look up an EXISTING record", which we
          // don't have (orchestrator-level task ids are user-supplied and
          // never registered here). Letting the host create a fresh
          // TaskRecord is fine; result lines still use `task.id` from the
          // user's input via buildResultLine().
          handle = await ctx.host.spawn({
            task: dispatchTask,
            permissionMode: ctx.permissionMode,
            parentAgentId: ctx.host.agentId,
            ...(task.model !== undefined && { model: task.model }),
            ...(role !== undefined && {
              role: role.name,
              allowedTools: role.allowedTools,
            }),
            ...(sidecar !== undefined && { sessionSidecarPath: sidecar }),
          });
          // When a per-attempt ceiling is configured, race wait() against a
          // timer. On timeout, kill the worker and synthesize a timeout
          // result so downstream bookkeeping + dead-letter path fires with
          // the correct reason.
          if (perAttemptCeiling != null && perAttemptCeiling > 0) {
            const timeoutSentinel = Symbol("per-attempt-timeout");
            const waitPromise = handle.wait();
            // Capture the timer id so we can clear it if waitPromise wins the
            // race. Without this, the pending timer keeps the event loop alive
            // for up to `perAttemptCeiling` ms (minutes) after the task ends,
            // delaying process exit. M3a carry-over 8.0a.
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const racePromise = new Promise<typeof timeoutSentinel>(
              (resolve) => {
                timeoutId = setTimeout(
                  () => resolve(timeoutSentinel),
                  perAttemptCeiling,
                );
              },
            );
            const raced = await Promise.race([waitPromise, racePromise]);
            if (raced === timeoutSentinel) {
              perAttemptCeilingHit = true;
              // Per-attempt ceiling hit — kill the worker, then let wait()
              // resolve (it will return a killed result from the host).
              await handle.kill().catch(() => {
                /* best-effort — ceiling enforcement is what matters */
              });
              // Don't await waitPromise forever; synthesize a timeout result.
              result = {
                status: "timeout",
                wallClockMs: perAttemptCeiling,
              };
              // Let the underlying wait() settle in the background so any
              // resources get cleaned up; swallow its outcome.
              void waitPromise.catch(() => {});
            } else {
              // waitPromise won — clear the still-pending timer so it doesn't
              // hold the event loop open.
              if (timeoutId !== undefined) clearTimeout(timeoutId);
              result = raced;
            }
          } else {
            result = await handle.wait();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            status: "failure",
            error: msg,
            wallClockMs: Date.now() - startedAt,
          };
        }

        const attemptDurationMs = Date.now() - startedAt;
        perAttemptDurations.get(task.id)!.push(attemptDurationMs);

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

        // Accumulate token usage (separate input/output totals — M4 fix).
        if ("usage" in result && result.usage != null) {
          const prevIn = cumulativeInputTokens.get(task.id) ?? 0;
          const prevOut = cumulativeOutputTokens.get(task.id) ?? 0;
          cumulativeInputTokens.set(
            task.id,
            prevIn + (result.usage.inputTokens ?? 0),
          );
          cumulativeOutputTokens.set(
            task.id,
            prevOut + (result.usage.outputTokens ?? 0),
          );
        }

        // Budget exhaustion checks.
        const cumIn = cumulativeInputTokens.get(task.id) ?? 0;
        const cumOut = cumulativeOutputTokens.get(task.id) ?? 0;
        const cumTokens = cumIn + cumOut;
        const cumWallClock = (perAttemptDurations.get(task.id) ?? []).reduce(
          (a, b) => a + b,
          0,
        );

        // Per-attempt wall-clock ceiling: if THIS attempt exceeded the cap,
        // dead-letter immediately without consulting the retry policy (C2).
        if (
          perAttemptCeiling != null &&
          (perAttemptCeilingHit || attemptDurationMs > perAttemptCeiling)
        ) {
          await sendToDeadLetter(
            task,
            result,
            cumIn,
            cumOut,
            cumWallClock,
            "per_attempt_budget_exceeded",
            attempts,
            ctx,
          );
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        if (
          task.budget?.maxTokens != null &&
          cumTokens > task.budget.maxTokens
        ) {
          await sendToDeadLetter(
            task,
            result,
            cumIn,
            cumOut,
            cumWallClock,
            "token_budget_exceeded",
            attempts,
            ctx,
          );
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        if (
          task.budget?.maxWallClockMs != null &&
          cumWallClock > task.budget.maxWallClockMs
        ) {
          await sendToDeadLetter(
            task,
            result,
            cumIn,
            cumOut,
            cumWallClock,
            "wall_clock_budget_exceeded",
            attempts,
            ctx,
          );
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        const currentAttempt = attempts.get(task.id) ?? 0;
        const plan = planRetry(task.escalationPolicy, currentAttempt);

        if (plan.shouldRetry) {
          // Emit retry_scheduled lane event.
          ctx.host.emit({
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
          attempts.set(task.id, currentAttempt + 1);
          // Loop again.
          continue retryLoop;
        }

        // Retries exhausted or handoff.
        if (task.escalationPolicy.kind === "handoff") {
          // Minimal M3a: redispatch-or-dead-letter handled by handoff method.
          await handleHandoff(
            task,
            task.escalationPolicy.targetRole,
            result,
            cumIn,
            cumOut,
            cumWallClock,
            attempts,
            ctx,
          );
          finalResult = result;
          finalHandle = handle;
          break retryLoop;
        }

        // Retry exhausted — dead-letter.
        await sendToDeadLetter(
          task,
          result,
          cumIn,
          cumOut,
          cumWallClock,
          result.status,
          attempts,
          ctx,
        );
        finalResult = result;
        finalHandle = handle;
        break retryLoop;
      }

      token.release();
      // Release branch lock on terminal transition (if one was acquired).
      await releaseBranchLockFor(task.id, branchLocks, ctx);

      const result = finalResult!;
      const handle = finalHandle;

      // When a task is killed (via task_stop), fetch stoppedBy from the
      // registry so the results.jsonl line carries it. Registry lookup is
      // async; pre-fetch before the sync buildResultLine call.
      let stoppedBy: string | undefined;
      if (result.status === "killed") {
        const record = await ctx.host.task.get(task.id).catch(() => undefined);
        stoppedBy = record?.stoppedBy;
      }
      const line = buildResultLine(
        task,
        result,
        handle?.agentId,
        handle?.sessionId,
        stoppedBy,
      );
      await writeResult(line, ctx).catch((e) => {
        firstResultWriteError ??= e;
        resultWriteFailures++;
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

      // Team crash-recovery (T1): record this task's terminal outcome so a
      // restart can skip it (succeeded) or re-run it (non-success). Best-effort
      // — a checkpoint write failure must never fail the task.
      await ctx.checkpoint
        ?.record({
          id: task.id,
          status: line.status,
          agentId: line.agentId,
          sessionId: line.sessionId,
          completedAt: line.completedAt,
          ...(line.output !== undefined && { output: line.output }),
        })
        .catch(() => {});
    });

    await Promise.all(runs);

    if (firstResultWriteError) {
      process.stderr.write(
        `[openswarm] ${resultWriteFailures} task result(s) failed to persist; first error: ${String(firstResultWriteError)}\n`,
      );
    }

    // Force violation when the dead-letter writer recorded any failures —
    // allowDeadLetter is meant to tolerate *content* (dropped tasks), not
    // silent data loss on the file itself (M2 fix).
    const deadLetterWriteFailures = ctx.deadLetter.writeFailures();
    if (deadLetterWriteFailures > 0) {
      ctx.host.emit({
        type: "dead_letter_write_failure",
        payload: { failures: deadLetterWriteFailures },
      });
    }
    const deadLetterViolation =
      deadLetterWriteFailures > 0 ||
      (ctx.deadLetter.hasDelta() && !(ctx.allowDeadLetter ?? false));

    return {
      ...counts,
      resultWriteFailures,
      deadLetterViolation,
      deadLetterWriteFailures,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers (per-task logic; previously private methods on Orchestrator).
// ---------------------------------------------------------------------------

function memberToTaskPacket(m: MemberSpec, idx: number): TaskPacket {
  return {
    id: m.id ?? `task-${idx + 1}`,
    prompt: m.prompt,
    ...(m.model !== undefined && { model: m.model }),
    branchPolicy: m.branchPolicy ?? { kind: "none" },
    commitPolicy: m.commitPolicy ?? { kind: "none" },
    escalationPolicy: m.escalationPolicy ?? { kind: "none" },
    ...(m.budget !== undefined && { budget: m.budget }),
    // Empty string role from legacy round-trip is treated as "no role".
    ...(m.role !== undefined && m.role.length > 0 && { role: m.role }),
  };
}

async function sendToDeadLetter(
  task: TaskPacket,
  result: AgentResult,
  cumInputTokens: number,
  cumOutputTokens: number,
  cumWallClockMs: number,
  lastStatus: string,
  attempts: Map<string, number>,
  ctx: TopologyContext,
): Promise<void> {
  const lastError =
    "error" in result && result.error != null ? result.error : undefined;
  const attemptCount = attempts.get(task.id) ?? 0;

  ctx.host.emit({
    type: "retry_exhausted",
    payload: { taskId: task.id, attempts: attemptCount, lastStatus },
  });

  try {
    await ctx.deadLetter.write({
      id: task.id,
      attempts: attemptCount,
      lastStatus,
      ...(lastError !== undefined && { lastError }),
      cumulativeUsage: { input: cumInputTokens, output: cumOutputTokens },
      cumulativeWallClockMs: cumWallClockMs,
      droppedAt: Date.now(),
    });
    ctx.host.emit({
      type: "dead_letter_written",
      payload: { taskId: task.id },
    });
  } catch (err) {
    ctx.host.emit({
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
async function handleHandoff(
  task: TaskPacket,
  targetRole: string,
  result: AgentResult,
  cumInputTokens: number,
  cumOutputTokens: number,
  cumWallClockMs: number,
  attempts: Map<string, number>,
  ctx: TopologyContext,
): Promise<void> {
  // `result` kept for signature symmetry with sendToDeadLetter; not used here.
  void result;
  ctx.host.emit({
    type: "retry_exhausted",
    payload: { taskId: task.id, reason: `handoff to role ${targetRole}` },
  });
  // M3a: always dead-letter with handoff_not_supported status.
  // Full role-based redispatch is M3b work.
  try {
    await ctx.deadLetter.write({
      id: task.id,
      attempts: attempts.get(task.id) ?? 0,
      lastStatus: "handoff_not_supported",
      cumulativeUsage: { input: cumInputTokens, output: cumOutputTokens },
      cumulativeWallClockMs: cumWallClockMs,
      droppedAt: Date.now(),
    });
    ctx.host.emit({
      type: "dead_letter_written",
      payload: { taskId: task.id },
    });
  } catch (err) {
    ctx.host.emit({
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
 * Compute the branch-lock key for a task's BranchPolicy, or null if no
 * lock should be acquired.
 *
 * Mapping:
 *   - `none`   → null (skip lock entirely)
 *   - `reuse`  → policy.branch
 *   - `create` with explicit `.name` → policy.name
 *   - `create` without `.name` → null (skip lock acquire)
 *
 * Rationale for the `create` without `.name` case (M3b audit finding C3):
 * synthesizing a per-task key from task.id would generate DIFFERENT keys
 * for two tasks that both target `{ kind: "create", from: "<base>" }` with
 * no explicit name, so the lock would never serialize anything — defeating
 * its purpose. When real git-checkout integration lands (post-M3b), the
 * lock key will come from post-checkout `git symbolic-ref --short HEAD`.
 * Until then, operators must supply `.name` to opt into serialization.
 * The skip is surfaced via a `branch_policy_noop` event with
 * `reason: "create_without_name"`.
 */
function computeBranchLockKey(
  task: TaskPacket,
  ctx: TopologyContext,
): string | null {
  const policy = task.branchPolicy as BranchPolicy;
  if (policy.kind === "none") return null;
  if (policy.kind === "reuse") return policy.branch;
  // kind === "create"
  if (policy.name !== undefined) return policy.name;
  ctx.host.emit({
    type: "branch_policy_noop",
    payload: {
      taskId: task.id,
      kind: "create",
      reason: "create_without_name",
    },
  });
  return null;
}

/**
 * Release the branch lock for a task (if held). Emits `branch_lock_released`.
 * Idempotent — safe to call even when no lock was acquired. Errors during
 * release are swallowed after a single stderr message (lock file persistence
 * would block future tasks, but we've already accounted for stale reclaim).
 */
async function releaseBranchLockFor(
  taskId: string,
  branchLocks: Map<string, branchLock.LockHandle>,
  ctx: TopologyContext,
): Promise<void> {
  const handle = branchLocks.get(taskId);
  if (handle === undefined) return;
  branchLocks.delete(taskId);
  try {
    await handle.release();
  } catch (err) {
    process.stderr.write(
      `[openswarm] branch-lock release failed for task ${taskId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  ctx.host.emit({
    type: "branch_lock_released",
    payload: { branch: handle.branch, laneId: taskId },
  });
}

/**
 * Run pre-flight policy validators before spawning a worker.
 * Returns an error string if the task should fail immediately, null otherwise.
 * Emits advisory lane events for no-op policies.
 */
function runPreflightValidators(
  task: TaskPacket,
  ctx: TopologyContext,
): string | null {
  const branchError = validateBranchPolicy(task, ctx);
  if (branchError !== null) return branchError;
  emitCommitPolicyNoop(task, ctx);
  return null;
}

function validateBranchPolicy(
  task: TaskPacket,
  ctx: TopologyContext,
): string | null {
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
    ctx.host.emit({
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
    ctx.host.emit({
      type: "branch_policy_noop",
      payload: { id: task.id, kind: "create", from: policy.from, name },
    });
    return null;
  }

  // kind === "none" — no git operation needed.
  return null;
}

function emitCommitPolicyNoop(task: TaskPacket, ctx: TopologyContext): void {
  const policy = task.commitPolicy as CommitPolicy;
  ctx.host.emit({
    type: "commit_policy_noop",
    payload: { id: task.id, kind: policy.kind },
  });
}

async function writeResult(
  line: ResultLine,
  ctx: TopologyContext,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const payload = JSON.stringify(line) + "\n";
    ctx.resultsOut.write(payload, (err) => {
      if (err) {
        // Emit an error lane event to eventsOut if available.
        if (ctx.eventsOut) {
          const event: LaneEvent = {
            ts: Date.now(),
            agentId: ctx.host.agentId,
            type: "error",
            payload: {
              class: "transport",
              message: `results.jsonl write failed for task ${line.id}: ${err.message}`,
              retryable: false,
            },
          };
          ctx.eventsOut.write(JSON.stringify(event) + "\n", () => {
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

function buildResultLine(
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

/**
 * Reconstruct a succeeded ResultLine from a checkpointed unit so the
 * results.jsonl stream stays complete when a task is skipped on resume.
 */
function buildResumedResultLine(
  task: TaskPacket,
  unit: import("../team-checkpoint.js").CompletedUnit,
  ctx: TopologyContext,
): ResultLine {
  return {
    id: task.id,
    status: "succeeded",
    wallClockMs: 0,
    agentId: unit.agentId ?? ctx.host.agentId,
    sessionId: unit.sessionId ?? "resumed",
    completedAt: unit.completedAt,
    ...(unit.output !== undefined && { output: unit.output }),
  };
}

function buildCancelled(
  task: TaskPacket,
  ctx: TopologyContext,
): ResultLine {
  return {
    id: task.id,
    status: "cancelled",
    wallClockMs: 0,
    agentId: ctx.host.agentId,
    sessionId: "none",
    completedAt: Date.now(),
  };
}
