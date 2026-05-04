/**
 * team-paths.ts — shared path computation for the team daemon.
 *
 * v0.5 stage 5E follow-up: macOS Unix socket `sun_path` is limited to ~104
 * characters, and the natural `${TMPDIR}/swarm-harness/teams/<name>/daemon.sock`
 * path under `/var/folders/.../T/` regularly exceeds it. The kernel silently
 * truncates the filename, so the daemon binds to a path that the client
 * can't connect to.
 *
 * Fix: when the natural socket path would exceed a safe length, fall back
 * to a short hash-based path under `/tmp/swh-<hash>.sock`. The hash is
 * derived from the natural path so the same team always gets the same
 * shortened socket location — the CLI client and the daemon agree without
 * needing to communicate the mapping.
 *
 * Other paths (pid, events.jsonl, state.json, daemon.log, spec.json) live
 * in the natural team dir — they have no length constraint.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/**
 * On darwin the limit is 104 chars; on linux 108. Pick a conservative cap
 * that leaves headroom for trailing nulls + clears both platforms.
 */
const SOCK_PATH_MAX = 100;

/** Where short-fallback sockets live when the natural path is too long. */
const SHORT_SOCK_DIR = "/tmp";
const SHORT_SOCK_PREFIX = "swh-";

export interface TeamPaths {
  /** Per-team directory holding pid / events / state / log / spec. */
  readonly dir: string;
  /** Unix socket path. May be inside `dir` OR a short fallback under /tmp. */
  readonly sockPath: string;
  readonly pidPath: string;
  readonly eventsPath: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly specPath: string;
}

/**
 * Compute the on-disk paths a daemon owns for a given team name. The socket
 * path is shortened via hash fallback when the natural path would exceed
 * the Unix `sun_path` limit (V0.5 stage 5E follow-up).
 */
export function computeTeamPaths(teamName: string): TeamPaths {
  // V0.5.Q3 — XDG_RUNTIME_DIR with TMPDIR fallback for darwin.
  const baseDir =
    process.env.XDG_RUNTIME_DIR !== undefined &&
    process.env.XDG_RUNTIME_DIR !== ""
      ? process.env.XDG_RUNTIME_DIR
      : (process.env.TMPDIR ?? os.tmpdir());
  const dir = path.join(baseDir, "swarm-harness", "teams", teamName);

  const naturalSockPath = path.join(dir, "daemon.sock");
  const sockPath =
    naturalSockPath.length > SOCK_PATH_MAX
      ? shortSockPath(naturalSockPath)
      : naturalSockPath;

  return {
    dir,
    sockPath,
    pidPath: path.join(dir, "daemon.pid"),
    eventsPath: path.join(dir, "events.jsonl"),
    statePath: path.join(dir, "state.json"),
    logPath: path.join(dir, "daemon.log"),
    specPath: path.join(dir, "spec.json"),
  };
}

/**
 * Hash-based shortened socket path. Same input → same output, so the CLI
 * client and the daemon compute identical paths without needing to share
 * state.
 *
 * Exposed for tests; production callers should use computeTeamPaths.
 */
export function shortSockPath(naturalPath: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(naturalPath)
    .digest("hex")
    .slice(0, 12);
  return path.join(SHORT_SOCK_DIR, `${SHORT_SOCK_PREFIX}${hash}.sock`);
}

/** Base directory used by `team list` to enumerate per-team subdirs. */
export function teamsBaseDir(): string {
  const baseDir =
    process.env.XDG_RUNTIME_DIR !== undefined &&
    process.env.XDG_RUNTIME_DIR !== ""
      ? process.env.XDG_RUNTIME_DIR
      : (process.env.TMPDIR ?? os.tmpdir());
  return path.join(baseDir, "swarm-harness", "teams");
}
