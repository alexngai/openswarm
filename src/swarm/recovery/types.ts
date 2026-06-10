/**
 * recovery/types.ts — the ConflictRecoveryStrategy seam.
 *
 * When a landing returns a conflict, a ConflictRecoveryStrategy decides what to
 * do (defer / abandon / escalate / spawn-resolver). Ported from macro-agent's
 * `workspace/recovery/` (conflict-recovery.md §3), adapted to swarm shapes:
 *   - keyed by `sourceAgentId` (swarm keys everything by agentId, not streamId)
 *   - `conflictId` is synthesized locally — git-cascade surfaces conflict file
 *     paths, not a ConflictRecord.
 *
 * P0 ships the seam (types + registry) only; the built-in strategies and the
 * dispatch wiring land in docs/44 P1.
 */

import type { AgentId } from "../../core/types.js";

/** What produced the conflict (resolution differs per source). */
export type ConflictOperation = "merge" | "sync" | "cascade";

export interface ConflictContext {
  /** Locally-synthesized id for this conflict occurrence. */
  readonly conflictId: string;
  /** The agent whose landing produced the conflict. */
  readonly sourceAgentId: AgentId;
  readonly streamId: string;
  /** Conflicting file paths (= MergeStreamResult.conflicts). */
  readonly paths: readonly string[];
  readonly operation: ConflictOperation;
  readonly targetBranch?: string;
  readonly targetStream?: string;
  /** Bounded-recursion guard for resolver-produced conflicts. */
  readonly recoveryDepth: number;
  /** Strategy-specific config from role/team YAML. */
  readonly strategyConfig?: Record<string, unknown>;
}

export type ConflictResolution =
  | { readonly kind: "resolved"; readonly resolutionCommit?: string }
  | { readonly kind: "deferred"; readonly reason: string }
  | { readonly kind: "abandoned"; readonly streamId: string; readonly reason: string }
  | { readonly kind: "escalated"; readonly escalatedTo: AgentId | "human" }
  | { readonly kind: "failed"; readonly error: string };

export type ConflictResolutionMode = "sync" | "async";

export interface ConflictRecoveryStrategy {
  readonly name: string;
  readonly mode: ConflictResolutionMode;
  /** Optional gate — return false to decline (e.g. auto-resolve only for merges). */
  canHandle?(ctx: ConflictContext): boolean;
  recover(ctx: ConflictContext): Promise<ConflictResolution>;
}
