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
 * Result of a commitChanges call: which stream the commit landed on,
 * the resulting commit sha, and the stable Change-Id trailer git-cascade
 * embedded in the commit message.
 */
export interface CommitChangesResult {
  readonly streamId: string;
  readonly commitSha: string;
  readonly changeId?: string;
}

/**
 * BranchPolicyAdapter — pluggable resolver for BranchPolicy at spawn.
 *
 * Default implementation is identity (returns `{}` for all kinds). The
 * GitCascadeBranchPolicyAdapter (7A.3) handles `kind: "stream"` + `kind:
 * "fork"` by creating a stream + worktree via git-cascade and returning
 * the worktree path as `cwd`. v0.7 stage 7B adds an optional
 * `commitChanges` method so workers can route `git commit` through
 * `tracker.commitChanges` for Change-Id trailers + audit log.
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

  /**
   * v0.7 stage 7B: commit on behalf of an agent. The adapter looks up the
   * agent's stream + worktree (recorded during resolve) and routes the
   * commit through `tracker.commitChanges` so Change-Id trailers + audit
   * log kick in. Returns null when the agent isn't in a stream context
   * (e.g. branchPolicy was none/reuse/create); caller should fall back
   * to plain git for those.
   *
   * Optional — backends that don't manage streams (IdentityBranchPolicy
   * Adapter) should omit the method; callers feature-detect.
   */
  commitChanges?(
    agentId: AgentId,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<CommitChangesResult | null>;

  /**
   * v0.7 stage 7C: look up the streamId an agent is operating on. Topology
   * code calls this after `await team.spawnAll(specs)` to find each
   * member's stream so it can auto-merge on team completion. Returns
   * undefined when no stream is recorded (e.g. branchPolicy was
   * none/reuse/create).
   */
  streamIdFor?(agentId: AgentId): string | undefined;

  /**
   * v0.7 stage 7C: merge a source stream into a target via tracker.merge
   * Stream. Returns the result (success / conflicts / error). Optional;
   * caller feature-detects. Non-throwing — git-cascade returns
   * `{success: false, errorType, ...}` rather than throwing on conflicts.
   */
  mergeStream?(opts: MergeStreamOptions): Promise<MergeStreamResult>;

  /**
   * v0.7 stage 7F: look up or create an "integrator" stream that wraps
   * an existing git branch (e.g. `main`). git-cascade's mergeStream
   * needs targets to be streams; integrator streams have no worktree so
   * the merge can `git checkout` them in the source's worktree without
   * conflict. Idempotent — repeat calls with the same branch return the
   * cached streamId. Optional; caller feature-detects.
   *
   * Note: git-cascade's mergeStream hardcodes `stream/<id>` branch names
   * and won't accept an integrator stream as target. Use mergeStreamToBranch
   * for the "merge into existing branch" use case instead — this method
   * is exposed primarily for cascade rebase parent linkage.
   */
  ensureIntegratorStream?(branch: string): Promise<string>;

  /**
   * v0.7 stage 7F: merge a stream's changes into an existing git branch
   * via plain git (`git checkout target && git merge --no-ff stream/<src>`).
   * Used when the target is a real branch (e.g. `main`) rather than a
   * synthetic stream — git-cascade's mergeStream can't handle this case.
   * Performed in a temporary worktree so it doesn't disturb the source
   * worktree's checkout state. Optional; caller feature-detects.
   */
  mergeStreamToBranch?(opts: {
    sourceAgentId: AgentId;
    targetBranch: string;
    strategy?: string;
  }): Promise<MergeStreamResult>;
}

/**
 * v0.7 stage 7C: merge options exposed by the adapter. Maps directly to
 * git-cascade's MergeStreamOptions but uses the adapter's sourceAgentId
 * indirection so callers can supply an agentId instead of looking up the
 * worktree themselves.
 */
export interface MergeStreamOptions {
  readonly sourceAgentId: AgentId;
  readonly targetStream: string;
  readonly strategy?: string;
}

export interface MergeStreamResult {
  readonly success: boolean;
  readonly newHead?: string;
  readonly conflicts?: readonly string[];
  readonly error?: string;
  readonly errorType?: string;
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
  // v0.7 stage 7B — note: git-cascade's tracker returns { commit, changeId },
  // not { commitSha, changeId }. The adapter normalises this to commitSha
  // on the way out so callers see a consistent name.
  commitChanges(opts: {
    streamId: string;
    agentId: string;
    worktree: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): {
    commit: string;
    changeId: string;
    [key: string]: unknown;
  };
  // v0.7 stage 7F — track an existing git branch (e.g. main) as a
  // worktree-less stream so it can serve as a merge target. git-cascade's
  // mergeStream requires the target stream to NOT have an active worktree
  // (it does `git checkout target` in the source's worktree).
  trackExistingBranch(opts: {
    branch: string;
    agentId: string;
    name?: string;
  }): string;
  // v0.7 stage 7C
  mergeStream(opts: {
    sourceStream: string;
    targetStream: string;
    agentId: string;
    worktree: string;
    strategy?: string;
  }): {
    success: boolean;
    newHead?: string;
    conflicts?: string[];
    error?: string;
    errorType?: string;
  };
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
  /**
   * v0.7 stage 7H: when true, dispose() removes every worktree the
   * adapter created during the run via `git worktree remove --force`,
   * then prunes git's worktree registry. Default false (matches the
   * audit-trail philosophy — operators opt in to cleanup).
   */
  readonly cleanupOnDispose?: boolean;
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
  /** v0.7 stage 7H: opt-in worktree cleanup at dispose() time. */
  private readonly cleanupOnDispose: boolean;
  /**
   * v0.7 stage 7B: agentId → {streamId, worktree} captured on resolve so
   * commitChanges can look them up without re-querying git-cascade.
   */
  private readonly agentStreams = new Map<
    AgentId,
    { streamId: string; worktree: string }
  >();

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
    this.cleanupOnDispose = opts.cleanupOnDispose ?? false;
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
      // baseStreamId, when set, means "fork from this stream" — route
      // through forkStream so git-cascade can resolve the parent's branch
      // internally. createStream({base}) expects a git ref/branch and
      // would reject a raw streamId. (Bug surfaced via 7E smoke; was
      // causing BranchNotFoundError on baseStreamId resolves.)
      if (policy.baseStreamId !== undefined) {
        streamId = tracker.forkStream({
          parentStreamId: policy.baseStreamId,
          name: policy.name ?? `${agentId}-${Date.now()}`,
          agentId,
        });
      } else {
        streamId = tracker.createStream({
          name: policy.name ?? `${agentId}-${Date.now()}`,
          agentId,
        });
      }
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

    // v0.7 stage 7B: remember the agent's stream + worktree so a later
    // commitChanges call can route through tracker.commitChanges without
    // requiring the worker to know its own streamId.
    this.agentStreams.set(agentId, { streamId, worktree: worktreePath });

    return { cwd: worktreePath, streamId, branch };
  }

  async commitChanges(
    agentId: AgentId,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<CommitChangesResult | null> {
    const stream = this.agentStreams.get(agentId);
    if (stream === undefined) return null;
    const tracker = await this.ensureTracker();
    const result = tracker.commitChanges({
      streamId: stream.streamId,
      agentId,
      worktree: stream.worktree,
      message,
      ...(metadata !== undefined && { metadata }),
    });
    return {
      streamId: stream.streamId,
      commitSha: result.commit,
      ...(result.changeId !== undefined && { changeId: result.changeId }),
    };
  }

  // ---- v0.7 stage 7F — integrator streams + branch merge --------------

  private readonly integratorStreams = new Map<string, string>();

  async ensureIntegratorStream(branch: string): Promise<string> {
    const cached = this.integratorStreams.get(branch);
    if (cached !== undefined) return cached;
    const tracker = await this.ensureTracker();
    const streamId = tracker.trackExistingBranch({
      branch,
      agentId: `integrator-${branch}`,
      name: `integrator-${branch}`,
    });
    this.integratorStreams.set(branch, streamId);
    return streamId;
  }

  /**
   * Merge a source stream's changes into an existing git branch via plain
   * git in a temporary worktree. Bypasses git-cascade's mergeStream (which
   * hardcodes `stream/<id>` branch names and can't handle integrator
   * streams). Returns a MergeStreamResult shaped like git-cascade's so
   * callers can treat both paths uniformly.
   */
  async mergeStreamToBranch(opts: {
    sourceAgentId: AgentId;
    targetBranch: string;
    strategy?: string;
  }): Promise<MergeStreamResult> {
    const stream = this.agentStreams.get(opts.sourceAgentId);
    if (stream === undefined) {
      return {
        success: false,
        error: `no recorded stream for agent ${opts.sourceAgentId}`,
        errorType: "invalid_state",
      };
    }
    // Use a fresh tmp worktree so we don't disturb the source's checkout.
    const cp = await import("node:child_process");
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-merge-"));
    try {
      // git worktree add --detach <tmp> <targetBranch>: detached at the
      // target's HEAD so we can merge without colliding with an already-
      // checked-out branch (typical: main is checked out in the repo cwd).
      cp.execSync(
        `git worktree add --detach ${JSON.stringify(tmpRoot)} ${JSON.stringify(opts.targetBranch)}`,
        { cwd: this.repoPath, stdio: "pipe" },
      );
      try {
        const sourceBranch = `stream/${stream.streamId}`;
        const flag = opts.strategy === "fast-forward" ? "--ff-only" : "--no-ff";
        // Capture old branch sha for the update-ref CAS so we don't clobber
        // concurrent updates.
        const oldSha = cp
          .execSync(
            `git rev-parse ${JSON.stringify(opts.targetBranch)}`,
            { cwd: this.repoPath, stdio: "pipe" },
          )
          .toString()
          .trim();
        const out = cp.execSync(
          `git merge ${flag} ${JSON.stringify(sourceBranch)} -m ${JSON.stringify(`Merge stream/${stream.streamId} into ${opts.targetBranch}`)}`,
          { cwd: tmpRoot, stdio: "pipe" },
        );
        const newHead = cp
          .execSync("git rev-parse HEAD", { cwd: tmpRoot, stdio: "pipe" })
          .toString()
          .trim();
        // Atomically update the target branch ref to the new merge commit.
        // Working trees of the target branch (e.g. the orchestrator's repo
        // cwd) won't auto-refresh — they'll see the new ref on next `git
        // pull` or `git status` but their working tree stays as-is.
        cp.execSync(
          `git update-ref refs/heads/${opts.targetBranch} ${newHead} ${oldSha}`,
          { cwd: this.repoPath, stdio: "pipe" },
        );
        void out;
        return { success: true, newHead };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isConflict = msg.includes("CONFLICT") || msg.includes("conflict");
        return {
          success: false,
          error: msg.slice(0, 500),
          errorType: isConflict ? "conflict" : "git_error",
        };
      } finally {
        // Always clean up the tmp worktree; git worktree remove --force
        // removes both the dir and git's registry entry.
        try {
          cp.execSync(
            `git worktree remove --force ${JSON.stringify(tmpRoot)}`,
            { cwd: this.repoPath, stdio: "pipe" },
          );
        } catch {
          // Best-effort; the tmp dir is in /tmp and will be cleaned by the OS.
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `failed to create tmp worktree: ${msg.slice(0, 200)}`,
        errorType: "git_error",
      };
    }
  }

  // ---- v0.7 stage 7C ---------------------------------------------------

  streamIdFor(agentId: AgentId): string | undefined {
    return this.agentStreams.get(agentId)?.streamId;
  }

  async mergeStream(opts: MergeStreamOptions): Promise<MergeStreamResult> {
    const stream = this.agentStreams.get(opts.sourceAgentId);
    if (stream === undefined) {
      return {
        success: false,
        error: `no recorded stream for agent ${opts.sourceAgentId}`,
        errorType: "invalid_state",
      };
    }
    const tracker = await this.ensureTracker();
    const result = tracker.mergeStream({
      sourceStream: stream.streamId,
      targetStream: opts.targetStream,
      agentId: opts.sourceAgentId,
      worktree: stream.worktree,
      ...(opts.strategy !== undefined && { strategy: opts.strategy }),
    });
    return {
      success: result.success,
      ...(result.newHead !== undefined && { newHead: result.newHead }),
      ...(result.conflicts !== undefined && { conflicts: result.conflicts }),
      ...(result.error !== undefined && { error: result.error }),
      ...(result.errorType !== undefined && { errorType: result.errorType }),
    };
  }

  async dispose(): Promise<void> {
    // v0.7 stage 7H: optional worktree cleanup BEFORE closing the tracker
    // (close() also tears down git-cascade state we may need). Best-effort
    // — failures are logged via console.warn but don't throw, so dispose
    // remains idempotent and exit-safe.
    if (this.cleanupOnDispose && this.agentStreams.size > 0) {
      const cp = await import("node:child_process");
      for (const { worktree } of this.agentStreams.values()) {
        try {
          cp.execSync(
            `git worktree remove --force ${JSON.stringify(worktree)}`,
            { cwd: this.repoPath, stdio: "pipe" },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[git-cascade] cleanup-on-dispose: failed to remove ${worktree}: ${msg.slice(0, 200)}`,
          );
        }
      }
      try {
        cp.execSync(`git worktree prune`, {
          cwd: this.repoPath,
          stdio: "pipe",
        });
      } catch {
        // prune is best-effort; failures don't block tracker close.
      }
    }
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
