/**
 * defer — no-op recovery. Leaves the conflict in place for later or external
 * resolution. The safe default when a team configures no recovery.
 */

import type { ConflictRecoveryStrategy } from "./types.js";

export const deferStrategy: ConflictRecoveryStrategy = {
  name: "defer",
  mode: "sync",
  async recover() {
    return { kind: "deferred", reason: "no automated recovery configured" };
  },
};
