/**
 * landing/types.ts — the LandingStrategy seam.
 *
 * A LandingStrategy is how a streamed team member's work is finalized once it
 * completes. macro-agent registers these on its WorkspaceManager and selects
 * one per-role via YAML; openswarm selects one per-topology (today) and
 * per-role (P1+). See docs/44 P0.
 *
 * P0 ships the seam + `merge-to-parent` (the behavior lifted verbatim from
 * PeerTeamTopology.maybeMergeStreams). `queue-to-branch` etc. land in P4.
 */

import type { AgentId } from "../../core/types.js";
import type { MergeStreamResult } from "../adapters/git-cascade-branch-policy.js";

export type { MergeStreamResult };

/**
 * The subset of StandaloneHost a LandingStrategy needs to finalize an agent's
 * work. StandaloneHost satisfies this structurally — strategies depend on this
 * narrow surface rather than the whole host.
 */
export interface LandingHost {
  streamIdFor(agentId: AgentId): string | undefined;
  mergeStreamForAgent(
    agentId: AgentId,
    opts: { readonly targetStream: string; readonly strategy?: string },
  ): Promise<MergeStreamResult | null>;
  mergeStreamToBranchForAgent(
    agentId: AgentId,
    opts: { readonly targetBranch: string; readonly strategy?: string },
  ): Promise<MergeStreamResult | null>;
  /**
   * docs/44 P4 — enqueue a stream for ordered queue-to-branch landing. Optional;
   * the `queue-to-branch` strategy feature-detects it.
   */
  enqueueMerge?(opts: {
    streamId: string;
    targetBranch: string;
    agentId?: string;
  }): Promise<string | null>;
}

/**
 * Context for finalizing a single agent's work. Exactly one of `targetStream`
 * / `targetBranch` is set, mirroring `TeamCoordination.mergeStreams`' xor.
 */
export interface LandingContext {
  readonly host: LandingHost;
  readonly agentId: AgentId;
  /** The agent's source stream (already resolved via host.streamIdFor). */
  readonly streamId: string;
  readonly targetStream?: string;
  readonly targetBranch?: string;
  readonly strategy?: string;
}

/**
 * A pluggable algorithm for landing one agent's stream. Returns the merge
 * result, or `null` when the host's adapter can't perform the operation
 * (caller treats `null` as "skipped — adapter unsupported").
 */
export interface LandingStrategy {
  readonly name: string;
  land(ctx: LandingContext): Promise<MergeStreamResult | null>;
}
