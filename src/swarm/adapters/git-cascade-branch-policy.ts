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
import { execFileSync } from "node:child_process";
import type { AgentId } from "../../core/types.js";
import type { BranchPolicy } from "../host.js";

/**
 * Run a git command WITHOUT a shell (argv form). Branch names, refs, paths, and
 * shas are passed as discrete argv entries, so no value can inject shell
 * metacharacters or break on spaces — unlike string-interpolated `execSync`.
 * Returns stdout as a string. docs/44 Track-A hardening (CRITICAL: injection).
 */
function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args as string[], {
    cwd,
    stdio: "pipe",
  }).toString();
}

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
    /**
     * docs/44 P2b — when true, a merge conflict does NOT clean up the tmp
     * worktree; instead the result carries `conflictWorktree` + `targetOldSha`
     * so a resolver agent can fix the conflict in place. Finalize via
     * `finalizeConflictResolution`.
     */
    retainOnConflict?: boolean;
  }): Promise<MergeStreamResult>;

  /**
   * docs/44 P2b — finalize a resolver-fixed conflict: CAS `update-ref` the
   * target branch to the resolution commit, then remove the retained worktree.
   * Optional; caller feature-detects.
   */
  finalizeConflictResolution?(
    opts: FinalizeConflictOptions,
  ): Promise<MergeStreamResult>;

  /**
   * docs/44 P2b — discard a retained conflict worktree without landing it
   * (resolver timeout/abandon). Best-effort, idempotent. Optional; caller
   * feature-detects.
   */
  discardConflictWorktree?(worktree: string): Promise<void>;

  /**
   * docs/44 P4 — enqueue a stream to be merged into a target branch (the
   * `queue-to-branch` landing). Returns the queue entry id, or null when the
   * adapter/tracker has no merge queue. Optional; caller feature-detects.
   */
  enqueueMerge?(opts: {
    streamId: string;
    targetBranch: string;
    priority?: number;
    agentId?: string;
  }): Promise<string | null>;

  /**
   * docs/44 P4 — drain the merge queue for a target branch in priority/FIFO
   * order, merging each ready stream via `mergeStreamIdIntoBranch`. Returns the
   * per-entry outcome, or null when there is no queue. Optional.
   */
  drainMergeQueue?(opts: {
    targetBranch: string;
    limit?: number;
    strategy?: string;
  }): Promise<MergeQueueDrainResult | null>;

  /**
   * v0.7 stage 7K: propagate commits from a root stream to all dependent
   * streams (forked off it). Wraps `tracker.cascadeRebase`. The adapter
   * supplies a callback worktree provider that maps each stream to its
   * recorded worktree, falling back to a fresh tmp worktree for streams
   * the adapter didn't create (e.g. integrators). Optional; caller
   * feature-detects.
   */
  cascadeRebase?(opts: CascadeRebaseOptions): Promise<CascadeRebaseResult>;
}

/** v0.7 stage 7K — adapter-facing options for cascade rebase. */
export interface CascadeRebaseOptions {
  /** The root stream that just received new commits. */
  readonly rootStream: string;
  /** Agent attribution for the cascade run; defaults to "cascade-driver". */
  readonly agentId?: string;
  /** Conflict strategy. Default: "stop_on_conflict". */
  readonly strategy?: "stop_on_conflict" | "skip_conflicting" | "defer_conflicts";
}

export interface CascadeRebaseResult {
  readonly success: boolean;
  readonly rebased?: ReadonlyArray<{ streamId: string; newHead?: string }>;
  readonly conflicts?: ReadonlyArray<{ streamId: string; reason?: string }>;
  readonly error?: string;
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
  /**
   * docs/44 P2b — set on a conflict when `retainOnConflict` was requested: the
   * path to the retained tmp worktree holding the in-progress (conflicted)
   * merge, for a resolver agent to fix in place. The caller MUST eventually
   * call `finalizeConflictResolution` (which removes it) or clean it up.
   */
  readonly conflictWorktree?: string;
  /**
   * docs/44 P2b — the target branch's pre-merge sha, for the compare-and-swap
   * `update-ref` when finalizing a resolved conflict.
   */
  readonly targetOldSha?: string;
}

/** docs/44 P2b — options for finalizing a resolver-fixed conflict. */
export interface FinalizeConflictOptions {
  /** The retained conflict worktree (from MergeStreamResult.conflictWorktree). */
  readonly worktree: string;
  readonly targetBranch: string;
  /** The pre-merge sha (from MergeStreamResult.targetOldSha) for the CAS. */
  readonly oldSha: string;
  /**
   * The resolver's commit completing the merge. Omit to auto-read the
   * worktree's HEAD (a scripted/real resolver commits there but can't report
   * the dynamic sha back through the signal).
   */
  readonly resolutionCommit?: string;
}

/** docs/44 P4 — outcome of draining the merge queue for a target branch. */
export interface MergeQueueDrainResult {
  readonly merged: ReadonlyArray<{
    entryId: string;
    streamId: string;
    mergeCommit?: string;
  }>;
  readonly failed: ReadonlyArray<{
    entryId: string;
    streamId: string;
    error: string;
  }>;
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
  // v0.7 stage 7K — cascade rebase: propagate commits from a root stream
  // to all dependent (forked) streams. Must accept an inline worktree
  // provider so the adapter can map streamId → worktree path on the fly.
  cascadeRebase(opts: {
    rootStream: string;
    agentId: string;
    worktree: {
      mode: "callback" | "sequential" | "temporary";
      provider?: (streamId: string) => string;
      worktreePath?: string;
      tempDir?: string;
    };
    strategy?: string;
  }): {
    success: boolean;
    rebased?: ReadonlyArray<{ streamId: string; newHead?: string }>;
    conflicts?: ReadonlyArray<{ streamId: string; reason?: string }>;
    error?: string;
    [key: string]: unknown;
  };
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
  // docs/44 P4 — git-cascade merge queue. Used for ordering + persistence; the
  // actual merge runs through mergeStreamIdIntoBranch (handles real branches),
  // not processMergeQueue. Optional so non-queue mock trackers don't need them.
  addToMergeQueue?(opts: {
    streamId: string;
    targetBranch?: string;
    priority?: number;
    agentId: string;
    metadata?: Record<string, unknown>;
  }): string;
  markMergeQueueReady?(entryId: string): void;
  getNextToMerge?(targetBranch?: string):
    | { id: string; streamId: string; targetBranch: string; [k: string]: unknown }
    | null;
  removeFromMergeQueue?(entryId: string): void;
  cancelMergeQueueEntry?(entryId: string): void;
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

  // ---- v0.7 stage 7K — cascade rebase --------------------------------

  async cascadeRebase(opts: CascadeRebaseOptions): Promise<CascadeRebaseResult> {
    const tracker = await this.ensureTracker();
    // Build a streamId → worktree map from agent worktrees so the callback
    // provider can answer for any recorded stream. Falls back to a fresh
    // tmp worktree for unknown streams (e.g. forks created by other
    // adapters or by direct tracker calls).
    const streamWorktrees = new Map<string, string>();
    for (const { streamId, worktree } of this.agentStreams.values()) {
      streamWorktrees.set(streamId, worktree);
    }
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const tmpWorktrees: string[] = [];
    const provider = (streamId: string): string => {
      const recorded = streamWorktrees.get(streamId);
      if (recorded !== undefined) return recorded;
      const branch = `stream/${streamId}`;
      const tmpDir = path.join(
        os.tmpdir(),
        `swh-cascade-${streamId}-${Date.now()}`,
      );
      // Record the path BEFORE creating the worktree so cleanup still attempts
      // removal on a partial `worktree add` failure (Track-A hardening).
      tmpWorktrees.push(tmpDir);
      runGit(["worktree", "add", "--detach", tmpDir, branch], this.repoPath);
      return tmpDir;
    };
    try {
      const result = tracker.cascadeRebase({
        rootStream: opts.rootStream,
        agentId: opts.agentId ?? "cascade-driver",
        worktree: { mode: "callback", provider },
        ...(opts.strategy !== undefined && { strategy: opts.strategy }),
      });
      return {
        success: result.success,
        ...(result.rebased !== undefined && { rebased: result.rebased }),
        ...(result.conflicts !== undefined && { conflicts: result.conflicts }),
        ...(result.error !== undefined && { error: result.error }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg.slice(0, 500) };
    } finally {
      // Clean up any tmp worktrees we allocated.
      for (const tmp of tmpWorktrees) {
        try {
          runGit(["worktree", "remove", "--force", tmp], this.repoPath);
        } catch {
          // Best-effort; tmp dirs in /tmp will be cleaned by the OS.
        }
        try {
          await fsp.rm(tmp, { recursive: true, force: true });
        } catch {
          // Same.
        }
      }
    }
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
    retainOnConflict?: boolean;
  }): Promise<MergeStreamResult> {
    const stream = this.agentStreams.get(opts.sourceAgentId);
    if (stream === undefined) {
      return {
        success: false,
        error: `no recorded stream for agent ${opts.sourceAgentId}`,
        errorType: "invalid_state",
      };
    }
    const result = await this.mergeStreamIdIntoBranch(
      stream.streamId,
      opts.targetBranch,
      {
        ...(opts.strategy !== undefined && { strategy: opts.strategy }),
        ...(opts.retainOnConflict !== undefined && {
          retainOnConflict: opts.retainOnConflict,
        }),
      },
    );
    // review MEDIUM: once the stream has landed, eagerly tear down the agent's
    // worktree and prune the mapping so `agentStreams` doesn't grow unbounded on
    // a long-lived host. Only on a clean success — a retained conflict
    // (success:false) is still in flight and gets finalized later.
    if (result.success) this.disposeAgentStream(opts.sourceAgentId);
    return result;
  }

  /**
   * review MEDIUM: remove an agent's stream worktree (if it still exists) and
   * drop the `agentStreams` entry. Called when a stream has landed so the map
   * stays bounded and the worktree is cleaned eagerly rather than deferred to
   * dispose(). Safe because merges run after the member has completed. Best-
   * effort: worktree-removal failures are swallowed (dispose's existsSync guard
   * already tolerates a missing worktree).
   */
  private disposeAgentStream(agentId: AgentId): void {
    const stream = this.agentStreams.get(agentId);
    if (stream === undefined) return;
    if (fs.existsSync(stream.worktree)) {
      try {
        runGit(
          ["worktree", "remove", "--force", stream.worktree],
          this.repoPath,
        );
      } catch {
        // Best-effort; a leftover worktree is cleaned by dispose() / the OS.
      }
    }
    this.agentStreams.delete(agentId);
  }

  /**
   * docs/44 P4 — merge a stream (by id) into an existing git branch via plain
   * git in a throwaway worktree. The streamId-keyed core shared by
   * `mergeStreamToBranch` (agent-keyed) and the merge-queue drain (streamId-
   * keyed, since the enqueuing agent may be gone by drain time).
   */
  async mergeStreamIdIntoBranch(
    streamId: string,
    targetBranch: string,
    opts: { strategy?: string; retainOnConflict?: boolean } = {},
  ): Promise<MergeStreamResult> {
    // docs/44 P4 (review MEDIUM): verify the source branch exists BEFORE doing
    // any work. The whole streamId-keying rationale is "the enqueuing agent may
    // be gone by drain time", so a missing `stream/<id>` is a likely state, not
    // an exotic one. Surface it as a distinct `missing_source` so the drain can
    // skip/handle it deliberately instead of lumping it into `git_error`.
    try {
      runGit(
        ["rev-parse", "--verify", "--quiet", `refs/heads/stream/${streamId}`],
        this.repoPath,
      );
    } catch {
      return {
        success: false,
        error: `source branch stream/${streamId} does not exist`,
        errorType: "missing_source",
      };
    }
    // Use a fresh tmp worktree so we don't disturb any active checkout.
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "swh-merge-"));
    // docs/44 P2b — when set, the finally leaves the conflicted worktree in
    // place for a resolver to fix (caller finalizes via
    // finalizeConflictResolution, which removes it).
    let retainWorktree = false;
    try {
      // worktree add --detach <tmp> <targetBranch>: detached at the target's
      // HEAD so we can merge without colliding with an already-checked-out
      // branch (typical: main is checked out in the repo cwd).
      runGit(
        ["worktree", "add", "--detach", tmpRoot, targetBranch],
        this.repoPath,
      );
      try {
        let oldSha = "";
        let newHead = "";
        try {
          const sourceBranch = `stream/${streamId}`;
          // NOTE (review MEDIUM): `--ff-only` is incompatible with
          // retainOnConflict — it fails when a fast-forward isn't possible but
          // NEVER leaves unmerged paths, so a diverged history is classified
          // `git_error`, not `conflict`, and no worktree is retained. Callers
          // wanting resolver-driven recovery must not pass strategy
          // "fast-forward".
          const flag =
            opts.strategy === "fast-forward" ? "--ff-only" : "--no-ff";
          // Capture old branch sha for the update-ref CAS so we don't clobber
          // concurrent updates.
          oldSha = runGit(["rev-parse", targetBranch], this.repoPath).trim();
          runGit(
            [
              "merge",
              flag,
              sourceBranch,
              "-m",
              `Merge stream/${streamId} into ${targetBranch}`,
            ],
            tmpRoot,
          );
          newHead = runGit(["rev-parse", "HEAD"], tmpRoot).trim();
        } catch (mergeErr) {
          const msg =
            mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          // Authoritative conflict detection: a failed merge leaves unmerged
          // entries. (git writes "CONFLICT ..." to stdout, not to err.message,
          // so string-matching the thrown error is unreliable.)
          let conflicts: string[] = [];
          try {
            conflicts = runGit(
              ["diff", "--name-only", "--diff-filter=U"],
              tmpRoot,
            )
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          } catch {
            // Best-effort; leave conflicts empty if the query fails.
          }
          if (conflicts.length > 0) {
            if (opts.retainOnConflict === true) {
              retainWorktree = true;
              return {
                success: false,
                errorType: "conflict",
                error: msg.slice(0, 500),
                conflicts,
                conflictWorktree: tmpRoot,
                targetOldSha: oldSha,
              };
            }
            return {
              success: false,
              error: msg.slice(0, 500),
              errorType: "conflict",
              conflicts,
            };
          }
          return {
            success: false,
            error: msg.slice(0, 500),
            errorType: "git_error",
          };
        }
        // Merge succeeded — CAS the ref SEPARATELY so a concurrent target
        // advance is classified `stale` (retryable) rather than a merge
        // conflict or generic git error (Track-A hardening HIGH #5).
        try {
          runGit(
            ["update-ref", `refs/heads/${targetBranch}`, newHead, oldSha],
            this.repoPath,
          );
        } catch (casErr) {
          const msg =
            casErr instanceof Error ? casErr.message : String(casErr);
          return { success: false, error: msg.slice(0, 500), errorType: "stale" };
        }
        return { success: true, newHead };
      } finally {
        // Clean up the tmp worktree unless a resolver needs it retained.
        if (!retainWorktree) {
          try {
            runGit(["worktree", "remove", "--force", tmpRoot], this.repoPath);
          } catch {
            // Best-effort; the tmp dir is in /tmp and will be cleaned by the OS.
          }
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

  // ---- docs/44 P4 — merge queue --------------------------------------

  /**
   * Enqueue a stream for the merge queue. `targetBranch` is REQUIRED here on
   * purpose: the underlying git-cascade queue defaults both `addToQueue` and
   * `getNextToMerge` to the literal `"main"`, so if a caller ever omitted it,
   * enqueue and drain could silently target different branches and the drain
   * would find nothing. Keep it required and explicit (review LOW).
   */
  async enqueueMerge(opts: {
    streamId: string;
    targetBranch: string;
    priority?: number;
    agentId?: string;
  }): Promise<string | null> {
    const tracker = await this.ensureTracker();
    if (
      tracker.addToMergeQueue === undefined ||
      tracker.markMergeQueueReady === undefined
    ) {
      return null;
    }
    const entryId = tracker.addToMergeQueue({
      streamId: opts.streamId,
      targetBranch: opts.targetBranch,
      ...(opts.priority !== undefined && { priority: opts.priority }),
      agentId: opts.agentId ?? "queue",
    });
    // No review gate in v1 — entries are immediately drainable.
    tracker.markMergeQueueReady(entryId);
    return entryId;
  }

  async drainMergeQueue(opts: {
    targetBranch: string;
    limit?: number;
    strategy?: string;
  }): Promise<MergeQueueDrainResult | null> {
    const tracker = await this.ensureTracker();
    if (
      tracker.getNextToMerge === undefined ||
      tracker.removeFromMergeQueue === undefined ||
      tracker.cancelMergeQueueEntry === undefined
    ) {
      return null;
    }
    const merged: Array<{
      entryId: string;
      streamId: string;
      mergeCommit?: string;
    }> = [];
    const failed: Array<{ entryId: string; streamId: string; error: string }> =
      [];
    const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;
    for (let n = 0; n < limit; n++) {
      const entry = tracker.getNextToMerge(opts.targetBranch);
      if (entry === null || entry === undefined) break;
      const r = await this.mergeStreamIdIntoBranch(
        entry.streamId,
        opts.targetBranch,
        { ...(opts.strategy !== undefined && { strategy: opts.strategy }) },
      );
      if (r.success) {
        tracker.removeFromMergeQueue(entry.id);
        merged.push({
          entryId: entry.id,
          streamId: entry.streamId,
          ...(r.newHead !== undefined && { mergeCommit: r.newHead }),
        });
      } else if (r.errorType === "stale") {
        // A concurrent writer advanced the target — this is retryable, NOT a
        // terminal failure. Leave the entry 'ready' (don't cancel/lose it) and
        // stop the drain; a later drain retries it against the new HEAD
        // (Track-A hardening HIGH #6).
        break;
      } else {
        // Terminal failure (conflict / git error) — cancel so the drain
        // advances; surface it in failed[]. (Routing failed[] into the
        // recovery dispatcher is the deferred model-B step.)
        tracker.cancelMergeQueueEntry(entry.id);
        failed.push({
          entryId: entry.id,
          streamId: entry.streamId,
          error:
            r.errorType === "conflict"
              ? `conflict on ${r.conflicts?.join(", ") ?? "<unknown>"}`
              : (r.error ?? "merge failed"),
        });
      }
    }
    return { merged, failed };
  }

  /**
   * docs/44 P2b — finalize a resolver-fixed conflict. CAS-updates the target
   * branch to the resolution commit (the resolver's merge-completing commit in
   * the retained worktree), then removes the worktree. Returns `errorType:
   * "stale"` when the target advanced concurrently (CAS mismatch).
   */
  async finalizeConflictResolution(
    opts: FinalizeConflictOptions,
  ): Promise<MergeStreamResult> {
    const worktree = opts.worktree;
    // Auto-read the worktree HEAD when the caller didn't report a commit.
    let resolutionCommit: string;
    try {
      resolutionCommit =
        opts.resolutionCommit ?? runGit(["rev-parse", "HEAD"], worktree).trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `cannot read resolution commit: ${msg.slice(0, 200)}`,
        errorType: "git_error",
      };
    }
    // Re-verify the resolver actually produced a conflict-free tree before
    // landing it — a buggy/lying resolver must not drive an unmerged tree onto
    // the target (Track-A hardening: finalize-without-reverify trust gap).
    try {
      const unmerged = runGit(["diff", "--name-only", "--diff-filter=U"], worktree)
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (unmerged.length > 0) {
        return {
          success: false,
          error: `worktree still has unmerged paths: ${unmerged.join(", ")}`,
          errorType: "unresolved",
        };
      }
    } catch {
      // Best-effort; if the check itself fails, fall through to the CAS.
    }
    // An empty/short oldSha would make `update-ref` CREATE the ref with no CAS,
    // silently clobbering a concurrently-advanced target — reject it.
    if (!opts.oldSha || opts.oldSha.length < 7) {
      return {
        success: false,
        error: "missing pre-merge sha for compare-and-swap",
        errorType: "invalid_state",
      };
    }
    try {
      runGit(
        ["update-ref", `refs/heads/${opts.targetBranch}`, resolutionCommit, opts.oldSha],
        this.repoPath,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // CAS failed (target advanced). Do NOT remove the worktree — the
      // resolver's commit is only reachable there; retain it so the caller can
      // retry the CAS against the new HEAD (Track-A hardening HIGH #4).
      return { success: false, error: msg.slice(0, 500), errorType: "stale" };
    }
    // Success only — now it's safe to remove the worktree.
    try {
      runGit(["worktree", "remove", "--force", worktree], this.repoPath);
    } catch {
      // Best-effort.
    }
    return { success: true, newHead: resolutionCommit };
  }

  /**
   * docs/44 P2b — discard a retained conflict worktree WITHOUT landing it.
   * Used when a resolver times out / is abandoned: the in-progress merge is
   * thrown away so the git worktree registration doesn't leak (Track-A
   * hardening HIGH #4). Best-effort + idempotent: a missing/already-removed
   * worktree is a no-op.
   */
  async discardConflictWorktree(worktree: string): Promise<void> {
    if (!fs.existsSync(worktree)) return;
    try {
      runGit(["worktree", "remove", "--force", worktree], this.repoPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[git-cascade] discardConflictWorktree: failed to remove ${worktree}: ${msg.slice(0, 200)}`,
      );
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
    // review MEDIUM: prune the landed source stream (bounds agentStreams).
    if (result.success) this.disposeAgentStream(opts.sourceAgentId);
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
      for (const { worktree } of this.agentStreams.values()) {
        // Skip worktrees already removed by a merge/finalize/cascade path —
        // avoids noisy false-alarm warnings on every dispose (Track-A hardening).
        if (!fs.existsSync(worktree)) continue;
        try {
          runGit(["worktree", "remove", "--force", worktree], this.repoPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[git-cascade] cleanup-on-dispose: failed to remove ${worktree}: ${msg.slice(0, 200)}`,
          );
        }
      }
      try {
        runGit(["worktree", "prune"], this.repoPath);
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

    // If init fails (transient FS error, missing dep), clear the cached promise
    // so a later call can retry rather than forever returning the rejected one
    // (Track-A hardening: rejected-promise poison).
    this.trackerPromise.catch(() => {
      this.trackerPromise = undefined;
    });

    return this.trackerPromise;
  }
}
