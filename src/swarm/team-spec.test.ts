/**
 * team-spec.test.ts — Stage 4B unit tests for the full TeamSpec schema.
 * Covers happy paths for each TopologyKind/CompletionRule/Aggregator,
 * rejection of malformed inputs, JSON round-trip, and the cc-swarm gsd
 * template's translated shape (the "schema accepts an openteams template's
 * translated form" acceptance check from docs/27 stage 4B).
 */

import { describe, it, expect } from "vitest";
import {
  AggregatorSchema,
  CompletionRuleSchema,
  MemberSpecSchema,
  TeamCoordinationSchema,
  TeamSpecSchema,
  TopologyKindSchema,
  type TeamSpec,
} from "./team-spec.js";

// ---------------------------------------------------------------------------
// MemberSpec — confirm it admits the shapes shown in docs/25 §5
// ---------------------------------------------------------------------------

describe("MemberSpecSchema", () => {
  it("accepts a minimal member (role + prompt)", () => {
    const r = MemberSpecSchema.safeParse({ role: "executor", prompt: "do x" });
    expect(r.success).toBe(true);
  });

  it("accepts a member with all docs/25 §5 optional fields populated", () => {
    const r = MemberSpecSchema.safeParse({
      id: "exec-1",
      role: "executor",
      prompt: "do x",
      budget: { maxTokens: 1000 },
      branchPolicy: { kind: "create", from: "main" },
      commitPolicy: { kind: "auto" },
      escalationPolicy: { kind: "none" },
      model: "claude-opus-4-7",
      framework: "claude-agent-sdk",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty role", () => {
    expect(MemberSpecSchema.safeParse({ role: "", prompt: "x" }).success).toBe(false);
  });

  it("rejects empty prompt", () => {
    expect(MemberSpecSchema.safeParse({ role: "executor", prompt: "" }).success).toBe(false);
  });

  it("rejects an unknown framework value", () => {
    const r = MemberSpecSchema.safeParse({
      role: "executor",
      prompt: "x",
      framework: "gpt-4",
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TopologyKind
// ---------------------------------------------------------------------------

describe("TopologyKindSchema", () => {
  const kinds = ["fanout", "pipeline", "coordinator", "peer-team", "committee", "critic-loop"] as const;

  for (const k of kinds) {
    it(`accepts ${k}`, () => {
      expect(TopologyKindSchema.safeParse(k).success).toBe(true);
    });
  }

  it("rejects an unknown topology kind", () => {
    const r = TopologyKindSchema.safeParse("mesh");
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CompletionRule
// ---------------------------------------------------------------------------

describe("CompletionRuleSchema", () => {
  it("accepts kind=all", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "all" }).success).toBe(true);
  });

  it("accepts kind=any", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "any" }).success).toBe(true);
  });

  it("accepts kind=majority with positive m", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "majority", m: 2 }).success).toBe(true);
  });

  it("rejects kind=majority with m=0", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "majority", m: 0 }).success).toBe(false);
  });

  it("rejects kind=majority with negative m", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "majority", m: -1 }).success).toBe(false);
  });

  it("rejects kind=majority missing m", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "majority" }).success).toBe(false);
  });

  it("accepts kind=deadline with positive ms", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "deadline", ms: 5000 }).success).toBe(true);
  });

  it("rejects kind=deadline with ms=-100", () => {
    expect(CompletionRuleSchema.safeParse({ kind: "deadline", ms: -100 }).success).toBe(false);
  });

  it("accepts kind=until_signal with non-empty signal", () => {
    expect(
      CompletionRuleSchema.safeParse({ kind: "until_signal", signal: "DONE" }).success,
    ).toBe(true);
  });

  it("rejects kind=until_signal with empty signal", () => {
    expect(
      CompletionRuleSchema.safeParse({ kind: "until_signal", signal: "" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

describe("AggregatorSchema", () => {
  it("accepts kind=concat (no separator)", () => {
    expect(AggregatorSchema.safeParse({ kind: "concat" }).success).toBe(true);
  });

  it("accepts kind=concat with separator", () => {
    expect(
      AggregatorSchema.safeParse({ kind: "concat", separator: "\n---\n" }).success,
    ).toBe(true);
  });

  it("accepts kind=last", () => {
    expect(AggregatorSchema.safeParse({ kind: "last" }).success).toBe(true);
  });

  it("accepts kind=vote", () => {
    expect(AggregatorSchema.safeParse({ kind: "vote" }).success).toBe(true);
  });

  it("accepts kind=judge with role", () => {
    expect(
      AggregatorSchema.safeParse({ kind: "judge", role: "reviewer" }).success,
    ).toBe(true);
  });

  it("rejects kind=judge missing role", () => {
    expect(AggregatorSchema.safeParse({ kind: "judge" }).success).toBe(false);
  });

  it("rejects kind=judge with empty role", () => {
    expect(AggregatorSchema.safeParse({ kind: "judge", role: "" }).success).toBe(false);
  });

  it("accepts kind=custom (fn callback intentionally omitted from schema)", () => {
    expect(AggregatorSchema.safeParse({ kind: "custom" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TeamCoordination
// ---------------------------------------------------------------------------

describe("TeamCoordinationSchema", () => {
  it("accepts the minimum (just completion)", () => {
    expect(
      TeamCoordinationSchema.safeParse({ completion: { kind: "all" } }).success,
    ).toBe(true);
  });

  it("accepts a fully-populated coordination block", () => {
    const r = TeamCoordinationSchema.safeParse({
      completion: { kind: "majority", m: 2 },
      aggregator: { kind: "judge", role: "reviewer" },
      aggregateBudget: { maxTokens: 100_000, maxCostUsd: 5 },
      defaultBranchPolicy: { kind: "create", from: "main" },
      communication: {
        enforcement: "permissive",
        channels: { workflow: { signals: ["DONE"] } },
        subscriptions: { architect: [{ channel: "workflow" }] },
        emissions: { architect: ["DONE"] },
      },
      idleTimeoutMs: 600_000,
      mapScope: "swarm:custom",
      entryPoint: { role: "architect" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts entryPoint=root", () => {
    const r = TeamCoordinationSchema.safeParse({
      completion: { kind: "all" },
      entryPoint: "root",
    });
    expect(r.success).toBe(true);
  });

  it("accepts entryPoint=broadcast", () => {
    const r = TeamCoordinationSchema.safeParse({
      completion: { kind: "all" },
      entryPoint: "broadcast",
    });
    expect(r.success).toBe(true);
  });

  it("rejects idleTimeoutMs=0", () => {
    expect(
      TeamCoordinationSchema.safeParse({
        completion: { kind: "all" },
        idleTimeoutMs: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects empty mapScope", () => {
    expect(
      TeamCoordinationSchema.safeParse({
        completion: { kind: "all" },
        mapScope: "",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TeamSpec — happy paths, rejection paths, round-trip
// ---------------------------------------------------------------------------

describe("TeamSpecSchema", () => {
  const minimal: TeamSpec = {
    name: "alpha",
    topology: "fanout",
    members: [{ role: "executor", prompt: "do x" }],
    coordination: { completion: { kind: "all" } },
  };

  it("accepts a minimal valid TeamSpec", () => {
    expect(TeamSpecSchema.safeParse(minimal).success).toBe(true);
  });

  const topologies = ["fanout", "pipeline", "coordinator", "peer-team", "committee", "critic-loop"] as const;
  for (const topology of topologies) {
    it(`accepts topology=${topology}`, () => {
      expect(
        TeamSpecSchema.safeParse({ ...minimal, topology }).success,
      ).toBe(true);
    });
  }

  it("rejects empty name", () => {
    expect(TeamSpecSchema.safeParse({ ...minimal, name: "" }).success).toBe(false);
  });

  it("rejects empty members array", () => {
    expect(TeamSpecSchema.safeParse({ ...minimal, members: [] }).success).toBe(false);
  });

  it("rejects an unknown topology kind", () => {
    const r = TeamSpecSchema.safeParse({ ...minimal, topology: "mesh" });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Helpful error message: should mention topology or one of its valid values.
      const msg = r.error.message;
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  it("rejects missing coordination", () => {
    const { coordination: _drop, ...withoutCoord } = minimal;
    void _drop;
    expect(TeamSpecSchema.safeParse(withoutCoord).success).toBe(false);
  });

  it("accepts an optional templateName", () => {
    const r = TeamSpecSchema.safeParse({ ...minimal, templateName: "gsd" });
    expect(r.success).toBe(true);
  });

  it("rejects empty templateName", () => {
    const r = TeamSpecSchema.safeParse({ ...minimal, templateName: "" });
    expect(r.success).toBe(false);
  });

  it("round-trips through JSON.parse/JSON.stringify with structural equality", () => {
    const spec: TeamSpec = {
      name: "round-trip",
      topology: "peer-team",
      members: [
        { id: "a", role: "architect", prompt: "design" },
        { id: "e", role: "executor", prompt: "implement" },
      ],
      coordination: {
        completion: { kind: "all" },
        aggregator: { kind: "concat", separator: "\n" },
        aggregateBudget: { maxTokens: 50_000 },
        idleTimeoutMs: 600_000,
        entryPoint: "broadcast",
      },
      templateName: "feature-team",
    };
    const r = TeamSpecSchema.safeParse(JSON.parse(JSON.stringify(spec)));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual(spec);
    }
  });
});

// ---------------------------------------------------------------------------
// cc-swarm gsd-shaped fixture — the acceptance check from stage 4B
// ---------------------------------------------------------------------------

describe("TeamSpecSchema — cc-swarm gsd template translated form", () => {
  it("admits the shape produced by translating cc-swarm's gsd openteams template", () => {
    // Hand-written translation of the cc-swarm gsd template's shape per
    // docs/25 §5.4 mapping rules:
    //   topology.root + flat spawn_rules + x-swarm-harness override → peer-team
    //   communication block → TeamCommunicationRules
    //   per-role members materialized via openteams (placeholders here)
    const gsd: TeamSpec = {
      name: "gsd",
      topology: "peer-team",
      templateName: "gsd",
      members: [
        {
          id: "architect-1",
          role: "architect",
          prompt: "Design the feature.",
        },
        {
          id: "executor-1",
          role: "executor",
          prompt: "Implement the feature.",
        },
        {
          id: "reviewer-1",
          role: "reviewer",
          prompt: "Review the implementation.",
        },
      ],
      coordination: {
        completion: { kind: "all" },
        aggregator: { kind: "judge", role: "reviewer" },
        defaultBranchPolicy: { kind: "create", from: "main" },
        communication: {
          enforcement: "permissive",
          channels: {
            workflow: { signals: ["DESIGN_DONE", "IMPL_DONE", "REVIEW_DONE"] },
          },
          subscriptions: {
            architect: [{ channel: "workflow" }],
            executor: [{ channel: "workflow" }],
            reviewer: [{ channel: "workflow" }],
          },
          emissions: {
            architect: ["DESIGN_DONE"],
            executor: ["IMPL_DONE"],
            reviewer: ["REVIEW_DONE"],
          },
        },
        idleTimeoutMs: 600_000,
        entryPoint: { role: "architect" },
      },
    };

    const r = TeamSpecSchema.safeParse(gsd);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual(gsd);
    }
  });
});
