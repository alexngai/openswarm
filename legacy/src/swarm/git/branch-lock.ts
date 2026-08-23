/**
 * Branch lock — two layers:
 *
 * (A) Pure collision detector (diagnostic) — originally derived from a reference collision-detection
 *     routine and since evolved independently.
 *     Reports `(branch, module, laneIds)` tuples where 2+ intents claim the
 *     same branch AND overlapping modules. Read-only: consumers decide what
 *     to do with collisions.
 *
 * (B) Atomic filesystem lock (enforcement) — NEW design on top, original to OpenSwarm.
 *     Uses `fs.open(path, "wx")` (O_EXCL-equivalent) to acquire a single
 *     writer per branch. Lock file contents are JSON:
 *       { ownerAgentId, acquiredAt, pid, branch }
 *     Stale reclaim: on EEXIST, if the holding PID is dead (process.kill with
 *     sig=0 throws ESRCH) AND the lock is older than staleReclaimAfterMs,
 *     unlink + retry. Release is idempotent (double-release swallowed).
 *
 * Lock directory is anchored to `git rev-parse --git-common-dir` so multiple
 * worktrees sharing a `.git` serialize on the same lock space.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// (A) Collision detector — pure diagnostic function.
// ---------------------------------------------------------------------------

export interface BranchLockIntent {
  readonly laneId: string;
  readonly branch: string;
  readonly modules: readonly string[];
}

export interface BranchLockCollision {
  readonly branch: string;
  readonly module: string;
  readonly laneIds: readonly string[];
}

export function detectCollisions(
  intents: readonly BranchLockIntent[],
): readonly BranchLockCollision[] {
  const collisions: BranchLockCollision[] = [];

  for (let i = 0; i < intents.length; i++) {
    const left = intents[i]!;
    for (let j = i + 1; j < intents.length; j++) {
      const right = intents[j]!;
      if (left.branch !== right.branch) continue;
      for (const module of overlappingModules(left.modules, right.modules)) {
        collisions.push({
          branch: left.branch,
          module,
          laneIds: [left.laneId, right.laneId],
        });
      }
    }
  }

  collisions.sort((a, b) => {
    if (a.branch !== b.branch) return a.branch < b.branch ? -1 : 1;
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    const al = a.laneIds.join("\u0000");
    const bl = b.laneIds.join("\u0000");
    if (al === bl) return 0;
    return al < bl ? -1 : 1;
  });

  // dedup adjacent duplicates (post-sort, as Rust's Vec::dedup does).
  const deduped: BranchLockCollision[] = [];
  for (const c of collisions) {
    const prev = deduped[deduped.length - 1];
    if (
      prev !== undefined &&
      prev.branch === c.branch &&
      prev.module === c.module &&
      prev.laneIds.length === c.laneIds.length &&
      prev.laneIds.every((id, idx) => id === c.laneIds[idx])
    ) {
      continue;
    }
    deduped.push(c);
  }
  return deduped;
}

function overlappingModules(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const overlaps: string[] = [];
  for (const l of left) {
    for (const r of right) {
      if (modulesOverlap(l, r)) {
        overlaps.push(sharedScope(l, r));
      }
    }
  }
  overlaps.sort();
  // dedup adjacent duplicates.
  const deduped: string[] = [];
  for (const m of overlaps) {
    if (deduped[deduped.length - 1] !== m) deduped.push(m);
  }
  return deduped;
}

function modulesOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function sharedScope(left: string, right: string): string {
  if (left.startsWith(`${right}/`) || left === right) {
    return right;
  }
  return left;
}

// ---------------------------------------------------------------------------
// (B) Atomic filesystem lock.
// ---------------------------------------------------------------------------

export interface LockHandle {
  readonly branch: string;
  release(): Promise<void>;
}

export interface AcquireOptions {
  readonly agentId: string;
  readonly timeoutMs: number;
  /** Override lock directory (test-only). Default: `<git-common-dir>/openswarm/branch-locks`. */
  readonly lockDir?: string;
  /** cwd passed to `git rev-parse --git-common-dir` when `lockDir` is absent. */
  readonly cwd?: string;
  /** Poll interval while waiting on a held lock. Default 100ms. */
  readonly pollIntervalMs?: number;
  /** Age threshold for stale reclaim (dead PID + older than this). Default 30s. */
  readonly staleReclaimAfterMs?: number;
}

interface LockFileContent {
  readonly ownerAgentId: string;
  readonly acquiredAt: string;
  readonly pid: number;
  readonly branch: string;
}

export async function acquire(
  branch: string,
  opts: AcquireOptions,
): Promise<LockHandle> {
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const staleReclaimAfterMs = opts.staleReclaimAfterMs ?? 30_000;

  const lockDir = await resolveLockDir(opts.lockDir, opts.cwd);
  await fs.mkdir(lockDir, { recursive: true });

  const filename = sanitizeBranchName(branch);
  const lockPath = path.join(lockDir, filename);

  const deadline = Date.now() + opts.timeoutMs;
  let released = false;

  while (true) {
    try {
      const fh = await fs.open(lockPath, "wx");
      const content: LockFileContent = {
        ownerAgentId: opts.agentId,
        acquiredAt: new Date().toISOString(),
        pid: process.pid,
        branch,
      };
      try {
        await fh.writeFile(JSON.stringify(content, null, 2) + "\n", "utf8");
        await fh.close();
      } catch (err) {
        // Best-effort cleanup of partially-written lock file.
        await fh.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
        throw err;
      }
      return {
        branch,
        release: async () => {
          if (released) return;
          released = true;
          await fs.unlink(lockPath).catch((err: NodeJS.ErrnoException) => {
            if (err?.code !== "ENOENT") throw err;
          });
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }
      // Contention path — check if the holder is stale.
      const reclaimed = await tryReclaimStale(
        lockPath,
        staleReclaimAfterMs,
      );
      if (!reclaimed) {
        if (Date.now() >= deadline) {
          process.stderr.write(
            `branch-lock: timed out acquiring lock for branch "${branch}" after ${opts.timeoutMs}ms\n`,
          );
          throw new Error(
            `branch-lock: timed out acquiring lock for branch "${branch}" after ${opts.timeoutMs}ms`,
          );
        }
        await sleep(pollIntervalMs);
      }
      // Loop — either stale reclaimed (retry immediately) or we slept.
    }
  }
}

async function resolveLockDir(
  override: string | undefined,
  cwd: string | undefined,
): Promise<string> {
  if (override !== undefined) return override;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--git-common-dir"],
      { cwd: cwd ?? process.cwd() },
    );
    const gitDir = stdout.trim();
    // `--git-common-dir` may emit a relative path; resolve against cwd.
    const absolute = path.isAbsolute(gitDir)
      ? gitDir
      : path.resolve(cwd ?? process.cwd(), gitDir);
    return path.join(absolute, "openswarm", "branch-locks");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `branch-lock: not a git repository (or git rev-parse failed: ${msg})`,
    );
  }
}

async function tryReclaimStale(
  lockPath: string,
  staleReclaimAfterMs: number,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOENT — the holder released between our EEXIST and this read; retry.
    if (code === "ENOENT") return true;
    return false;
  }
  let parsed: LockFileContent;
  try {
    parsed = JSON.parse(raw) as LockFileContent;
  } catch {
    return false; // Malformed — treat as held; timeout path will handle it.
  }
  if (!isDeadPid(parsed.pid)) return false;
  const acquiredAtMs = Date.parse(parsed.acquiredAt);
  if (!Number.isFinite(acquiredAtMs)) return false;
  if (Date.now() - acquiredAtMs < staleReclaimAfterMs) return false;
  try {
    await fs.unlink(lockPath);
    process.stderr.write(
      `branch-lock: reclaimed stale lock for branch "${parsed.branch}" (pid=${parsed.pid})\n`,
    );
    return true;
  } catch {
    return false;
  }
}

function isDeadPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    // Signal 0 — check existence without delivering. Throws ESRCH if dead.
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists but we lack permission to signal it.
    if (code === "EPERM") return false;
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Filename sanitization.
// ---------------------------------------------------------------------------

/**
 * Sanitize a branch ref for use as a filename:
 *   - replace any char NOT in [A-Za-z0-9._-] with "-"
 *   - append a 4-char FNV-1a hash of the ORIGINAL branch so distinct refs
 *     with the same sanitized form don't collide (e.g. `a/b` and `a-b`).
 */
export function sanitizeBranchName(branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]/g, "-");
  const hash = fnv1a4(branch);
  return `${safe}-${hash}.lock`;
}

/** 4-char lower-hex FNV-1a 32-bit hash of the input (stable; pure). */
export function fnv1a4(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply (Math.imul avoids JS precision loss).
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return hex.slice(0, 4);
}
