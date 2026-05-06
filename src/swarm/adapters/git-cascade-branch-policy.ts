/**
 * git-cascade-branch-policy.ts — BranchPolicyAdapter interface + identity
 * default impl.
 *
 * v0.7 stage 7A.1 (skeleton): defines the interface only. The
 * GitCascadeBranchPolicyAdapter implementation lands in 7A.3 alongside the
 * git-cascade dep.
 *
 * Per docs/29 §V0.7.Q7, the adapter pattern mirrors v0.5's taskWrapper
 * (5B opentasks) and v0.6's inboxBackend (6A.2 agent-inbox): an external
 * library wraps part of StandaloneHost's behavior via an injectable
 * interface, with an identity default that preserves existing semantics
 * for callers that don't opt in.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentId } from "../../core/types.js";
import type { BranchPolicy } from "../host.js";

/**
 * Result of resolving a BranchPolicy at spawn time. When `cwd` is set, the
 * orchestrator spawns the worker with that cwd (i.e. inside a worktree).
 * `streamId` and `branch` are surfaced for downstream commit-integration
 * (7B) which will reference them when routing `git commit` through
 * `tracker.commitChanges`.
 */
export interface BranchPolicyResolution {
  readonly cwd?: string;
  readonly streamId?: string;
  readonly branch?: string;
}

/**
 * BranchPolicyAdapter — pluggable resolver for BranchPolicy at spawn.
 *
 * Default implementation is identity (returns `{}` for all kinds). The
 * GitCascadeBranchPolicyAdapter (7A.3) handles `kind: "stream"` + `kind:
 * "fork"` by creating a stream + worktree via git-cascade and returning
 * the worktree path as `cwd`.
 */
export interface BranchPolicyAdapter {
  /**
   * Resolve a branch policy for an about-to-spawn member. Returns a
   * resolution that the orchestrator merges into the SpawnRequest. May be
   * a no-op (returns `{}`) for policies the adapter doesn't handle.
   */
  resolve(
    policy: BranchPolicy,
    agentId: AgentId,
  ): Promise<BranchPolicyResolution>;

  /**
   * Tear down adapter-owned resources (e.g. close git-cascade tracker db).
   * Called when the orchestrator shuts down.
   */
  dispose(): Promise<void>;
}

/**
 * Identity adapter — returns `{}` for all policies. Equivalent to no
 * branch-policy adapter; used as the default when StandaloneHost is
 * constructed without one.
 */
export class IdentityBranchPolicyAdapter implements BranchPolicyAdapter {
  async resolve(): Promise<BranchPolicyResolution> {
    return {};
  }
  async dispose(): Promise<void> {
    // no-op
  }
}

// ---------------------------------------------------------------------------
// GitCascadeBranchPolicyAdapter (v0.7 stage 7A.3)
// ---------------------------------------------------------------------------

/**
 * Lazy-loaded git-cascade tracker handle. Typed as `unknown` here to keep
 * the import dynamic — production callers pull the real `MultiAgentRepoTracker`
 * via `import("git-cascade")` only when this adapter is constructed.
 */
type MultiAgentRepoTrackerLike = {
  createStream(opts: {
    name: string;
    agentId: string;
    base?: string;
  }): string;
  forkStream(opts: {
    parentStreamId: string;
    name: string;
    agentId: string;
  }): string;
  createWorktree(opts: {
    agentId: string;
    path: string;
    branch?: string;
  }): unknown;
  close(): void;
};

export interface GitCascadeBranchPolicyAdapterOptions {
  /** Absolute path to the git repository (typically `process.cwd()`). */
  readonly repoPath: string;
  /**
   * sqlite db path. Default: `${repoPath}/.swarm-harness/git-cascade/tracker.db`
   * (per docs/29 §V0.7.Q6). Survives orchestrator restarts so cascade
   * rebases (7C+) can reach prior streams.
   */
  readonly dbPath?: string;
  /**
   * For tests: inject a pre-built tracker instead of constructing one
   * from `git-cascade`. Lets the test suite exercise the adapter logic
   * without a real repo + sqlite db.
   */
  readonly trackerForTest?: MultiAgentRepoTrackerLike;
}

/**
 * GitCascadeBranchPolicyAdapter — wraps `MultiAgentRepoTracker` to resolve
 * `kind: "stream"` and `kind: "fork"` BranchPolicy variants by creating a
 * stream + worktree and returning the worktree path as `cwd`. Other policy
 * kinds fall through to `{}` (the orchestrator uses default cwd).
 */
export class GitCascadeBranchPolicyAdapter implements BranchPolicyAdapter {
  private readonly repoPath: string;
  private tracker: MultiAgentRepoTrackerLike | undefined;
  private readonly dbPath: string;
  private readonly worktreesDir: string;
  /** Pending lazy-load (so concurrent resolve calls don't double-init). */
  private trackerPromise: Promise<MultiAgentRepoTrackerLike> | undefined;
  private readonly testTracker: MultiAgentRepoTrackerLike | undefined;

  constructor(opts: GitCascadeBranchPolicyAdapterOptions) {
    this.repoPath = opts.repoPath;
    this.dbPath =
      opts.dbPath ??
      path.join(this.repoPath, ".swarm-harness", "git-cascade", "tracker.db");
    this.worktreesDir = path.join(
      this.repoPath,
      ".swarm-harness",
      "worktrees",
    );
    this.testTracker = opts.trackerForTest;
  }

  async resolve(
    policy: BranchPolicy,
    agentId: AgentId,
  ): Promise<BranchPolicyResolution> {
    if (policy.kind !== "stream" && policy.kind !== "fork") {
      return {};
    }
    const tracker = await this.ensureTracker();

    let streamId: string;
    if (policy.kind === "stream") {
      streamId = tracker.createStream({
        name: policy.name ?? `${agentId}-${Date.now()}`,
        agentId,
        ...(policy.baseStreamId !== undefined && { base: policy.baseStreamId }),
      });
    } else {
      streamId = tracker.forkStream({
        parentStreamId: policy.parentStreamId,
        name: policy.name ?? `${agentId}-fork-${Date.now()}`,
        agentId,
      });
    }

    const worktreePath = path.join(this.worktreesDir, streamId);
    const branch = `stream/${streamId}`;
    tracker.createWorktree({
      agentId,
      path: worktreePath,
      branch,
    });

    return { cwd: worktreePath, streamId, branch };
  }

  async dispose(): Promise<void> {
    if (this.tracker !== undefined) {
      try {
        this.tracker.close();
      } catch {
        // close() throws when db is already closed — safe to swallow.
      }
      this.tracker = undefined;
    }
  }

  private async ensureTracker(): Promise<MultiAgentRepoTrackerLike> {
    if (this.tracker !== undefined) return this.tracker;
    // Test injection: pin to this.tracker so dispose() finds it.
    if (this.testTracker !== undefined) {
      this.tracker = this.testTracker;
      return this.tracker;
    }
    if (this.trackerPromise !== undefined) return this.trackerPromise;

    this.trackerPromise = (async () => {
      // Ensure parent dirs exist for the db + worktrees.
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      fs.mkdirSync(this.worktreesDir, { recursive: true });

      // Lazy-import so test harnesses that don't have git-cascade installed
      // can still run the rest of the suite. The dynamic import is wrapped
      // so a missing package surfaces as a clear runtime error rather than
      // a module-load failure at the top of the file.
      const mod = (await import(
        /* @vite-ignore */ "git-cascade" as string
      )) as {
        MultiAgentRepoTracker: new (
          opts: { repoPath: string; dbPath: string },
        ) => MultiAgentRepoTrackerLike;
      };
      const tracker = new mod.MultiAgentRepoTracker({
        repoPath: this.repoPath,
        dbPath: this.dbPath,
      });
      this.tracker = tracker;
      return tracker;
    })();

    return this.trackerPromise;
  }
}
