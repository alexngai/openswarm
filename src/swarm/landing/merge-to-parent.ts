/**
 * merge-to-parent — the default landing strategy.
 *
 * Merges an agent's stream into the configured target: a real git branch via
 * the adapter's plain-git path (`mergeStreamToBranchForAgent`), or another
 * stream via git-cascade (`mergeStreamForAgent`).
 *
 * The per-agent merge logic is lifted verbatim from the inline loop in
 * PeerTeamTopology.maybeMergeStreams (v0.7 stage 7C/7F) so it can be selected
 * per-role and composed with conflict recovery (docs/44 P0/P1). Behavior is
 * unchanged: same adapter calls, same null semantics.
 */

import type { LandingContext, LandingStrategy, MergeStreamResult } from "./types.js";

export class MergeToParentStrategy implements LandingStrategy {
  readonly name = "merge-to-parent";

  async land(ctx: LandingContext): Promise<MergeStreamResult | null> {
    // Branch path (e.g. merge into `main`) routes around git-cascade's
    // synthetic stream/<id> branch-naming via the adapter's plain-git merge.
    if (ctx.targetBranch !== undefined) {
      return ctx.host.mergeStreamToBranchForAgent(ctx.agentId, {
        targetBranch: ctx.targetBranch,
        ...(ctx.strategy !== undefined && { strategy: ctx.strategy }),
      });
    }
    // Stream path: merge into another git-cascade stream.
    if (ctx.targetStream !== undefined) {
      return ctx.host.mergeStreamForAgent(ctx.agentId, {
        targetStream: ctx.targetStream,
        ...(ctx.strategy !== undefined && { strategy: ctx.strategy }),
      });
    }
    // Neither target set — nothing to land (caller skips before reaching here).
    return null;
  }
}
