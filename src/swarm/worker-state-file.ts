/**
 * worker-state-file.ts — atomic worker state persistence.
 *
 * Each worker writes a JSON state file to ~/.swarm-harness/workers/<agentId>.json
 * (pattern borrowed from claw's .claw/worker-state.json). Orchestrator reads
 * these files for crash recovery — if a worker dies without emitting a final
 * event, the state file is the last known good record.
 *
 * Pure Node module: no UI deps. All file I/O is synchronous to keep the
 * lifecycle hot-path free of await chains.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentId } from "../core/types.js";
import type { WorkerLifecycleState } from "./worker-lifecycle.js";
import type { FailureClass } from "./events.js";

export interface WorkerStateFile {
  readonly agentId: AgentId;
  readonly pid: number;
  readonly startedAt: number; // epoch ms
  readonly lifecycleState: WorkerLifecycleState;
  readonly lastTransitionAt: number; // epoch ms
  readonly taskId?: string;
  readonly parentAgentId?: AgentId;
  readonly failureClass?: FailureClass;
  readonly reason?: string;
}

export const DEFAULT_WORKERS_DIR = path.join(
  os.homedir(),
  ".swarm-harness",
  "workers",
);

/** Resolve the base directory: prefer `baseDir` arg, then env override, then default. */
function resolveDir(baseDir?: string): string {
  return baseDir ?? process.env["SWARM_HARNESS_WORKERS_DIR"] ?? DEFAULT_WORKERS_DIR;
}

/** Absolute path to the state file for a given agentId. */
export function workerStateFilePath(agentId: AgentId, baseDir?: string): string {
  return path.join(resolveDir(baseDir), `${agentId}.json`);
}

/**
 * Atomically write a WorkerStateFile to disk.
 *
 * Uses write-to-tmp + rename so readers always see a complete file.
 * Ensures the directory exists (recursive mkdirSync) before writing.
 */
export function writeWorkerState(state: WorkerStateFile, baseDir?: string): void {
  const dir = resolveDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = workerStateFilePath(state.agentId, baseDir);
  const tmpPath = `${filePath}.tmp`;

  fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read the state file for a given agentId.
 * Returns null on missing file or JSON parse error.
 */
export function readWorkerState(agentId: AgentId, baseDir?: string): WorkerStateFile | null {
  const filePath = workerStateFilePath(agentId, baseDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as WorkerStateFile;
  } catch {
    return null;
  }
}

/**
 * Scan the workers directory and return all valid WorkerStateFile entries.
 * Silently skips malformed or unreadable files.
 */
export function listWorkerStates(baseDir?: string): WorkerStateFile[] {
  const dir = resolveDir(baseDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const results: WorkerStateFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as WorkerStateFile;
      results.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return results;
}

/**
 * Best-effort remove the state file for a given agentId.
 * No-op if the file is already missing.
 */
export function removeWorkerState(agentId: AgentId, baseDir?: string): void {
  const filePath = workerStateFilePath(agentId, baseDir);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op on ENOENT or any other error
  }
}

/**
 * Check whether a process is alive by sending signal 0.
 * Returns true if the process exists, false if ESRCH or any error.
 */
export function isWorkerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
