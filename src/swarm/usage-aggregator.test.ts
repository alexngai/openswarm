/**
 * Tests for src/swarm/usage-aggregator.ts — GitHub #17.
 *
 * Pure LaneEvent-driven unit tests (mirrors swarm-view-events.test.ts): feed
 * synthetic `worker_spawned` / `message_stop` events, assert per-member
 * subtree rollups, the team-wide total, and cost pricing.
 */

import { describe, it, expect } from "vitest";
import type { AgentId, Usage } from "../core/types.js";
import type { LaneEvent } from "./events.js";
import {
  SwarmUsageAggregator,
  ZERO_USAGE,
  cacheReadFraction,
  contextTokensPerCall,
} from "./usage-aggregator.js";

function spawned(
  child: string,
  parent?: string,
  model?: string,
): LaneEvent {
  return {
    ts: 1,
    agentId: (parent ?? "orchestrator") as AgentId,
    type: "worker_spawned",
    payload: {
      childAgentId: child,
      ...(parent !== undefined && { parentAgentId: parent }),
      ...(model !== undefined && { model }),
      taskId: `task-${child}`,
    },
  };
}

function messageStop(agentId: string, usage: Usage): LaneEvent {
  return {
    ts: 2,
    agentId: agentId as AgentId,
    type: "message_stop",
    payload: { stopReason: "end_turn", usage },
  };
}

describe("SwarmUsageAggregator — per-agent accrual", () => {
  it("sums tokens across multiple message_stop events for one agent", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("a1"));
    agg.record(messageStop("a1", { inputTokens: 100, outputTokens: 50 }));
    agg.record(messageStop("a1", { inputTokens: 20, outputTokens: 10 }));

    const u = agg.directUsage("a1");
    expect(u.inputTokens).toBe(120);
    expect(u.outputTokens).toBe(60);
    expect(u.totalTokens).toBe(180);
  });

  it("counts LLM calls and derives per-call context metrics (docs/53 TE-14)", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(
      messageStop("a1", {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 300,
        cacheWriteInputTokens: 100,
      }),
    );
    agg.record(messageStop("a1", { inputTokens: 200, outputTokens: 10 }));

    const u = agg.directUsage("a1");
    expect(u.calls).toBe(2);
    // (100 + 300 + 100 + 200) / 2 calls
    expect(contextTokensPerCall(u)).toBe(350);
    // 300 cache-read of 700 input-side tokens
    expect(cacheReadFraction(u)).toBeCloseTo(300 / 700);
    // No calls / no tokens → undefined, not 0 or NaN.
    expect(contextTokensPerCall(ZERO_USAGE)).toBeUndefined();
    expect(cacheReadFraction(ZERO_USAGE)).toBeUndefined();
  });

  it("counts cache-read/write tokens in totalTokens", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(
      messageStop("a1", {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 100,
        cacheWriteInputTokens: 40,
      }),
    );
    const u = agg.directUsage("a1");
    expect(u.cacheReadInputTokens).toBe(100);
    expect(u.cacheWriteInputTokens).toBe(40);
    expect(u.totalTokens).toBe(155);
  });

  it("returns ZERO_USAGE for an unknown agent", () => {
    const agg = new SwarmUsageAggregator();
    expect(agg.directUsage("nope")).toEqual(ZERO_USAGE);
  });

  it("ignores message_stop with no usage payload", () => {
    const agg = new SwarmUsageAggregator();
    agg.record({
      ts: 2,
      agentId: "a1" as AgentId,
      type: "message_stop",
      payload: { stopReason: "end_turn" },
    });
    expect(agg.directUsage("a1")).toEqual(ZERO_USAGE);
  });
});

describe("SwarmUsageAggregator — spawn-tree subtree rollup", () => {
  it("rolls a member's own usage plus every descendant it spawned", () => {
    const agg = new SwarmUsageAggregator();
    // tree: root -> child -> grandchild ; root also -> sibling
    agg.record(spawned("root"));
    agg.record(spawned("child", "root"));
    agg.record(spawned("grandchild", "child"));
    agg.record(spawned("sibling", "root"));

    agg.record(messageStop("root", { inputTokens: 10, outputTokens: 1 }));
    agg.record(messageStop("child", { inputTokens: 20, outputTokens: 2 }));
    agg.record(messageStop("grandchild", { inputTokens: 30, outputTokens: 3 }));
    agg.record(messageStop("sibling", { inputTokens: 40, outputTokens: 4 }));

    // child subtree = child + grandchild
    expect(agg.subtreeUsage("child").totalTokens).toBe(20 + 2 + 30 + 3);
    // root subtree = everyone
    expect(agg.subtreeUsage("root").totalTokens).toBe(
      10 + 1 + 20 + 2 + 30 + 3 + 40 + 4,
    );
    // leaf subtree = just itself
    expect(agg.subtreeUsage("grandchild").totalTokens).toBe(33);
  });

  it("team total sums every agent's direct usage without double counting", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("root"));
    agg.record(spawned("child", "root"));
    agg.record(messageStop("root", { inputTokens: 10, outputTokens: 0 }));
    agg.record(messageStop("child", { inputTokens: 5, outputTokens: 0 }));

    expect(agg.teamTotal().totalTokens).toBe(15);
  });

  it("snapshot(rootIds) reports per-root subtree totals + team total", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("m1"));
    agg.record(spawned("m2"));
    agg.record(spawned("m1-child", "m1"));
    agg.record(messageStop("m1", { inputTokens: 10, outputTokens: 0 }));
    agg.record(messageStop("m1-child", { inputTokens: 7, outputTokens: 0 }));
    agg.record(messageStop("m2", { inputTokens: 3, outputTokens: 0 }));

    const snap = agg.snapshot(["m1", "m2"]);
    expect(snap.perAgent["m1"]?.totalTokens).toBe(17);
    expect(snap.perAgent["m2"]?.totalTokens).toBe(3);
    expect(snap.team.totalTokens).toBe(20);
  });
});

describe("SwarmUsageAggregator — cost pricing", () => {
  it("prices cost from the model carried on worker_spawned", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("a1", undefined, "claude-sonnet-4-6"));
    agg.record(messageStop("a1", { inputTokens: 1000, outputTokens: 500 }));
    // (1000 * 3.00 + 500 * 15.00) / 1e6 = 0.0105
    expect(agg.directUsage("a1").costUsd).toBeCloseTo(0.0105, 10);
  });

  it("rolls cost across a subtree", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("root", undefined, "claude-sonnet-4-6"));
    agg.record(spawned("child", "root", "claude-haiku-4-5"));
    agg.record(messageStop("root", { inputTokens: 1000, outputTokens: 0 }));
    agg.record(messageStop("child", { inputTokens: 1000, outputTokens: 0 }));
    // root: 1000*3/1e6 = 0.003 ; child (haiku): 1000*0.80/1e6 = 0.0008
    expect(agg.subtreeUsage("root").costUsd).toBeCloseTo(0.0038, 10);
  });

  it("counts tokens but zero cost when the model is unknown/unpriced", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("a1", undefined, "some-unpriced-model"));
    agg.record(messageStop("a1", { inputTokens: 500, outputTokens: 500 }));
    const u = agg.directUsage("a1");
    expect(u.totalTokens).toBe(1000);
    expect(u.costUsd).toBe(0);
  });

  it("setModel overrides pricing for an agent (e.g. from a member spec)", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(messageStop("a1", { inputTokens: 1000, outputTokens: 0 }));
    expect(agg.directUsage("a1").costUsd).toBe(0);
    agg.setModel("a1", "claude-sonnet-4-6");
    expect(agg.directUsage("a1").costUsd).toBeCloseTo(0.003, 10);
  });

  it("byModel groups direct usage by the model each agent ran (per-tier breakdown)", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("tier0", undefined, "qwen3-8b"));
    agg.record(spawned("tier1", "tier0", "qwen3-30b"));
    agg.record(messageStop("tier0", { inputTokens: 100, outputTokens: 10 }));
    agg.record(messageStop("tier1", { inputTokens: 200, outputTokens: 20 }));
    const bm = agg.byModel();
    expect(bm["qwen3-8b"]?.totalTokens).toBe(110);
    expect(bm["qwen3-30b"]?.totalTokens).toBe(220);
    expect(Object.keys(bm).sort()).toEqual(["qwen3-30b", "qwen3-8b"]);
  });
});

// docs/52 — deterministic usage from awaited AgentResults. Multi-worker topologies
// intermittently drop every worker's async `message_stop`; the topology feeds the
// result usage here so the cell's team_usage can never spuriously read $0.
describe("SwarmUsageAggregator — setDirectUsage (authoritative result usage)", () => {
  it("records per-model usage with NO message_stop event at all (the dropped-bus case)", () => {
    const agg = new SwarmUsageAggregator();
    // executor + critic complete; their async message_stop never arrives.
    agg.setDirectUsage("exec", "haiku", { inputTokens: 100, outputTokens: 50 });
    agg.setDirectUsage("critic", "gpt-5.5", { inputTokens: 200, outputTokens: 20 });
    expect(agg.teamTotal().totalTokens).toBe(370);
    const bm = agg.byModel();
    expect(bm["haiku"]?.totalTokens).toBe(150);
    expect(bm["gpt-5.5"]?.totalTokens).toBe(220);
  });

  it("ignores a message_stop that arrives AFTER setDirectUsage (no double-count)", () => {
    const agg = new SwarmUsageAggregator();
    agg.setDirectUsage("a1", "haiku", { inputTokens: 100, outputTokens: 50 });
    agg.record(messageStop("a1", { inputTokens: 100, outputTokens: 50 })); // late duplicate
    expect(agg.directUsage("a1").totalTokens).toBe(150); // not 300
  });

  it("overwrites a message_stop that arrived BEFORE (authoritative value wins)", () => {
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("a1", undefined, "haiku"));
    agg.record(messageStop("a1", { inputTokens: 999, outputTokens: 999 })); // stale/partial
    agg.setDirectUsage("a1", "haiku", { inputTokens: 100, outputTokens: 50 });
    expect(agg.directUsage("a1").totalTokens).toBe(150); // overwritten, not summed
    expect(agg.byModel()["haiku"]?.totalTokens).toBe(150);
  });

  it("keeps cache tokens in the authoritative total", () => {
    const agg = new SwarmUsageAggregator();
    agg.setDirectUsage("a1", "haiku", {
      inputTokens: 27,
      outputTokens: 609,
      cacheReadInputTokens: 16031,
      cacheWriteInputTokens: 7862,
    });
    expect(agg.directUsage("a1").totalTokens).toBe(27 + 609 + 16031 + 7862);
  });

  it("a ZERO worker result does NOT clobber accumulated message_stop usage", () => {
    // Regression: the worker occasionally fails to capture usage and reports {0,0};
    // that must not wipe what the streaming message_stop path already recorded, nor
    // mark the agent authoritative (which would ignore later real usage).
    const agg = new SwarmUsageAggregator();
    agg.record(spawned("a1", undefined, "haiku"));
    agg.record(messageStop("a1", { inputTokens: 100, outputTokens: 50 }));
    agg.setDirectUsage("a1", "haiku", { inputTokens: 0, outputTokens: 0 });
    expect(agg.directUsage("a1").totalTokens).toBe(150); // preserved, not zeroed
    // a later real message_stop still accumulates (agent not locked authoritative)
    agg.record(messageStop("a1", { inputTokens: 10, outputTokens: 5 }));
    expect(agg.directUsage("a1").totalTokens).toBe(165);
  });
});
