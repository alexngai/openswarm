import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCascadeBranchPolicyAdapter } from "./git-cascade-branch-policy.js";

/** docs/44 P4 — enqueue + ordered drain into a branch, real git. */

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: "pipe", env: GIT_ENV })
    .toString()
    .trim();
}

/** In-memory merge queue + minimal stream stubs (the merge runs on real git). */
function makeQueueTracker(): unknown {
  type E = {
    id: string;
    streamId: string;
    targetBranch: string;
    status: string;
    priority: number;
    seq: number;
  };
  const entries: E[] = [];
  let id = 0;
  let seq = 0;
  return {
    createStream: () => `s${++id}`,
    forkStream: () => `s${++id}`,
    createWorktree: () => ({}),
    commitChanges: () => ({ commit: "x", changeId: "c" }),
    trackExistingBranch: () => `i${++id}`,
    cascadeRebase: () => ({ success: true }),
    mergeStream: () => ({ success: true }),
    addToMergeQueue: (o: { streamId: string; targetBranch?: string; priority?: number }) => {
      const eid = `e${++id}`;
      entries.push({
        id: eid,
        streamId: o.streamId,
        targetBranch: o.targetBranch ?? "main",
        status: "pending",
        priority: o.priority ?? 100,
        seq: seq++,
      });
      return eid;
    },
    markMergeQueueReady: (eid: string) => {
      const e = entries.find((x) => x.id === eid);
      if (e) e.status = "ready";
    },
    getNextToMerge: (targetBranch?: string) => {
      const ready = entries
        .filter(
          (e) =>
            e.status === "ready" &&
            (targetBranch === undefined || e.targetBranch === targetBranch),
        )
        .sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      return ready[0] ?? null;
    },
    removeFromMergeQueue: (eid: string) => {
      const i = entries.findIndex((x) => x.id === eid);
      if (i >= 0) entries.splice(i, 1);
    },
    cancelMergeQueueEntry: (eid: string) => {
      const e = entries.find((x) => x.id === eid);
      if (e) e.status = "cancelled";
    },
    close: () => {},
  };
}

let repo: string;
let adapter: GitCascadeBranchPolicyAdapter;
const tmpDirs: string[] = [];

beforeEach(async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-mq-repo-"));
  tmpDirs.push(repo);
  git(repo, "init -q -b main");
  git(repo, "config user.email t@example.com");
  git(repo, "config user.name tester");
  git(repo, "config commit.gpgsign false");
  fs.writeFileSync(path.join(repo, "a.txt"), "a0\n");
  fs.writeFileSync(path.join(repo, "b.txt"), "b0\n");
  fs.writeFileSync(path.join(repo, "shared.txt"), "s0\n");
  git(repo, "add -A");
  git(repo, "commit -q -m base");
  adapter = new GitCascadeBranchPolicyAdapter({
    repoPath: repo,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackerForTest: makeQueueTracker() as any,
  });
});

afterEach(async () => {
  await adapter.dispose();
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeStream(
  streamId: string,
  fromSha: string,
  file: string,
  content: string,
): Promise<void> {
  const swt = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-mq-stream-"));
  tmpDirs.push(swt);
  git(repo, `worktree add -q ${JSON.stringify(swt)} -b stream/${streamId} ${fromSha}`);
  fs.writeFileSync(path.join(swt, file), content);
  git(swt, "add -A");
  git(swt, `commit -q -m ${streamId}`);
  git(repo, `worktree remove --force ${JSON.stringify(swt)}`);
}

describe("merge queue drain (real git)", () => {
  it("drains in priority/FIFO order, merging each stream into the target", async () => {
    const base = git(repo, "rev-parse HEAD");
    await makeStream("sA", base, "a.txt", "aA\n");
    await makeStream("sB", base, "b.txt", "bB\n");

    expect(await adapter.enqueueMerge({ streamId: "sA", targetBranch: "main" })).toBeTruthy();
    expect(await adapter.enqueueMerge({ streamId: "sB", targetBranch: "main" })).toBeTruthy();

    const r = await adapter.drainMergeQueue({ targetBranch: "main" });
    expect(r).not.toBeNull();
    expect(r!.merged.map((m) => m.streamId)).toEqual(["sA", "sB"]);
    expect(r!.failed).toEqual([]);
    // Both members' changes landed on main.
    expect(git(repo, "show main:a.txt")).toBe("aA");
    expect(git(repo, "show main:b.txt")).toBe("bB");
  });

  it("surfaces a conflicting stream as failed and keeps draining the rest", async () => {
    const base = git(repo, "rev-parse HEAD");
    // main advances shared.txt; sC also edits it from base → conflict.
    fs.writeFileSync(path.join(repo, "shared.txt"), "MAIN\n");
    git(repo, "add -A");
    git(repo, "commit -q -m main-change");
    await makeStream("sC", base, "shared.txt", "STREAM\n"); // conflicts
    await makeStream("sD", base, "a.txt", "aD\n"); // clean

    await adapter.enqueueMerge({ streamId: "sC", targetBranch: "main", priority: 1 });
    await adapter.enqueueMerge({ streamId: "sD", targetBranch: "main", priority: 2 });

    const r = await adapter.drainMergeQueue({ targetBranch: "main" });
    expect(r!.failed.map((f) => f.streamId)).toEqual(["sC"]);
    expect(r!.failed[0]!.error).toMatch(/conflict on shared\.txt/);
    expect(r!.merged.map((m) => m.streamId)).toEqual(["sD"]);
    // sD landed; sC did not.
    expect(git(repo, "show main:a.txt")).toBe("aD");
    expect(git(repo, "show main:shared.txt")).toBe("MAIN");
  });

  it("returns null when the tracker has no queue", async () => {
    const a = new GitCascadeBranchPolicyAdapter({
      repoPath: repo,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trackerForTest: { createStream: () => "s", createWorktree: () => ({}), close: () => {} } as any,
    });
    expect(await a.enqueueMerge({ streamId: "s", targetBranch: "main" })).toBeNull();
    expect(await a.drainMergeQueue({ targetBranch: "main" })).toBeNull();
    await a.dispose();
  });
});
