/**
 * swarm.ts — implementation of `openswarm swarm run <tasks-file>`.
 *
 * Reads a JSONL file of TaskPackets, validates each line with zod,
 * then drives the Orchestrator to execute them concurrently.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PermissionMode } from "../core/types.js";
import { Orchestrator } from "../swarm/orchestrator.js";
import type { TaskPacket } from "../swarm/host.js";
import { TaskPacketSchema, isPolicyParseError } from "../swarm/policies.js";
import {
  BUILTIN_ROLES,
  RoleRegistry,
  loadCustomRoles,
} from "../swarm/roles.js";
import { checkBudget } from "../core/budget.js";
import { buildAdapterHost } from "./adapter-host.js";
import { attachLaneTrace } from "./trace-output.js";

// ---------------------------------------------------------------------------
// Schema (Phase 2: discriminated-union policies)
// ---------------------------------------------------------------------------

// Extend TaskPacketSchema to allow an optional id (CLI generates one if absent).
import { z } from "zod";
const taskPacketSchema = TaskPacketSchema.extend({ id: z.string().optional() });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SwarmRunOptions {
  readonly tasksFile: string;
  readonly concurrency: number;
  readonly output: string;
  readonly permissionMode: PermissionMode;
  /** Path for dead-letter JSONL file. Default: ./dead-letter.jsonl */
  readonly deadLetter?: string;
  /**
   * When true, a non-empty dead-letter delta does NOT cause the run to exit
   * non-zero. Default: false.
   */
  readonly allowDeadLetter?: boolean;
  /**
   * Default role name applied to every task that doesn't override via its
   * own `role` field (M3a Phase 6). Resolved against the RoleRegistry
   * built at startup (built-ins + custom from `.openswarm/roles.json`).
   */
  readonly defaultRole?: string;
  /**
   * v0.5 stage 5B: when true, mirror task create/update into the opentasks
   * daemon for cross-system task graph visibility. Local TaskRegistry stays
   * authoritative; opentasks is best-effort (errors don't block the run).
   */
  readonly opentasks?: boolean;
  /**
   * v0.5 stage 5B: explicit opentasks daemon socket path. When unset and
   * `opentasks` is true, the socket is auto-discovered via the standard
   * walk-up (`.openswarm/opentasks` → `.swarm/opentasks` → `.opentasks` →
   * `.git/opentasks`).
   */
  readonly opentasksSocket?: string;
  /**
   * v0.6 stage 6A.2: when true, use the agent-inbox library as the
   * StandaloneHost's InboxBackend. Adds threading + persistence over the
   * default in-memory queue.
   */
  readonly agentInbox?: boolean;
  /**
   * v0.7 stage 7A.4: when true, wire a GitCascadeBranchPolicyAdapter so
   * members spec'd with kind:"stream" / kind:"fork" land in per-agent
   * worktrees under .openswarm/worktrees/<streamId>/.
   */
  readonly gitCascade?: boolean;
  /**
   * v0.7 stage 7H: when true, the git-cascade adapter removes every
   * worktree it created when the orchestrator exits (via `git worktree
   * remove --force`, then `git worktree prune`). Default: keep worktrees
   * for forensic inspection. Ignored when --git-cascade is off.
   */
  readonly cleanupWorktrees?: boolean;
  /**
   * Aggregate token cap across all workers. On exceed, all in-flight workers
   * are aborted and the run exits with code 3 (v0.2.Q7).
   */
  readonly maxTokens?: number;
  /**
   * Aggregate cost cap in USD across all workers. On exceed, all in-flight
   * workers are aborted and the run exits with code 3 (v0.2.Q7).
   * Skipped for unknown model ids.
   */
  readonly maxCostUsd?: number;
  /**
   * Model id used for cost calculation in aggregate budget checks.
   * Defaults to "claude-sonnet-4-6" when not supplied.
   */
  readonly modelId?: string;
  /** Raw lane-event JSONL trace path. */
  readonly traceOutput?: string;
}

// ---------------------------------------------------------------------------
// runSwarm
// ---------------------------------------------------------------------------

export async function runSwarm(opts: SwarmRunOptions): Promise<number> {
  // Parse tasks.jsonl.
  let raw: string;
  try {
    raw = fs.readFileSync(opts.tasksFile, "utf8");
  } catch (err) {
    process.stderr.write(
      `error: cannot read tasks file ${opts.tasksFile}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const tasks: TaskPacket[] = [];
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `error: tasks file line ${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})\n`,
      );
      return 2;
    }
    const parsed = taskPacketSchema.safeParse(json);
    if (!parsed.success) {
      process.stderr.write(
        `error: tasks file line ${i + 1}: ${parsed.error.message}\n`,
      );
      if (isPolicyParseError(parsed.error.message)) {
        process.stderr.write(
          `[openswarm] TaskPacket policies are now discriminated unions — see docs/archive/11-m3a-plan.md §Policy migration\n`,
        );
      }
      return 2;
    }
    const id = parsed.data.id ?? `task-${i + 1}`;
    tasks.push({
      ...parsed.data,
      id,
      ...(parsed.data.model === undefined &&
        opts.modelId !== undefined && { model: opts.modelId }),
    } as TaskPacket);
  }

  if (tasks.length === 0) {
    process.stderr.write("error: tasks file contains zero tasks\n");
    return 2;
  }

  // Build RoleRegistry: built-ins + custom from .openswarm/roles.json.
  const roles = new RoleRegistry();
  for (const r of BUILTIN_ROLES) roles.register(r);
  const customRolesPath = path.join(
    process.cwd(),
    ".openswarm",
    "roles.json",
  );
  const custom = await loadCustomRoles(customRolesPath);
  for (const r of custom) roles.register(r);

  // If a default role was supplied, validate it now so we fail early with a
  // clear error rather than per-task.
  if (opts.defaultRole !== undefined && roles.get(opts.defaultRole) === undefined) {
    process.stderr.write(
      `error: unknown role "${opts.defaultRole}" (known: ${roles
        .list()
        .map((r) => r.name)
        .join(", ")})\n`,
    );
    return 2;
  }

  // Open results stream.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });

  // Ecosystem adapters (--opentasks / --agent-inbox / --git-cascade) share
  // one assembly path with `topology` and `team start` — see adapter-host.ts.
  const hostResult = buildAdapterHost({
    permissionMode: opts.permissionMode,
    ...(opts.opentasks !== undefined && { opentasks: opts.opentasks }),
    ...(opts.opentasksSocket !== undefined && { opentasksSocket: opts.opentasksSocket }),
    ...(opts.agentInbox !== undefined && { agentInbox: opts.agentInbox }),
    ...(opts.gitCascade !== undefined && { gitCascade: opts.gitCascade }),
    ...(opts.cleanupWorktrees !== undefined && { cleanupWorktrees: opts.cleanupWorktrees }),
    forceHost: opts.traceOutput !== undefined,
  });
  if (!hostResult.ok) {
    process.stderr.write(hostResult.message);
    return 2;
  }
  const host = hostResult.host;
  const traceRecorder = host !== undefined ? attachLaneTrace(host, opts.traceOutput) : undefined;

  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
    roles,
    ...(opts.defaultRole !== undefined ? { defaultRole: opts.defaultRole } : {}),
    ...(opts.deadLetter !== undefined ? { deadLetterPath: opts.deadLetter } : {}),
    ...(opts.allowDeadLetter !== undefined
      ? { allowDeadLetter: opts.allowDeadLetter }
      : {}),
    ...(host !== undefined && { host }),
  });

  const startedAt = Date.now();
  let summary;
  let elapsed;
  try {
    summary = await orch.run(tasks);
    elapsed = Date.now() - startedAt;
  } finally {
    await traceRecorder?.close();
    await new Promise<void>((resolve) => resultsOut.end(resolve));
  }

  // v0.2.Q7 aggregate budget check: parse the output file to sum usage across
  // all completed tasks, then compare against the aggregate limits.
  // Workers have all finished by this point — "abort all in-flight workers"
  // doesn't apply here since they're done; the check gates the exit code.
  const hasBudgetLimits = opts.maxTokens !== undefined || opts.maxCostUsd !== undefined;
  if (hasBudgetLimits) {
    let aggInputTokens = 0;
    let aggOutputTokens = 0;
    try {
      const outputRaw = fs.readFileSync(opts.output, "utf8");
      for (const line of outputRaw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as { usage?: { inputTokens?: number; outputTokens?: number } };
          if (record.usage != null) {
            aggInputTokens += record.usage.inputTokens ?? 0;
            aggOutputTokens += record.usage.outputTokens ?? 0;
          }
        } catch {
          // malformed line — skip
        }
      }
    } catch {
      // output file unreadable — skip budget check
    }
    const aggUsage = { inputTokens: aggInputTokens, outputTokens: aggOutputTokens };
    const budgetResult = checkBudget(
      aggUsage,
      { maxTokens: opts.maxTokens, maxCostUsd: opts.maxCostUsd },
      opts.modelId ?? "claude-sonnet-4-6",
    );
    if (budgetResult.exceeded) {
      const exceededEvent = {
        type: "swarm_budget_exceeded",
        limit: budgetResult.reason?.includes("token") ? "tokens" : "cost",
        usedTokens: budgetResult.usedTokens,
        usedCostUsd: budgetResult.usedCostUsd,
        reason: budgetResult.reason,
        modelId: opts.modelId ?? "claude-sonnet-4-6",
        workersAborted: 0, // all tasks already completed at aggregate-check time
      };
      process.stderr.write(
        `[openswarm] swarm aggregate budget exceeded: ${budgetResult.reason ?? "limit reached"}\n`,
      );
      process.stderr.write(JSON.stringify(exceededEvent) + "\n");
      return 3;
    }
  }

  // Print summary.
  const total = tasks.length;
  process.stderr.write(
    `\n[openswarm] swarm complete in ${elapsed}ms: ${summary.succeeded}/${total} succeeded, ${summary.failed} failed, ${summary.timeout} timeout, ${summary.cancelled} cancelled${summary.resultWriteFailures > 0 ? ` (${summary.resultWriteFailures} result write failures)` : ""}\n`,
  );

  if (summary.resultWriteFailures > 0) return 1;
  if (summary.deadLetterViolation) {
    if (summary.deadLetterWriteFailures > 0) {
      process.stderr.write(
        `[openswarm] exiting non-zero: dead-letter writer failed ${summary.deadLetterWriteFailures} time(s) writing to ${opts.deadLetter ?? "./dead-letter.jsonl"}; --allow-dead-letter does NOT suppress write failures\n`,
      );
    } else {
      process.stderr.write(
        `[openswarm] exiting non-zero: ${opts.deadLetter ?? "./dead-letter.jsonl"} has new entries from this run; pass --allow-dead-letter to accept\n`,
      );
    }
    return 1;
  }
  if (summary.failed > 0 || summary.timeout > 0 || summary.cancelled > 0)
    return 1;
  return 0;
}
