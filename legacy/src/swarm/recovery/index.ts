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
import { spawnResolverStrategy } from "./spawn-resolver.js";
import type { ConflictResolution } from "./types.js";

export * from "./types.js";
export { RecoveryRegistry, DEFAULT_RECOVERY_STRATEGY } from "./registry.js";
export { deferStrategy } from "./defer.js";
export { abandonStrategy } from "./abandon.js";
export { escalateStrategy } from "./escalate.js";
export { spawnResolverStrategy, DEFAULT_MAX_RECOVERY_DEPTH } from "./spawn-resolver.js";

/**
 * Register the built-in recovery strategies on a registry: defer (default),
 * abandon, escalate, spawn-resolver. `auto-resolve` is intentionally NOT built
 * (docs/44 D2 — blind side-picking is harmful).
 *
 * `spawn-resolver` is registered but inert until the topology injects a
 * `ConflictContext.spawnResolver` (P2b); without one it escalates.
 */
export function registerBuiltinRecoveryStrategies(registry: RecoveryRegistry): void {
  registry.register(deferStrategy);
  registry.register(abandonStrategy);
  registry.register(escalateStrategy);
  registry.register(spawnResolverStrategy);
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
      // review MEDIUM: "abandon" is a landing decision, not a cleanup — the
      // stream's branch/worktree stay on disk, unmerged (per-stream removal is
      // deferred, docs/44 P8). Say so explicitly so an operator reading the log
      // doesn't mistake "abandoned" for "discarded/cleaned up".
      return `abandoned ${r.streamId} — work left unmerged on its branch (${r.reason})`;
    case "escalated":
      return `escalated to ${r.escalatedTo}`;
    case "failed":
      return `failed: ${r.error}`;
  }
}
