/**
 * mapping.test.ts — tests for openteamsToTeamSpec.
 */

import { describe, it, expect } from "vitest";
import { openteamsToTeamSpec } from "./mapping.js";
import type { OpenteamsConfig } from "./loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseGsdConfig: OpenteamsConfig = {
  name: "gsd-style",
  roles: ["lead", "researcher", "implementer"],
  topology: {
    root: { role: "lead" },
    spawn_rules: {
      lead: ["researcher", "implementer"],
      researcher: [],
      implementer: [],
    },
  },
  rolePrompts: {
    lead: "You are the lead.",
    researcher: "You are the researcher.",
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("openteamsToTeamSpec", () => {
  it("maps a cc-swarm gsd-style shape to coordinator topology with root first", () => {
    const spec = openteamsToTeamSpec(baseGsdConfig);
    expect(spec.topology).toBe("coordinator");
    expect(spec.members).toHaveLength(3);
    expect(spec.members[0]?.role).toBe("lead");
    expect(spec.members.map((m) => m.role)).toEqual([
      "lead",
      "researcher",
      "implementer",
    ]);
    expect(spec.name).toBe("gsd-style");
    expect(spec.templateName).toBe("gsd-style");
  });

  it("defaults to fanout when no topology block is present", () => {
    const config: OpenteamsConfig = {
      name: "no-topo",
      roles: ["a", "b"],
    };
    const spec = openteamsToTeamSpec(config);
    expect(spec.topology).toBe("fanout");
    expect(spec.members.map((m) => m.role)).toEqual(["a", "b"]);
  });

  it("respects defaultTopology option when no topology block is present", () => {
    const config: OpenteamsConfig = {
      name: "no-topo-override",
      roles: ["a"],
    };
    const spec = openteamsToTeamSpec(config, { defaultTopology: "pipeline" });
    expect(spec.topology).toBe("pipeline");
  });

  it("x-openswarm.topology overrides the inferred topology", () => {
    const config: OpenteamsConfig = {
      ...baseGsdConfig,
      "x-openswarm": { topology: "peer-team" },
    };
    const spec = openteamsToTeamSpec(config);
    // Even though topology.root is set, the extension wins.
    expect(spec.topology).toBe("peer-team");
    // Non-coordinator path: members track roles list order, no root reordering.
    expect(spec.members.map((m) => m.role)).toEqual([
      "lead",
      "researcher",
      "implementer",
    ]);
  });

  it("plumbs communication block through to coordination.communication", () => {
    const config: OpenteamsConfig = {
      ...baseGsdConfig,
      communication: {
        enforcement: "strict",
        channels: { workflow: { signals: ["DONE"] } },
      },
    };
    const spec = openteamsToTeamSpec(config);
    expect(spec.coordination.communication?.enforcement).toBe("strict");
    expect(
      spec.coordination.communication?.channels?.workflow?.signals,
    ).toEqual(["DONE"]);
  });

  it("throws when there are no roles", () => {
    const config: OpenteamsConfig = { name: "empty", roles: [] };
    expect(() => openteamsToTeamSpec(config)).toThrow(/no roles/);
  });

  it("uses fallback prompt for roles without a per-role prompt", () => {
    const config: OpenteamsConfig = {
      name: "partial-prompts",
      roles: ["lead", "implementer"],
      topology: { root: { role: "lead" } },
      rolePrompts: { lead: "Custom lead prompt" },
    };
    const spec = openteamsToTeamSpec(config);
    expect(spec.members[0]?.prompt).toBe("Custom lead prompt");
    expect(spec.members[1]?.prompt).toBe(
      "You are the implementer of team partial-prompts.",
    );
  });

  it("x-openswarm.coordination overrides the default completion rule", () => {
    const config: OpenteamsConfig = {
      ...baseGsdConfig,
      "x-openswarm": {
        coordination: { completion: { kind: "any" } },
      },
    };
    const spec = openteamsToTeamSpec(config);
    expect(spec.coordination.completion).toEqual({ kind: "any" });
  });

  it("x-openswarm.coordination merges aggregator + idleTimeoutMs over defaults", () => {
    const config: OpenteamsConfig = {
      ...baseGsdConfig,
      "x-openswarm": {
        coordination: {
          aggregator: { kind: "concat", separator: "\n---\n" },
          idleTimeoutMs: 30_000,
        },
      },
    };
    const spec = openteamsToTeamSpec(config);
    // Default completion preserved when not overridden.
    expect(spec.coordination.completion).toEqual({ kind: "all" });
    expect(spec.coordination.aggregator).toEqual({
      kind: "concat",
      separator: "\n---\n",
    });
    expect(spec.coordination.idleTimeoutMs).toBe(30_000);
  });

  it("coordinator topology with root-only spawn rules still produces a single-member team", () => {
    const config: OpenteamsConfig = {
      name: "solo",
      roles: ["lead"],
      topology: { root: { role: "lead" }, spawn_rules: { lead: [] } },
    };
    const spec = openteamsToTeamSpec(config);
    expect(spec.topology).toBe("coordinator");
    expect(spec.members).toEqual([
      { role: "lead", prompt: "You are the lead of team solo." },
    ]);
  });
});
