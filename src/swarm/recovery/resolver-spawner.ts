/**
 * resolver-spawner.ts — the spawn-resolver coordinator (docs/44 P2b).
 *
 * Builds the `ConflictContext.spawnResolver` closure the topology injects per
 * run. The flow:
 *   1. re-merge the source stream into the target with `retainOnConflict` to
 *      materialize a worktree holding the in-progress conflicted merge;
 *   2. spawn a `resolver` agent on that worktree;
 *   3. await the resolver's `resolve_conflict` signal (or time out);
 *   4. finalize (CAS update-ref + worktree removal) → resolved.
 *
 * Dependencies are injected so the coordinator is unit-testable with fakes; the
 * full subprocess + real-git path is exercised by the Loop 1 integration test
 * (docs/44 P2b.4).
 */

import type { MergeStreamResult } from "../adapters/git-cascade-branch-policy.js";
import type {
  ConflictContext,
  ConflictResolution,
  ResolverSpawner,
} from "./types.js";

/** Minimal spawned-handle shape the coordinator needs. */
export interface ResolverHandle {
  readonly agentId: string;
  kill(): Promise<void>;
}

export interface ResolverSpawnerDeps {
  /** Spawn the resolver member (TeamSession.spawnMember-like). */
  spawnResolver(spec: {
    role: string;
    prompt: string;
    branchPolicy: { kind: "none" };
    cwd: string;
  }): Promise<ResolverHandle>;
  /** Re-run the branch merge with retain to materialize the conflict worktree. */
  mergeWithRetain(
    sourceAgentId: string,
    targetBranch: string,
  ): Promise<MergeStreamResult | null>;
  /** Await the resolver's `resolve_conflict`, or null on timeout. */
  waitForResolution(
    conflictId: string,
    timeoutMs: number,
  ): Promise<{ resolutionCommit?: string } | null>;
  /** Finalize: CAS update-ref to the resolution commit + remove the worktree. */
  finalize(opts: {
    worktree: string;
    targetBranch: string;
    oldSha: string;
    resolutionCommit?: string;
  }): Promise<MergeStreamResult | null>;
  /**
   * Discard a retained conflict worktree without landing it — called when the
   * resolver times out so the git worktree registration doesn't leak. Optional;
   * when absent, the worktree is left in place (legacy behavior).
   */
  cleanupWorktree?(worktree: string): Promise<void>;
  /** How long to wait for the resolver before escalating. */
  timeoutMs: number;
}

/** The instruction handed to the resolver agent. */
export function resolverPrompt(
  conflictId: string,
  targetBranch: string,
  paths: readonly string[],
): string {
  const files = paths.length > 0 ? paths.join(", ") : "the conflicting files";
  return [
    `A git merge into "${targetBranch}" produced conflicts. Your working`,
    `directory holds the in-progress merge with conflict markers in: ${files}.`,
    "Resolve every conflict marker so the result is correct — preserve the",
    "intent of BOTH sides; never blindly discard one side. Then stage and",
    "commit the resolution using bash: `git add -A && git commit --no-edit`.",
    `Finally, call the resolve_conflict tool with conflictId="${conflictId}".`,
    "Do not start any unrelated work.",
  ].join(" ");
}

export function buildResolverSpawner(
  deps: ResolverSpawnerDeps,
): ResolverSpawner {
  return async (ctx: ConflictContext): Promise<ConflictResolution> => {
    const targetBranch = ctx.targetBranch;
    if (targetBranch === undefined) {
      // spawn-resolver currently supports only the branch-landing path.
      return { kind: "failed", error: "spawn-resolver requires a targetBranch" };
    }

    const merge = await deps.mergeWithRetain(ctx.sourceAgentId, targetBranch);
    if (merge === null) {
      return { kind: "failed", error: "branch merge not supported by adapter" };
    }
    if (merge.success) {
      // Race: the conflict is gone (target moved) — nothing to resolve.
      return merge.newHead !== undefined
        ? { kind: "resolved", resolutionCommit: merge.newHead }
        : { kind: "resolved" };
    }
    if (
      merge.errorType !== "conflict" ||
      merge.conflictWorktree === undefined ||
      merge.targetOldSha === undefined
    ) {
      return {
        kind: "failed",
        error: merge.error ?? "re-merge did not produce a usable conflict",
      };
    }

    const handle = await deps.spawnResolver({
      role: "resolver",
      prompt: resolverPrompt(ctx.conflictId, targetBranch, merge.conflicts ?? []),
      branchPolicy: { kind: "none" },
      cwd: merge.conflictWorktree,
    });

    try {
      const resolution = await deps.waitForResolution(
        ctx.conflictId,
        deps.timeoutMs,
      );
      if (resolution === null) {
        // Timed out — discard the retained conflict worktree (so the git
        // worktree registration doesn't leak) and escalate. The resolver is
        // reaped in the finally below.
        if (deps.cleanupWorktree !== undefined) {
          await deps.cleanupWorktree(merge.conflictWorktree).catch(() => {});
        }
        return { kind: "escalated", escalatedTo: "human" };
      }

      const fin = await deps.finalize({
        worktree: merge.conflictWorktree,
        targetBranch,
        oldSha: merge.targetOldSha,
        ...(resolution.resolutionCommit !== undefined && {
          resolutionCommit: resolution.resolutionCommit,
        }),
      });
      if (fin === null || !fin.success) {
        return { kind: "failed", error: fin?.error ?? "finalize failed" };
      }
      return fin.newHead !== undefined
        ? { kind: "resolved", resolutionCommit: fin.newHead }
        : { kind: "resolved" };
    } finally {
      // Reap the resolver on EVERY post-spawn path (success/failure/timeout),
      // not just timeout (review MEDIUM). The resolver sends resolve_conflict
      // BEFORE its process exits, so without this it lingers until team
      // teardown — and never, for a persistent/daemon team, leaking one
      // subprocess per resolved conflict. kill() is best-effort + idempotent.
      await handle.kill().catch(() => {});
    }
  };
}
