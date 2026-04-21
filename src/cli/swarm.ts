/**
 * swarm.ts — implementation of `swarm-coder swarm run <tasks-file>`.
 *
 * Reads a JSONL file of TaskPackets, validates each line with zod,
 * then drives the Orchestrator to execute them concurrently.
 */

import * as fs from "node:fs";
import { z } from "zod";
import type { PermissionMode } from "../core/types.js";
import { Orchestrator } from "../swarm/orchestrator.js";
import type { TaskPacket } from "../swarm/host.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// TODO M3a Phase 2: replace with BranchPolicySchema / CommitPolicySchema /
// EscalationPolicySchema discriminated unions from src/swarm/policies.ts.
// Phase 2 also wires the migration hint to stderr on parse failure.
// Kept as legacy enums here so existing tests remain green until Phase 2 migrates fixtures.
const taskPacketSchema = z.object({
  id: z.string().optional(),
  prompt: z.string(),
  branchPolicy: z
    .enum(["main", "worktree", "feature-branch", "detached"])
    .optional()
    .default("main"),
  commitPolicy: z
    .enum(["never", "on-success", "on-every-tool", "manual"])
    .optional()
    .default("never"),
  escalationPolicy: z
    .enum(["abort-on-error", "ask-user", "retry-with-backoff"])
    .optional()
    .default("abort-on-error"),
  budget: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      maxWallClockMs: z.number().int().positive().optional(),
    })
    .optional(),
  context: z
    .object({
      files: z.array(z.string()).optional(),
      parentTaskId: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SwarmRunOptions {
  readonly tasksFile: string;
  readonly concurrency: number;
  readonly output: string;
  readonly permissionMode: PermissionMode;
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
      return 2;
    }
    const id = parsed.data.id ?? `task-${i + 1}`;
    // TODO M3a Phase 2: remove cast once taskPacketSchema uses discriminated-union policy schemas.
    tasks.push({ ...parsed.data, id } as unknown as TaskPacket);
  }

  if (tasks.length === 0) {
    process.stderr.write("error: tasks file contains zero tasks\n");
    return 2;
  }

  // Open results stream.
  const resultsOut = fs.createWriteStream(opts.output, { flags: "a" });
  const orch = new Orchestrator({
    concurrency: opts.concurrency,
    permissionMode: opts.permissionMode,
    resultsOut,
    eventsOut: process.stderr,
  });

  const startedAt = Date.now();
  const summary = await orch.run(tasks);
  const elapsed = Date.now() - startedAt;

  // Flush results.jsonl.
  await new Promise<void>((resolve) => resultsOut.end(resolve));

  // Print summary.
  const total = tasks.length;
  process.stderr.write(
    `\n[swarm-coder] swarm complete in ${elapsed}ms: ${summary.succeeded}/${total} succeeded, ${summary.failed} failed, ${summary.timeout} timeout, ${summary.cancelled} cancelled${summary.resultWriteFailures > 0 ? ` (${summary.resultWriteFailures} result write failures)` : ""}\n`,
  );

  if (summary.resultWriteFailures > 0) return 1;
  if (summary.failed > 0 || summary.timeout > 0 || summary.cancelled > 0)
    return 1;
  return 0;
}
