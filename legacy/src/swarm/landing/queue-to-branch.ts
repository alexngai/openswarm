/**
 * queue-to-branch — enqueue the agent's stream for ordered merging into a
 * target branch, rather than merging it now (docs/44 P4). An integrator drains
 * the queue later (`StandaloneHost.drainMergeQueue`). "Success" here means
 * *enqueued*, not merged. Branch-targeted only (the queue lands to a branch).
 */

import type { LandingContext, LandingStrategy, MergeStreamResult } from "./types.js";

export class QueueToBranchStrategy implements LandingStrategy {
  readonly name = "queue-to-branch";

  async land(ctx: LandingContext): Promise<MergeStreamResult | null> {
    // The queue lands to a real branch; a stream target isn't a queue.
    if (ctx.targetBranch === undefined) return null;
    if (ctx.host.enqueueMerge === undefined) return null;
    const entryId = await ctx.host.enqueueMerge({
      streamId: ctx.streamId,
      targetBranch: ctx.targetBranch,
      agentId: ctx.agentId,
    });
    // null → adapter has no queue (caller treats as "skipped, unsupported").
    return entryId === null ? null : { success: true };
  }
}
