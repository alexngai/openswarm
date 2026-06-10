import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitCascadeBranchPolicyAdapter } from "../adapters/git-cascade-branch-policy.js";
import { StandaloneHost } from "../standalone-host.js";
import { TeamSession } from "../team-session.js";
import { buildResolverSpawner } from "./resolver-spawner.js";
import type { ConflictContext } from "./types.js";
import type { AgentId } from "../../core/types.js";

/**
 * docs/44 P2b.5 — Loop 2: the spawn-resolver loop with a REAL resolver
 * subprocess driven by the live engine (Claude). Skipped unless
 * `SWARM_HARNESS_LIVE_RESOLVER=1`. This is the only path that exercises real
 * agent-driven conflict resolution + the resolve_conflict IPC end-to-end
 * (ScriptedTestEngine can't execute tools — D5). Requires `dist/cli.js`
 * (built by the integration globalSetup) + Claude auth. Costs tokens.
 *
 * Run: SWARM_HARNESS_LIVE_RESOLVER=1 npx vitest run \
 *   src/swarm/recovery/resolver-spawner.live.test.ts
 */

const LIVE = process.env.SWARM_HARNESS_LIVE_RESOLVER === "1";

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
let team: TeamSession;
const tmpDirs: string[] = [];

beforeAll(() => {
  if (!LIVE) return;
  // dist/cli.js must exist (integration globalSetup builds it).
  const cli = path.resolve(process.cwd(), "dist/cli.js");
  if (!fs.existsSync(cli)) {
    throw new Error(`live resolver test needs ${cli}; run \`npm run build\` first`);
  }
});

afterEach(async () => {
  if (team) await team.dispose().catch(() => {});
  if (adapter) await adapter.dispose().catch(() => {});
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe.skipIf(!LIVE)("spawn-resolver with a live Claude resolver", () => {
  it(
    "resolves a real conflict via a real resolver subprocess",
    async () => {
      repo = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-p2b5-repo-"));
      tmpDirs.push(repo);
      git(repo, "init -q -b main");
      fs.writeFileSync(
        path.join(repo, "greeting.txt"),
        "Hello, world!\nGoodbye.\n",
      );
      git(repo, "add -A");
      git(repo, "commit -q -m base");
      const base = git(repo, "rev-parse HEAD");

      // main diverges on line 1.
      fs.writeFileSync(
        path.join(repo, "greeting.txt"),
        "Hello, MAIN!\nGoodbye.\n",
      );
      git(repo, "add -A");
      git(repo, "commit -q -m main-change");

      adapter = new GitCascadeBranchPolicyAdapter({
        repoPath: repo,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trackerForTest: makeMockTracker() as any,
      });
      host = new StandaloneHost({ branchPolicyAdapter: adapter });

      // Conflicting stream off the base.
      const res = await adapter.resolve(
        { kind: "stream", name: "writer" },
        "writer" as AgentId,
      );
      const streamId = res.streamId!;
      const swt = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-p2b5-stream-"));
      tmpDirs.push(swt);
      git(repo, `worktree add -q ${JSON.stringify(swt)} -b stream/${streamId} ${base}`);
      fs.writeFileSync(
        path.join(swt, "greeting.txt"),
        "Hello, STREAM!\nGoodbye.\n",
      );
      git(swt, "add -A");
      git(swt, "commit -q -m stream-change");
      git(repo, `worktree remove --force ${JSON.stringify(swt)}`);

      team = new TeamSession({
        name: "live-resolver",
        host,
        permissionMode: "workspace-write",
      });

      const spawnResolver = buildResolverSpawner({
        spawnResolver: async (spec) => {
          const h = await team.spawnMember({
            role: spec.role,
            prompt: spec.prompt,
            branchPolicy: spec.branchPolicy,
            cwd: spec.cwd,
          });
          return { agentId: h.agentId, kill: () => h.kill() };
        },
        mergeWithRetain: (agentId, tb) =>
          host.mergeStreamToBranchForAgent(agentId as AgentId, {
            targetBranch: tb,
            retainOnConflict: true,
          }),
        waitForResolution: (cid, t) => host.waitForConflictResolution(cid, t),
        finalize: (o) => host.finalizeConflictResolution(o),
        timeoutMs: 180_000,
      });

      const ctx: ConflictContext = {
        conflictId: "live-conflict-1",
        sourceAgentId: "writer" as AgentId,
        streamId,
        paths: ["greeting.txt"],
        operation: "merge",
        recoveryDepth: 0,
        targetBranch: "main",
      };

      const resolution = await spawnResolver(ctx);

      expect(resolution.kind).toBe("resolved");
      // main advanced and no conflict markers remain.
      const merged = git(repo, "show main:greeting.txt");
      expect(merged).not.toContain("<<<<<<<");
      expect(merged).toContain("Goodbye.");
    },
    240_000,
  );
});
