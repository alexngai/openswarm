/**
 * FX-CAS-001 — landing a stream onto a target that moved loses no commit
 * (docs/63 `WP-06`).
 *
 * Landing read the target branch twice. `git worktree add --detach <tmp>
 * <target>` resolved it once to decide what to merge onto, and `rev-parse
 * <target>` resolved it again to pick the compare-and-swap expectation. Those
 * are two different commits whenever the target advances in between, and the
 * combination is worse than either mistake alone: the merge is built on the old
 * tip, the CAS expects the new one, and the CAS therefore *succeeds* — moving
 * the branch to a commit that does not contain what was pushed in between.
 * Every commit in that window is dropped from the branch, silently, on a merge
 * that reported success.
 *
 * The window is injected with a real `post-checkout` hook, which git runs when
 * it checks out the landing worktree. That is the exact instant between the two
 * reads, so the race is reproduced rather than simulated: no git internals are
 * mocked, and the hook removes itself so only the first checkout races.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { GitCascadeBranchPolicyAdapter } from "./git-cascade-branch-policy.js";
import type { AgentId } from "../../core/types.js";

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: "pipe" }).toString().trim();
}

function makeMockTracker(): unknown {
  let n = 0;
  return {
    createStream: () => `s${++n}`,
    forkStream: () => `s${++n}`,
    createWorktree: () => ({}),
    commitChanges: () => ({ commit: "x", changeId: "c" }),
    trackExistingBranch: () => `i${++n}`,
    cascadeRebase: () => ({ success: true }),
    mergeStream: () => ({ success: true }),
    close: () => {},
  };
}

let repo: string;
let adapter: GitCascadeBranchPolicyAdapter;
const tmpDirs: string[] = [];

beforeEach(async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-cas-repo-"));
  tmpDirs.push(repo);
  git(repo, "init -q -b main");
  git(repo, "config user.email t@example.com");
  git(repo, "config user.name tester");
  fs.writeFileSync(path.join(repo, "base.ts"), "base\n");
  git(repo, "add -A");
  git(repo, "commit -q -m base");
  adapter = new GitCascadeBranchPolicyAdapter({
    repoPath: repo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackerForTest: makeMockTracker() as any,
  });
});

afterEach(async () => {
  await adapter.dispose();
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/** A real `stream/<id>` branch off `fromSha` touching a file nobody else does. */
async function makeCleanStream(agentId: AgentId, fromSha: string): Promise<string> {
  const res = await adapter.resolve({ kind: "stream", name: "x" }, agentId);
  const streamId = res.streamId!;
  const wt = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-cas-stream-"));
  tmpDirs.push(wt);
  git(repo, `worktree add -q ${JSON.stringify(wt)} -b stream/${streamId} ${fromSha}`);
  fs.writeFileSync(path.join(wt, "stream.ts"), "from the stream\n");
  git(wt, "add -A");
  git(wt, "commit -q -m stream-change");
  git(repo, `worktree remove --force ${JSON.stringify(wt)}`);
  return streamId;
}

/**
 * A commit on `main` that lands during the merge, prepared up front on a side
 * branch so the hook only has to move a ref. This is the commit that must
 * survive: it is what a concurrent agent, or a human, pushed while this landing
 * was in flight.
 */
function prepareRivalCommit(): string {
  git(repo, "branch rival");
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "swh-cas-rival-"));
  tmpDirs.push(wt);
  git(repo, `worktree add -q ${JSON.stringify(wt)} rival`);
  fs.writeFileSync(path.join(wt, "rival.ts"), "from the other agent\n");
  git(wt, "add -A");
  git(wt, "commit -q -m rival-work");
  const sha = git(wt, "rev-parse HEAD");
  git(repo, `worktree remove --force ${JSON.stringify(wt)}`);
  return sha;
}

/**
 * Advance `main` to `rival` the first time git checks out a worktree — i.e.
 * exactly when the landing worktree is created. Self-deleting, so the merge's
 * own later git calls run against a settled repository.
 */
function raceOnNextCheckout(): void {
  const hookDir = path.join(repo, ".git", "hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, "post-checkout");
  fs.writeFileSync(
    hook,
    `#!/bin/sh\ngit update-ref refs/heads/main refs/heads/rival\nrm -f "$0"\n`,
  );
  fs.chmodSync(hook, 0o755);
}

describe("FX-CAS-001 landing onto a moving target", () => {
  it("never drops a commit that landed on the target while the merge was in flight", async () => {
    const base = git(repo, "rev-parse HEAD");
    const streamId = await makeCleanStream("agent-cas" as AgentId, base);
    const rival = prepareRivalCommit();

    raceOnNextCheckout();
    const result = await adapter.mergeStreamIdIntoBranch(streamId, "main");

    // Either outcome is acceptable — a refusal the drain can retry, or a merge
    // that includes the commit it raced. What is not acceptable is a success
    // that silently rewinds the branch past somebody else's work.
    if (result.success) {
      const contains = git(repo, `merge-base --is-ancestor ${rival} refs/heads/main; echo $?`);
      expect(contains).toBe("0");
    } else {
      expect(result.errorType).toBe("stale");
    }

    // Whatever happened, the rival commit is still reachable from the branch.
    const reachable = execSync(`git merge-base --is-ancestor ${rival} refs/heads/main`, {
      cwd: repo,
      stdio: "pipe",
    });
    expect(reachable.toString()).toBe("");
  });

  it("reports stale rather than merging onto a tip it did not measure", async () => {
    // The mechanism behind the guarantee above: the worktree is created at the
    // exact sha the CAS will expect, so a target that moved makes the CAS fail
    // instead of succeeding against a base the merge never saw.
    const base = git(repo, "rev-parse HEAD");
    const streamId = await makeCleanStream("agent-cas2" as AgentId, base);
    prepareRivalCommit();

    raceOnNextCheckout();
    const result = await adapter.mergeStreamIdIntoBranch(streamId, "main");

    expect(result.success).toBe(false);
    expect(result.errorType).toBe("stale");
  });

  it("still merges cleanly when the target does not move", async () => {
    // The refusal has to be about the target moving, not about landing at all.
    const base = git(repo, "rev-parse HEAD");
    const streamId = await makeCleanStream("agent-cas3" as AgentId, base);

    const result = await adapter.mergeStreamIdIntoBranch(streamId, "main");

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(repo, "stream.ts"))).toBe(false); // repo cwd is untouched
    expect(git(repo, "log --format=%s -1 refs/heads/main")).toContain(`Merge stream/${streamId}`);
  });
});
