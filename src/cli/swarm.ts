/**
 * swarm.ts — implementation of `swarm-harness swarm run <tasks-file>`.
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
   * built at startup (built-ins + custom from `.swarm-harness/roles.json`).
   */
  readonly defaultRole?: string;
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
          `[swarm-harness] TaskPacket policies are now discriminated unions — see docs/11-m3a-plan.md §Policy migration\n`,
        );
      }
      return 2;
    }
    const id = parsed.data.id ?? `task-${i + 1}`;
    tasks.push({ ...parsed.data, id } as TaskPacket);
  }

  if (tasks.length === 0) {
    process.stderr.write("error: tasks file contains zero tasks\n");
    return 2;
  }

  // Build RoleRegistry: built-ins + custom from .swarm-harness/roles.json.
  const roles = new RoleRegistry();
  for (const r of BUILTIN_ROLES) roles.register(r);
  const customRolesPath = path.join(
    process.cwd(),
    ".swarm-harness",
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
  });

  const startedAt = Date.now();
  const summary = await orch.run(tasks);
  const elapsed = Date.now() - startedAt;

  // Flush results.jsonl.
  await new Promise<void>((resolve) => resultsOut.end(resolve));

  // Print summary.
  const total = tasks.length;
  process.stderr.write(
    `\n[swarm-harness] swarm complete in ${elapsed}ms: ${summary.succeeded}/${total} succeeded, ${summary.failed} failed, ${summary.timeout} timeout, ${summary.cancelled} cancelled${summary.resultWriteFailures > 0 ? ` (${summary.resultWriteFailures} result write failures)` : ""}\n`,
  );

  if (summary.resultWriteFailures > 0) return 1;
  if (summary.deadLetterViolation) {
    if (summary.deadLetterWriteFailures > 0) {
      process.stderr.write(
        `[swarm-harness] exiting non-zero: dead-letter writer failed ${summary.deadLetterWriteFailures} time(s) writing to ${opts.deadLetter ?? "./dead-letter.jsonl"}; --allow-dead-letter does NOT suppress write failures\n`,
      );
    } else {
      process.stderr.write(
        `[swarm-harness] exiting non-zero: ${opts.deadLetter ?? "./dead-letter.jsonl"} has new entries from this run; pass --allow-dead-letter to accept\n`,
      );
    }
    return 1;
  }
  if (summary.failed > 0 || summary.timeout > 0 || summary.cancelled > 0)
    return 1;
  return 0;
}
