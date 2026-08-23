/**
 * Killing a child and killing what a child started are different operations.
 *
 * `child.kill()` signals one pid. A shell command is rarely one pid: `npm test`
 * is a shell that forks node that forks workers, and signalling the shell
 * leaves the rest running, detached from anything that would reap them. A
 * cancelled tool call has to take the whole tree with it, or "cancelled" only
 * describes openswarm's bookkeeping and not the machine.
 */

import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/**
 * Signal a child and everything it spawned.
 *
 * POSIX: signals the child's process group. This is safe to call on a child
 * that was *not* spawned detached, which is worth spelling out because
 * `kill(-pid)` looks alarming next to a non-detached child. A process group's
 * id is the pid of its leader. A non-detached child inherits our group, whose
 * id is our leader's pid — never the child's own pid, since pids are unique.
 * So `kill(-childPid)` either reaches a group the child leads, or matches
 * nothing and fails with ESRCH. It cannot reach ours.
 *
 * Windows has no process groups in this sense, so the tree is walked by
 * `taskkill /T`, which is asynchronous and best-effort.
 */
export function killProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  const pid = child.pid;
  if (pid === undefined) return; // spawn failed; there is no tree

  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {
      // Best effort: the tree is usually already gone, and there is no
      // meaningful recovery from failing to kill something that may not exist.
    });
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    // No group led by this pid: either the child was not spawned detached, or
    // it already exited. Fall back to the single pid, which covers the former
    // and harmlessly no-ops on the latter.
    try {
      child.kill(signal);
    } catch {
      // Already reaped.
    }
  }
}
