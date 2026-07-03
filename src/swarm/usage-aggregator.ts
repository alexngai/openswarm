/**
 * usage-aggregator.ts — sum per-member and team-wide token/cost usage across
 * the swarm spawn tree (GitHub #17).
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
 *   - per member (across its FULL subtree): how many tokens / how much cost has
 *     this member and everything it spawned consumed?
 *   - team total: sum across every agent that produced usage.
 *
 * It is pure and stateful with no I/O, so it unit-tests directly against
 * synthetic LaneEvents (mirrors `swarm-view-events.ts`). `subscribeEvents` on
 * the team daemon feeds it a live stream; the daemon then joins the per-agent
 * subtree totals onto the roster it returns from the `status` RPC.
 *
 * Cost: computed via the existing model-pricing table (`usageCostUsd` in
 * src/core/budget.ts). The model is learned from the `worker_spawned` payload
 * (`model`, threaded from the spawn request in standalone-host). When a model
 * is unknown/unpriced the cost contribution is 0 but tokens still count, so the
 * aggregate never crashes on a heterogeneous tree.
 */

import type { AgentId, Usage } from "../core/types.js";
import { usageCostUsd } from "../core/budget.js";
import type { LaneEvent } from "./events.js";

/**
 * Rolled-up usage numbers for one agent's subtree, or for the whole team.
 * `totalTokens` is the sum of all four token categories; `costUsd` is priced
 * from input/output tokens via the model-pricing table (0 when unpriced).
 */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/**
 * A team-wide usage snapshot: per-agent subtree totals keyed by agentId, plus
 * a `team` roll-up summing every agent's direct usage (no double counting).
 */
export interface UsageSnapshot {
  readonly perAgent: Readonly<Record<string, UsageTotals>>;
  readonly team: UsageTotals;
}

/** Zero totals — the identity used for empty agents and as a fold seed. */
export const ZERO_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

/** Raw per-agent accumulator (cost is derived lazily, so model can arrive late). */
interface AgentAcc {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  model?: string;
}

function newAcc(): AgentAcc {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
}

/**
 * Accumulates token/cost usage per agent from a lane-event stream and rolls it
 * up across the spawn tree. One instance per team/host subscription.
 */
export class SwarmUsageAggregator {
  private readonly accs = new Map<string, AgentAcc>();
  /** childAgentId → parentAgentId, learned from `worker_spawned`. */
  private readonly parents = new Map<string, string>();

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
    return acc === undefined ? ZERO_USAGE : accToTotals(acc);
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
      if (acc !== undefined) total = addTotals(total, accToTotals(acc));
    }
    return total;
  }

  /** Team-wide total: sum of every agent's direct usage (no double counting). */
  teamTotal(): UsageTotals {
    let total = ZERO_USAGE;
    for (const acc of this.accs.values()) total = addTotals(total, accToTotals(acc));
    return total;
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

function accToTotals(acc: AgentAcc): UsageTotals {
  const totalTokens =
    acc.inputTokens +
    acc.outputTokens +
    acc.cacheReadInputTokens +
    acc.cacheWriteInputTokens;
  const costUsd = usageCostUsd(
    {
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens,
      cacheWriteInputTokens: acc.cacheWriteInputTokens,
    },
    acc.model,
  );
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens,
    cacheWriteInputTokens: acc.cacheWriteInputTokens,
    totalTokens,
    costUsd,
  };
}

function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}
