import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCascadeBranchPolicyAdapter } from "../adapters/git-cascade-branch-policy.js";
import { StandaloneHost } from "../standalone-host.js";
import { buildResolverSpawner } from "./resolver-spawner.js";
import type { ConflictContext } from "./types.js";
import type { AgentId } from "../../core/types.js";

/**
 * docs/44 P2b.4 — Loop 1: the spawn-resolver coordinator end-to-end against REAL
 * git + a REAL StandaloneHost coordination primitive. The resolver *agent* is
 * simulated (the ScriptedTestEngine can't execute tools — D5); everything else
 * is real: the conflicting merge, retain, the resolveConflict/wait signal, and
 * the CAS finalize. The real subprocess resolver path is the live test (P2b.5).
 */

// Isolate from the host ~/.gitconfig (gpgsign / hooks / editor) and supply a
// fixed identity via env, so no git command can block on an interactive prompt
// (a synchronous execSync hang would freeze the event loop, not time out).
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "tester",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "tester",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: "pipe", env: GIT_ENV })
    .toString()
    .trim();
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
let host: StandaloneHost;
const tmpDirs: string[] = [];

beforeEach(async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-p2b4-repo-"));
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
  host = new StandaloneHost({ branchPolicyAdapter: adapter });
});

afterEach(async () => {
  await adapter.dispose();
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeConflictingStream(
  agentId: AgentId,
  fromSha: string,
): Promise<string> {
  const res = await adapter.resolve({ kind: "stream", name: "x" }, agentId);
  const streamId = res.streamId!;
  const swt = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-p2b4-stream-"));
  tmpDirs.push(swt);
  git(repo, `worktree add -q ${JSON.stringify(swt)} -b stream/${streamId} ${fromSha}`);
  fs.writeFileSync(path.join(swt, "foo.ts"), "STREAM\nline2\n");
  git(swt, "add -A");
  git(swt, "commit -q -m stream-change");
  git(repo, `worktree remove --force ${JSON.stringify(swt)}`);
  return streamId;
}

const ctx = (over: Partial<ConflictContext>): ConflictContext => ({
  conflictId: "CID",
  sourceAgentId: "writerA" as AgentId,
  streamId: "s1",
  paths: ["foo.ts"],
  operation: "merge",
  recoveryDepth: 0,
  targetBranch: "main",
  ...over,
});

describe("spawn-resolver coordinator (real git + real coordination)", () => {
  it("resolves a real conflict end-to-end: retain → resolve → finalize", async () => {
    const base = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "foo.ts"), "MAIN\nline2\n");
    git(repo, "add -A");
    git(repo, "commit -q -m main-change");
    const streamId = await makeConflictingStream("writerA" as AgentId, base);

    let resolverCwd: string | undefined;
    const spawnResolver = buildResolverSpawner({
      // Simulated resolver agent: resolve the markers in its worktree, commit
      // (completing the merge), then signal resolution — what a real agent does.
      spawnResolver: async (spec) => {
        resolverCwd = spec.cwd;
        fs.writeFileSync(path.join(spec.cwd, "foo.ts"), "RESOLVED\nline2\n");
        git(spec.cwd, "add -A");
        git(spec.cwd, "commit -q --no-edit");
        host.resolveConflict("CID");
        return { agentId: "resolver-1", kill: async () => {} };
      },
      mergeWithRetain: (agentId, tb) =>
        host.mergeStreamToBranchForAgent(agentId as AgentId, {
          targetBranch: tb,
          retainOnConflict: true,
        }),
      waitForResolution: (cid, t) => host.waitForConflictResolution(cid, t),
      finalize: (o) => host.finalizeConflictResolution(o),
      timeoutMs: 5000,
    });

    const resolution = await spawnResolver(ctx({ streamId }));

    expect(resolution.kind).toBe("resolved");
    // main now points at the resolution; the resolved content landed.
    const mainHead = git(repo, "rev-parse main");
    if (resolution.kind === "resolved") {
      expect(resolution.resolutionCommit).toBe(mainHead);
    }
    expect(git(repo, "show main:foo.ts")).toBe("RESOLVED\nline2");
    // The retained worktree was removed by finalize.
    expect(resolverCwd).toBeDefined();
    expect(fs.existsSync(resolverCwd!)).toBe(false);
  });

  it("escalates when the resolver never signals (timeout)", async () => {
    const base = git(repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "foo.ts"), "MAIN\nline2\n");
    git(repo, "add -A");
    git(repo, "commit -q -m main-change");
    const streamId = await makeConflictingStream("writerB" as AgentId, base);
    const mainBefore = git(repo, "rev-parse main");

    let killed = false;
    const spawnResolver = buildResolverSpawner({
      spawnResolver: async () => ({
        agentId: "resolver-2",
        kill: async () => {
          killed = true;
        },
      }), // never signals
      mergeWithRetain: (agentId, tb) =>
        host.mergeStreamToBranchForAgent(agentId as AgentId, {
          targetBranch: tb,
          retainOnConflict: true,
        }),
      waitForResolution: (cid, t) => host.waitForConflictResolution(cid, t),
      finalize: (o) => host.finalizeConflictResolution(o),
      timeoutMs: 50,
    });

    const resolution = await spawnResolver(
      ctx({ sourceAgentId: "writerB" as AgentId, streamId }),
    );

    expect(resolution.kind).toBe("escalated");
    expect(killed).toBe(true);
    // main untouched.
    expect(git(repo, "rev-parse main")).toBe(mainBefore);
  });
});
