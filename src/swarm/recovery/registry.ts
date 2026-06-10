/**
 * recovery/registry.ts — registry + selection for ConflictRecoveryStrategy.
 *
 * Built in P0 (dormant); the built-in strategies (defer/escalate/abandon/
 * spawn-resolver) register and the dispatch wiring lands in docs/44 P1.
 *
 * Selection order (conflict-recovery.md §7):
 *   member.onConflict > coordination.conflictRecovery.defaultStrategy > "defer".
 */

import type { TeamSpec } from "../team-spec.js";
import type {
  ConflictContext,
  ConflictRecoveryStrategy,
  ConflictResolution,
} from "./types.js";

/** Fallback strategy name when neither role nor team config selects one. */
export const DEFAULT_RECOVERY_STRATEGY = "defer";

export class RecoveryRegistry {
  private readonly strategies = new Map<string, ConflictRecoveryStrategy>();

  register(strategy: ConflictRecoveryStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  get(name: string): ConflictRecoveryStrategy | undefined {
    return this.strategies.get(name);
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  list(): readonly string[] {
    return [...this.strategies.keys()];
  }

  /**
   * Resolve the strategy name for a member role from spec config. The
   * per-member override (matched by role) wins, then the team default, then
   * the safe `defer` fallback.
   *
   * NOTE (review LOW): role→member is a first-match lookup. If two members
   * share a role but declare different `onConflict`, the first in spec order
   * wins for both. Roles are expected to be unique per team; if duplicate-role
   * members ever need distinct recovery, this needs a member-id key instead.
   */
  select(role: string | undefined, spec: TeamSpec): string {
    const member =
      role !== undefined
        ? spec.members.find((m) => m.role === role)
        : undefined;
    return (
      member?.onConflict ??
      spec.coordination.conflictRecovery?.defaultStrategy ??
      DEFAULT_RECOVERY_STRATEGY
    );
  }

  /** Dispatch recovery by strategy name. Throws if the name isn't registered. */
  async recover(
    name: string,
    ctx: ConflictContext,
  ): Promise<ConflictResolution> {
    const strategy = this.strategies.get(name);
    if (strategy === undefined) {
      throw new Error(`RecoveryRegistry: no strategy registered for "${name}"`);
    }
    return strategy.recover(ctx);
  }
}
