/**
 * recovery/ — pluggable ConflictRecoveryStrategy seam (docs/44 P0/P1).
 *
 * P1 ships the sync built-ins (defer / abandon / escalate) and the dispatch
 * wiring in PeerTeamTopology. `spawn-resolver` (the autonomous LLM resolver)
 * and `resolve_conflict` land in P2.
 */

import { RecoveryRegistry } from "./registry.js";
import { deferStrategy } from "./defer.js";
import { abandonStrategy } from "./abandon.js";
import { escalateStrategy } from "./escalate.js";
import type { ConflictResolution } from "./types.js";

export * from "./types.js";
export { RecoveryRegistry, DEFAULT_RECOVERY_STRATEGY } from "./registry.js";
export { deferStrategy } from "./defer.js";
export { abandonStrategy } from "./abandon.js";
export { escalateStrategy } from "./escalate.js";

/**
 * Register the built-in recovery strategies on a registry. P1: defer (default),
 * abandon, escalate. `auto-resolve` is intentionally NOT built (docs/44 D2 —
 * blind side-picking is harmful); `spawn-resolver` lands in P2.
 */
export function registerBuiltinRecoveryStrategies(registry: RecoveryRegistry): void {
  registry.register(deferStrategy);
  registry.register(abandonStrategy);
  registry.register(escalateStrategy);
}

/** Construct a registry pre-loaded with the built-in strategies. */
export function createDefaultRecoveryRegistry(): RecoveryRegistry {
  const registry = new RecoveryRegistry();
  registerBuiltinRecoveryStrategies(registry);
  return registry;
}

/** Short human-readable description of a resolution, for lane-event notes. */
export function describeResolution(r: ConflictResolution): string {
  switch (r.kind) {
    case "resolved":
      return r.resolutionCommit ? `resolved (${r.resolutionCommit})` : "resolved";
    case "deferred":
      return `deferred (${r.reason})`;
    case "abandoned":
      return `abandoned ${r.streamId} (${r.reason})`;
    case "escalated":
      return `escalated to ${r.escalatedTo}`;
    case "failed":
      return `failed: ${r.error}`;
  }
}
