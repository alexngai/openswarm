/**
 * usage-aggregator.ts — sum per-member and team-wide token/cost/compute usage
 * across the swarm spawn tree (GitHub #17; pluggable cost model docs/50 §5.1 / G1).
 *
 * Background (docs/47 H1): individual worker/member token usage already rides
 * on lane events — a child's `message_stop` carries `usage`, and issue #15's
 * `swarm-view-events.ts` accrues per-agent tokens for the TUI. But nothing
 * summed usage ACROSS the spawn tree, so "the cost side of the frontier is
 * blank": operators steering a swarm saw no per-member subtree total and no
 * team-wide total.
 *
 * This module is the missing accumulator. It observes the same lane-event
 * stream (`worker_spawned` for the parent→child edges + optional model, and
 * `message_stop` for the usage samples) and answers two questions:
 *
 *   - per member (across its FULL subtree): how many tokens / how much cost /
 *     how much compute has this member and everything it spawned consumed?
 *   - team total: sum across every agent that produced usage.
 *
 * It is pure and stateful with no I/O, so it unit-tests directly against
 * synthetic LaneEvents (mirrors `swarm-view-events.ts`). `subscribeEvents` on
 * the team daemon feeds it a live stream; the daemon then joins the per-agent
 * subtree totals onto the roster it returns from the `status` RPC.
 *
 * Cost/compute: each agent's sample is priced through a pluggable `CostModel`
 * (src/core/cost-model.ts) — dollars from the pricing table, FLOPs from model
 * params, and GPU-seconds when the serving layer stamps them onto the sample.
 * The default backend is `ApiCostModel` ($ + FLOPs, no hardware); the team daemon
 * injects `defaultCostModel()` so `OPENSWARM_USD_PER_GPU_HOUR` selects self-host
 * GPU accounting (docs/50 §4.2). When an axis can't be determined for a sample
 * (unpriced model, unknown params, no GPU measurement) the numeric total still
 * adds 0 but the matching `*Complete` flag flips false — so a roll-up reports the
 * figure AND whether it is whole. "Unpriced" is never silently "$0".
 */

import type { AgentId, Usage } from "../core/types.js";
import { ApiCostModel } from "../core/cost-model.js";
import type { CostModel, CostSample } from "../core/cost-model.js";
import type { LaneEvent } from "./events.js";

/**
 * Rolled-up usage numbers for one agent's subtree, or for the whole team.
 * `totalTokens` sums all four token categories. `costUsd`/`gpuSeconds`/`flops`
 * are priced via the injected CostModel (0 when the axis is unavailable); the
 * paired `*Complete` flags are false when ANY contributing sample lacked that
 * axis, so the figure is flagged as a lower bound rather than mistaken for exact.
 */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly totalTokens: number;
  /** Number of usage samples (`message_stop` events) — i.e. LLM calls. Divides
   * the token axes into per-call means (docs/53 TE-14: context-per-turn). */
  readonly calls: number;
  readonly costUsd: number;
  /** GPU-seconds; 0 until the serving layer stamps samples (docs/50 G2). */
  readonly gpuSeconds: number;
  /** Estimated forward-pass FLOPs; 0 when model params are unknown. */
  readonly flops: number;
  /** False when any contributing sample had an unpriced model (costUsd is a lower bound). */
  readonly costUsdComplete: boolean;
  /** False when any contributing sample carried no GPU-seconds measurement. */
  readonly gpuSecondsComplete: boolean;
  /** False when any contributing sample had unknown params (flops is a lower bound). */
  readonly flopsComplete: boolean;
}

/**
 * A team-wide usage snapshot: per-agent subtree totals keyed by agentId, plus
 * a `team` roll-up summing every agent's direct usage (no double counting).
 */
export interface UsageSnapshot {
  readonly perAgent: Readonly<Record<string, UsageTotals>>;
  readonly team: UsageTotals;
}

/** Zero totals — the identity used for empty agents and as a fold seed. The
 * `*Complete` flags are `true` (vacuously — nothing incomplete) so folding them
 * with `&&` is an identity that never spuriously marks a real total partial. */
export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  totalTokens: 0,
  calls: 0,
  costUsd: 0,
  gpuSeconds: 0,
  flops: 0,
  costUsdComplete: true,
  gpuSecondsComplete: true,
  flopsComplete: true,
};

/** Raw per-agent accumulator (cost is derived lazily, so model can arrive late). */
interface AgentAcc {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  calls: number;
  gpuSeconds: number;
  model?: string;
}

function newAcc(): AgentAcc {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    calls: 0,
    gpuSeconds: 0,
  };
}

/**
 * Accumulates token/cost/compute usage per agent from a lane-event stream and
 * rolls it up across the spawn tree. One instance per team/host subscription.
 */
export class SwarmUsageAggregator {
  private readonly accs = new Map<string, AgentAcc>();
  /** childAgentId → parentAgentId, learned from `worker_spawned`. */
  private readonly parents = new Map<string, string>();

  /** @param costModel prices each sample; defaults to $-table + FLOPs (ApiCostModel). */
  constructor(private readonly costModel: CostModel = new ApiCostModel()) {}

  /** Feed one lane event. Ignores events that carry no usage or spawn edge. */
  record(evt: LaneEvent): void {
    switch (evt.type) {
      case "worker_spawned":
        this.onWorkerSpawned(evt);
        return;
      case "message_stop":
        this.onMessageStop(evt);
        return;
      default:
        return;
    }
  }

  private onWorkerSpawned(evt: LaneEvent): void {
    const p = (evt.payload ?? {}) as {
      childAgentId?: string;
      parentAgentId?: string;
      model?: string;
    };
    const child = p.childAgentId;
    if (child === undefined) return;
    const acc = this.ensure(child);
    if (p.model !== undefined) acc.model = p.model;
    if (p.parentAgentId !== undefined && p.parentAgentId !== child) {
      this.parents.set(child, p.parentAgentId);
    }
  }

  private onMessageStop(evt: LaneEvent): void {
    const usage = (evt.payload as { usage?: Usage } | undefined)?.usage;
    if (usage === undefined) return;
    const acc = this.ensure(evt.agentId);
    acc.inputTokens += usage.inputTokens ?? 0;
    acc.outputTokens += usage.outputTokens ?? 0;
    acc.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    acc.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
    acc.calls += 1;
    // GPU-seconds ride on the sample once the serving layer stamps them (docs/50
    // G2); until then this reads 0 and `gpuSecondsComplete` reports the gap.
    acc.gpuSeconds += (usage as { gpuSeconds?: number }).gpuSeconds ?? 0;
  }

  private ensure(agentId: string): AgentAcc {
    let acc = this.accs.get(agentId);
    if (acc === undefined) {
      acc = newAcc();
      this.accs.set(agentId, acc);
    }
    return acc;
  }

  /** Record/override a model for cost pricing (e.g. from a member spec). */
  setModel(agentId: string, model: string): void {
    this.ensure(agentId).model = model;
  }

  /** Every agentId the aggregator has observed usage or a spawn edge for. */
  agentIds(): string[] {
    return [...this.accs.keys()];
  }

  /** This agent's own direct usage, excluding anything it spawned. */
  directUsage(agentId: AgentId | string): UsageTotals {
    const acc = this.accs.get(agentId);
    return acc === undefined ? ZERO_USAGE : accToTotals(acc, this.costModel);
  }

  /**
   * This agent's usage summed across its FULL subtree (itself + every
   * descendant it spawned, transitively). This is the per-member number the
   * roster surfaces.
   */
  subtreeUsage(agentId: AgentId | string): UsageTotals {
    let total = ZERO_USAGE;
    for (const id of this.subtreeIds(agentId)) {
      const acc = this.accs.get(id);
      if (acc !== undefined) total = addTotals(total, accToTotals(acc, this.costModel));
    }
    return total;
  }

  /** Team-wide total: sum of every agent's direct usage (no double counting). */
  teamTotal(): UsageTotals {
    let total = ZERO_USAGE;
    for (const acc of this.accs.values()) total = addTotals(total, accToTotals(acc, this.costModel));
    return total;
  }

  /**
   * Per-model token/cost totals — direct usage grouped by the model each agent ran.
   * For a heterogeneous cascade (each tier a distinct model) this is the per-tier
   * cost breakdown the frontier needs (docs/51 B3); tokens are the durable signal,
   * a downstream CostModel can re-price them. Agents with no observed model group
   * under "(unknown)".
   */
  byModel(): Record<string, UsageTotals> {
    const out: Record<string, UsageTotals> = {};
    for (const acc of this.accs.values()) {
      const key = acc.model ?? "(unknown)";
      out[key] = addTotals(out[key] ?? ZERO_USAGE, accToTotals(acc, this.costModel));
    }
    return out;
  }

  /**
   * Build a snapshot. When `rootAgentIds` is given, `perAgent` reports each
   * root's SUBTREE total (the per-member roll-up the daemon roster wants);
   * otherwise it reports every observed agent's DIRECT usage. `team` is always
   * the team-wide total.
   */
  snapshot(rootAgentIds?: readonly string[]): UsageSnapshot {
    const perAgent: Record<string, UsageTotals> = {};
    if (rootAgentIds !== undefined) {
      for (const id of rootAgentIds) perAgent[id] = this.subtreeUsage(id);
    } else {
      for (const id of this.accs.keys()) perAgent[id] = this.directUsage(id);
    }
    return { perAgent, team: this.teamTotal() };
  }

  /** All agentIds in `rootId`'s subtree (inclusive), guarding against cycles. */
  private subtreeIds(rootId: string): string[] {
    // Invert the parent map once per traversal — trees are tiny (bounded by
    // the recursion-depth cap), so this is cheap and keeps state simple.
    const children = new Map<string, string[]>();
    for (const [child, parent] of this.parents) {
      const list = children.get(parent) ?? [];
      list.push(child);
      children.set(parent, list);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const c of children.get(id) ?? []) stack.push(c);
    }
    return out;
  }
}

function accToTotals(acc: AgentAcc, costModel: CostModel): UsageTotals {
  const totalTokens =
    acc.inputTokens +
    acc.outputTokens +
    acc.cacheReadInputTokens +
    acc.cacheWriteInputTokens;
  const sample: CostSample = {
    model: acc.model,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens,
    cacheWriteInputTokens: acc.cacheWriteInputTokens,
    // Only surface a measured GPU figure; 0 means "no measurement", not "0s".
    gpuSeconds: acc.gpuSeconds > 0 ? acc.gpuSeconds : undefined,
  };
  const cost = costModel.cost(sample);
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens,
    cacheWriteInputTokens: acc.cacheWriteInputTokens,
    totalTokens,
    calls: acc.calls,
    costUsd: cost.usd ?? 0,
    gpuSeconds: cost.gpuSeconds ?? 0,
    flops: cost.flops ?? 0,
    costUsdComplete: cost.usd !== undefined,
    gpuSecondsComplete: cost.gpuSeconds !== undefined,
    flopsComplete: cost.flops !== undefined,
  };
}

/**
 * Mean context (prompt) tokens per LLM call — the Databricks "context per turn"
 * metric (docs/53 TE-14). Counts everything sent as input: fresh input tokens
 * plus cache reads/writes. Undefined when no calls were observed.
 */
export function contextTokensPerCall(t: UsageTotals): number | undefined {
  if (t.calls <= 0) return undefined;
  return (t.inputTokens + t.cacheReadInputTokens + t.cacheWriteInputTokens) / t.calls;
}

/**
 * Fraction of input-side tokens served from the prompt cache (docs/53 TE-14).
 * Low values on multi-turn work signal a churning prefix (e.g. a system prompt
 * that changes every turn). Undefined when no input-side tokens were observed.
 */
export function cacheReadFraction(t: UsageTotals): number | undefined {
  const denom = t.inputTokens + t.cacheReadInputTokens + t.cacheWriteInputTokens;
  if (denom <= 0) return undefined;
  return t.cacheReadInputTokens / denom;
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    calls: a.calls + b.calls,
    costUsd: a.costUsd + b.costUsd,
    gpuSeconds: a.gpuSeconds + b.gpuSeconds,
    flops: a.flops + b.flops,
    costUsdComplete: a.costUsdComplete && b.costUsdComplete,
    gpuSecondsComplete: a.gpuSecondsComplete && b.gpuSecondsComplete,
    flopsComplete: a.flopsComplete && b.flopsComplete,
  };
}
