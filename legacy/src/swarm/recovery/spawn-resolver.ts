/**
 * spawn-resolver — recover a conflict by spawning an LLM resolver agent
 * (docs/44 P2). The autonomous-team path: no human required.
 *
 * The actual spawn → await `resolve_conflict` → retry-merge is injected via
 * `ctx.spawnResolver` (provided per-run by the topology, since it needs the
 * live team). This strategy owns only the policy around it:
 *   - recoveryDepth >= maxRecoveryDepth → escalate (no runaway resolvers)
 *   - no spawner injected               → escalate (nothing to spawn into)
 *   - otherwise                         → delegate to ctx.spawnResolver
 *
 * Keeping the spawn mechanism injected makes the strategy unit-testable with a
 * fake spawner and keeps the live wiring (P2b) in one place.
 */

import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from "./types.js";

/** Default bound on resolver recursion when not set via strategyConfig. */
export const DEFAULT_MAX_RECOVERY_DEPTH = 3;

export const spawnResolverStrategy: ConflictRecoveryStrategy = {
  name: "spawn-resolver",
  mode: "async",
  async recover(ctx: ConflictContext): Promise<ConflictResolution> {
    const configuredDepth = ctx.strategyConfig?.maxRecoveryDepth;
    const maxDepth =
      typeof configuredDepth === "number" && configuredDepth > 0
        ? configuredDepth
        : DEFAULT_MAX_RECOVERY_DEPTH;

    if (ctx.recoveryDepth >= maxDepth) {
      // Bounded recursion exhausted — hand off to a human.
      return { kind: "escalated", escalatedTo: "human" };
    }
    if (ctx.spawnResolver === undefined) {
      // No live team to spawn into (e.g. headless context) — escalate.
      return { kind: "escalated", escalatedTo: "human" };
    }
    return ctx.spawnResolver(ctx);
  },
};
