import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCascadeBranchPolicyAdapter } from "./git-cascade-branch-policy.js";
import type { AgentId } from "../../core/types.js";

/** docs/44 P8 — streamId-keyed cascade primitives (pause/resume/abandon/push). */

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e.com",
    },
  })
    .toString()
    .trim();
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe("cascade lifecycle actions via the tracker", () => {
  let adapter: GitCascadeBranchPolicyAdapter;
  let repo: string;
  let pauseStream: ReturnType<typeof vi.fn>;
  let resumeStream: ReturnType<typeof vi.fn>;
  let abandonStream: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-cascade-act-"));
    tmpDirs.push(repo);
    git(repo, "init -q -b main");
    pauseStream = vi.fn();
    resumeStream = vi.fn();
    abandonStream = vi.fn();
    let n = 0;
    const tracker = {
      createStream: () => `s${++n}`,
      forkStream: () => `s${++n}`,
      createWorktree: () => ({}),
      commitChanges: () => ({ commit: "x", changeId: "c" }),
      trackExistingBranch: () => `i${++n}`,
      cascadeRebase: () => ({ success: true }),
      mergeStream: () => ({ success: true }),
      pauseStream,
      resumeStream,
      abandonStream,
      close: () => {},
    };
    adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: repo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trackerForTest: tracker as any,
    });
  });

  afterEach(async () => {
    await adapter.dispose();
  });

  it("pauseStream / resumeStream delegate to the tracker", async () => {
    expect(await adapter.pauseStream("s1", "hold")).toEqual({ success: true });
    expect(pauseStream).toHaveBeenCalledWith("s1", "hold");
    expect(await adapter.resumeStream("s1")).toEqual({ success: true });
    expect(resumeStream).toHaveBeenCalledWith("s1");
  });

  it("abandonStream delegates + prunes the agent mapping", async () => {
    const res = await adapter.resolve({ kind: "stream", name: "x" }, "agentA" as AgentId);
    const streamId = res.streamId!;
    expect(adapter.streamIdFor("agentA" as AgentId)).toBe(streamId);

    const r = await adapter.abandonStream(streamId, "stale");
    expect(r).toEqual({ success: true });
    expect(abandonStream).toHaveBeenCalledWith(streamId, { reason: "stale" });
    // The mapping is pruned so dispose/cleanup won't touch the abandoned tree.
    expect(adapter.streamIdFor("agentA" as AgentId)).toBeUndefined();
  });

  it("commitStream errors when the stream has no recorded worktree", async () => {
    const r = await adapter.commitStream("ghost", "msg");
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no recorded worktree/);
  });
});

describe("pushStream (real git)", () => {
  it("pushes stream/<id> to a bare remote, reports the sha", async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-push-repo-"));
    const remote = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-push-remote-"));
    tmpDirs.push(repo, remote);
    git(remote, "init -q --bare");
    git(repo, "init -q -b main");
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    git(repo, "add -A");
    git(repo, "commit -q -m base");
    git(repo, `remote add origin ${JSON.stringify(remote)}`);
    git(repo, "branch stream/sX");

    const adapter = new GitCascadeBranchPolicyAdapter({ repoPath: repo });
    try {
      const r = await adapter.pushStream("sX", "origin");
      expect(r.success).toBe(true);
      expect(r.pushedCommit).toMatch(/^[0-9a-f]{7,}/);
      // The bare remote now has stream/sX.
      const remoteBranches = git(remote, "branch --list stream/sX");
      expect(remoteBranches).toContain("stream/sX");
    } finally {
      await adapter.dispose();
    }
  });

  it("reports missing_source when stream/<id> doesn't exist", async () => {
    const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-push-ms-"));
    tmpDirs.push(repo);
    git(repo, "init -q -b main");
    fs.writeFileSync(path.join(repo, "f.txt"), "x\n");
    git(repo, "add -A");
    git(repo, "commit -q -m base");
    const adapter = new GitCascadeBranchPolicyAdapter({ repoPath: repo });
    try {
      const r = await adapter.pushStream("nope", "origin");
      expect(r).toEqual({ success: false, error: "missing_source" });
    } finally {
      await adapter.dispose();
    }
  });
});
