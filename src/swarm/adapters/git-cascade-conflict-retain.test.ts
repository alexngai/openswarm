import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCascadeBranchPolicyAdapter } from "./git-cascade-branch-policy.js";
import type { AgentId } from "../../core/types.js";

/** docs/44 P2b — retain-on-conflict + finalizeConflictResolution, real git. */

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: "pipe" }).toString().trim();
}

/** Minimal MultiAgentRepoTrackerLike: just enough for resolve() to record a
 *  stream mapping. The real merge runs against actual git branches we create. */
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
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-retain-repo-"));
  tmpDirs.push(repo);
  git(repo, "init -q -b main");
  git(repo, "config user.email t@example.com");
  git(repo, "config user.name tester");
  fs.writeFileSync(path.join(repo, "foo.ts"), "line1\nline2\n");
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

/** Create a real `stream/<id>` branch from BASE with a conflicting change, and
 *  record it in the adapter via resolve(). Returns the streamId. */
async function makeConflictingStream(
  agentId: AgentId,
  fromSha: string,
): Promise<string> {
  const res = await adapter.resolve({ kind: "stream", name: "x" }, agentId);
  const streamId = res.streamId!;
  const swt = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-stream-wt-"));
  tmpDirs.push(swt);
  git(repo, `worktree add -q ${JSON.stringify(swt)} -b stream/${streamId} ${fromSha}`);
  fs.writeFileSync(path.join(swt, "foo.ts"), "STREAM\nline2\n");
  git(swt, "add -A");
  git(swt, "commit -q -m stream-change");
  git(repo, `worktree remove --force ${JSON.stringify(swt)}`);
  return streamId;
}

describe("mergeStreamToBranch retain-on-conflict", () => {
  it("retains the conflicted worktree and surfaces paths + oldSha", async () => {
    // main diverges from base so the stream merge conflicts on foo.ts line 1.
    const base = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "foo.ts"), "MAIN\nline2\n");
    git(repo, "add -A");
    git(repo, "commit -q -m main-change");
    const mainSha = git(repo, "rev-parse main");
    await makeConflictingStream("agentA" as AgentId, base);

    const r = await adapter.mergeStreamToBranch({
      sourceAgentId: "agentA" as AgentId,
      targetBranch: "main",
      retainOnConflict: true,
    });

    expect(r.success).toBe(false);
    expect(r.errorType).toBe("conflict");
    expect(r.conflicts).toContain("foo.ts");
    expect(r.targetOldSha).toBe(mainSha);
    expect(r.conflictWorktree).toBeDefined();
    expect(fs.existsSync(r.conflictWorktree!)).toBe(true);
    // The worktree holds the in-progress merge with conflict markers.
    const conflicted = fs.readFileSync(
      path.join(r.conflictWorktree!, "foo.ts"),
      "utf8",
    );
    expect(conflicted).toContain("<<<<<<<");

    // Resolve in place + finalize.
    fs.writeFileSync(path.join(r.conflictWorktree!, "foo.ts"), "RESOLVED\nline2\n");
    git(r.conflictWorktree!, "add -A");
    git(r.conflictWorktree!, "commit -q --no-edit");
    const resolutionCommit = git(r.conflictWorktree!, "rev-parse HEAD");

    const fin = await adapter.finalizeConflictResolution({
      worktree: r.conflictWorktree!,
      targetBranch: "main",
      oldSha: r.targetOldSha!,
      resolutionCommit,
    });

    expect(fin.success).toBe(true);
    expect(git(repo, "rev-parse main")).toBe(resolutionCommit);
    expect(fs.existsSync(r.conflictWorktree!)).toBe(false); // removed
  });

  it("default (no retain) cleans up and returns no conflictWorktree", async () => {
    const base = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "foo.ts"), "MAIN\nline2\n");
    git(repo, "add -A");
    git(repo, "commit -q -m main-change");
    await makeConflictingStream("agentB" as AgentId, base);

    const r = await adapter.mergeStreamToBranch({
      sourceAgentId: "agentB" as AgentId,
      targetBranch: "main",
    });

    expect(r.success).toBe(false);
    expect(r.errorType).toBe("conflict");
    expect(r.conflicts).toContain("foo.ts");
    expect(r.conflictWorktree).toBeUndefined();
  });

  it("finalizeConflictResolution reports stale on a CAS mismatch", async () => {
    const base = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "foo.ts"), "MAIN\nline2\n");
    git(repo, "add -A");
    git(repo, "commit -q -m main-change");
    await makeConflictingStream("agentC" as AgentId, base);

    const r = await adapter.mergeStreamToBranch({
      sourceAgentId: "agentC" as AgentId,
      targetBranch: "main",
      retainOnConflict: true,
    });
    fs.writeFileSync(path.join(r.conflictWorktree!, "foo.ts"), "RESOLVED\nline2\n");
    git(r.conflictWorktree!, "add -A");
    git(r.conflictWorktree!, "commit -q --no-edit");
    const resolutionCommit = git(r.conflictWorktree!, "rev-parse HEAD");

    const fin = await adapter.finalizeConflictResolution({
      worktree: r.conflictWorktree!,
      targetBranch: "main",
      oldSha: "0000000000000000000000000000000000000000", // wrong → CAS fails
      resolutionCommit,
    });

    expect(fin.success).toBe(false);
    expect(fin.errorType).toBe("stale");
  });
});
