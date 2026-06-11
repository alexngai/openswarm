/**
 * abandon — discard the conflicted stream's landing. The work stays on its
 * own branch (unmerged); the team continues. Bulk worktree cleanup is handled
 * by the adapter's `cleanupOnDispose`; per-stream removal is deferred (docs/44).
 */

import type { ConflictRecoveryStrategy } from "./types.js";

export const abandonStrategy: ConflictRecoveryStrategy = {
  name: "abandon",
  mode: "sync",
  async recover(ctx) {
    return {
      kind: "abandoned",
      streamId: ctx.streamId,
      reason: `conflict on ${ctx.paths.join(", ") || "<unknown>"}`,
    };
  },
};
