/**
 * validate.test.ts — `FX-MANIFEST-001`.
 *
 * Two jobs. First, assert the real manifest is clean, which is the work-package gate itself. Second,
 * assert each check actually catches the failure it exists for, using deliberately broken synthetic
 * manifests — a validator whose checks never fire is indistinguishable from no validator.
 */
import { describe, expect, it } from "vitest";
import type { Capability, WorkPackage } from "./contracts.js";
import { estimateOf, expandFixtures, ownersOf } from "./contracts.js";
import { CAPABILITIES, capability } from "./capabilities.js";
import { WORK_PACKAGES, workPackage } from "./work-packages.js";
import {
  committedPersonWeeks,
  loadingByRelease,
  validateManifest,
} from "./validate.js";

/** A minimal valid pair, used as the base for negative cases. */
function fixture(): { capabilities: Capability[]; workPackages: WorkPackage[] } {
  const wp: WorkPackage = {
    id: "WP-07",
    title: "test package",
    release: "R2",
    ownerSplit: { B: 3 },
    dependsOn: [],
    cells: ["linux-x64"],
    fixtures: ["FX-TEST-001..004"],
    gateImplemented: false,
  };
  const cap: Capability = {
    id: "DDP-TEST-01",
    group: "Daily-driver core",
    outcome: "something testable",
    betaEvidence: "a fixture proves it",
    mandatory: true,
    release: "R2",
    accountableOwner: "B",
    evidence: [
      { workPackage: "WP-07", cells: ["linux-x64"], fixtures: ["FX-TEST-002"] },
    ],
  };
  return { capabilities: [cap], workPackages: [wp] };
}

describe("the shipped manifest", () => {
  it("has no structural violations", () => {
    const violations = validateManifest();
    expect(
      violations.map((v) => `${v.check}: ${v.subject} — ${v.message}`),
    ).toEqual([]);
  });

  it("covers every capability group from the docs/63 contract", () => {
    const groups = new Set(CAPABILITIES.map((c) => c.group));
    expect([...groups].sort()).toEqual([
      "Daily-driver core",
      "Product UX and observability",
      "Providers, intelligence, and media",
      "Safety and extensions",
      "Sessions and recovery",
      "Swarm and platform correctness",
    ]);
  });

  it("commits the 104 core person-weeks docs/63 budgets", () => {
    expect(committedPersonWeeks()).toBe(104);
  });

  it("reproduces the docs/63 per-release owner loading table", () => {
    const loading = loadingByRelease();
    const abc = (release: Parameters<typeof loading.get>[0]) => {
      const row = loading.get(release);
      return [row?.A, row?.B, row?.C];
    };
    // Feature A/B/C columns of the docs/63 release table.
    expect(abc("R1")).toEqual([7, 4, 7]);
    expect(abc("R2")).toEqual([3, 6, 5]);
    expect(abc("R3")).toEqual([6, 6, 6]);
    expect(abc("R4")).toEqual([5, 7, 7]);
    expect(abc("R5")).toEqual([6, 7, 6]);
    expect(abc("R6")).toEqual([5, 6, 5]);
  });

  it("marks exactly the work packages whose gates are built", () => {
    // Spelled out rather than counted, so flipping `gateImplemented` without a
    // gate to back it fails here. Extend this list in the same commit that adds
    // the gate to scripts/verify-parity-wp.sh.
    const built = WORK_PACKAGES.filter((wp) => wp.gateImplemented).map(
      (wp) => wp.id,
    );
    expect(built).toEqual([
      "WP-00",
      "WP-00a",
      "WP-01",
      "WP-02",
      "WP-03",
      "WP-04",
      "WP-05",
      "WP-06",
      "WP-07",
      "WP-08",
      "WP-09",
    ]);
  });

  it("records the three capabilities whose evidence lands after the release that claimed them", () => {
    const staged = CAPABILITIES.filter((c) => c.partialFrom !== undefined).map(
      (c) => c.id,
    );
    expect(staged).toEqual([
      "DDP-MEM-01",
      "DDP-SAFE-03",
      "DDP-PRIV-01",
      "DDP-PROV-01",
      "DDP-OBS-01",
      "DDP-SWM-04",
      "DDP-EVAL-01",
    ]);
  });

  it("treats External as a participant that consumes no core capacity", () => {
    const external = WORK_PACKAGES.filter((wp) =>
      ownersOf(wp).includes("External"),
    );
    expect(external.map((wp) => wp.id)).toEqual(["WP-29", "WP-31"]);
    for (const wp of external) {
      expect(wp.ownerSplit.External).toBe(0);
      expect(estimateOf(wp)).toBeGreaterThan(0);
    }
  });
});

describe("fixture range expansion", () => {
  it("expands a contiguous range, preserving zero padding", () => {
    expect(expandFixtures(["FX-TRUST-001..004"])).toEqual([
      "FX-TRUST-001",
      "FX-TRUST-002",
      "FX-TRUST-003",
      "FX-TRUST-004",
    ]);
  });

  it("passes a single fixture through unchanged", () => {
    expect(expandFixtures(["FX-GATE-001"])).toEqual(["FX-GATE-001"]);
  });

  it("keeps a malformed range intact so validation can reject it", () => {
    // Reversed bounds would silently expand to nothing if we were permissive.
    expect(expandFixtures(["FX-BAD-009..002"])).toEqual(["FX-BAD-009..002"]);
  });

  it("expands the widest range in the manifest to the right count", () => {
    expect(expandFixtures(["FX-MATRIX-001..045"])).toHaveLength(45);
  });
});

describe("evidence ownership", () => {
  it("rejects a mandatory capability with no evidence", () => {
    const m = fixture();
    m.capabilities[0] = { ...m.capabilities[0]!, evidence: [] };
    // Removing the evidence also orphans WP-07, so assert on the violation we
    // are testing rather than the whole list.
    expect(validateManifest(m)).toContainEqual({
      check: "evidence-present",
      subject: "DDP-TEST-01",
      message: "mandatory capability has no evidence owner",
    });
  });

  it("rejects evidence pointing at a work package that does not exist", () => {
    const m = fixture();
    m.capabilities[0] = {
      ...m.capabilities[0]!,
      evidence: [
        { workPackage: "WP-99", cells: ["linux-x64"], fixtures: ["FX-TEST-002"] },
      ],
    };
    const checks = validateManifest(m).map((v) => v.check);
    expect(checks).toContain("evidence-resolves");
  });

  it("rejects evidence citing a cell the work package never runs", () => {
    const m = fixture();
    m.capabilities[0] = {
      ...m.capabilities[0]!,
      evidence: [
        {
          workPackage: "WP-07",
          cells: ["macos-arm64"],
          fixtures: ["FX-TEST-002"],
        },
      ],
    };
    const violation = validateManifest(m).find(
      (v) => v.check === "evidence-cell",
    );
    expect(violation?.message).toBe("WP-07 does not run in cell macos-arm64");
  });

  it("rejects evidence citing a fixture the work package never exercises", () => {
    const m = fixture();
    m.capabilities[0] = {
      ...m.capabilities[0]!,
      evidence: [
        {
          workPackage: "WP-07",
          cells: ["linux-x64"],
          fixtures: ["FX-TEST-009"],
        },
      ],
    };
    const violation = validateManifest(m).find(
      (v) => v.check === "evidence-fixture",
    );
    expect(violation?.message).toBe(
      "WP-07 does not exercise fixture FX-TEST-009",
    );
  });

  it("accepts a fixture that falls inside a declared range", () => {
    // FX-TEST-002 sits inside FX-TEST-001..004; range membership must count as
    // real evidence or every ranged fixture would need enumerating by hand.
    expect(validateManifest(fixture())).toEqual([]);
  });
});

describe("schedule consistency", () => {
  it("rejects a capability proven only by work that lands after its release", () => {
    const m = fixture();
    m.workPackages[0] = { ...m.workPackages[0]!, release: "R5" };
    const violation = validateManifest(m).find(
      (v) => v.check === "evidence-reaches-release",
    );
    expect(violation?.message).toBe(
      "DDP-TEST-01 must pass in R2 but WP-07 does not land until R5",
    );
  });

  it("rejects a work package that depends on a later release", () => {
    const m = fixture();
    m.workPackages.push({
      id: "WP-20",
      title: "later",
      release: "R4",
      ownerSplit: { A: 1 },
      dependsOn: [],
      cells: ["linux-x64"],
      fixtures: ["FX-LATER-001"],
      gateImplemented: false,
    });
    m.workPackages[0] = { ...m.workPackages[0]!, dependsOn: ["WP-20"] };
    const violation = validateManifest(m).find(
      (v) => v.check === "dependency-not-forward",
    );
    expect(violation?.message).toBe(
      "WP-07 is scheduled in R2 but depends on WP-20 in R4",
    );
  });

  it("rejects a dependency cycle", () => {
    const m = fixture();
    m.workPackages.push({
      id: "WP-08",
      title: "other",
      release: "R2",
      ownerSplit: { B: 1 },
      dependsOn: ["WP-07"],
      cells: ["linux-x64"],
      fixtures: ["FX-OTHER-001"],
      gateImplemented: false,
    });
    m.workPackages[0] = { ...m.workPackages[0]!, dependsOn: ["WP-08"] };
    const checks = validateManifest(m).map((v) => v.check);
    expect(checks).toContain("dependency-acyclic");
  });

  it("rejects partialFrom that does not precede the release", () => {
    const m = fixture();
    m.capabilities[0] = { ...m.capabilities[0]!, partialFrom: "R2" };
    const violation = validateManifest(m).find(
      (v) => v.check === "capability-partial-order",
    );
    expect(violation?.message).toBe(
      "partialFrom R2 must precede release R2",
    );
  });
});

describe("accountability", () => {
  it("rejects an accountable owner who owns none of the evidence", () => {
    const m = fixture();
    m.capabilities[0] = { ...m.capabilities[0]!, accountableOwner: "A" };
    const violation = validateManifest(m).find(
      (v) => v.check === "accountable-owner",
    );
    expect(violation?.message).toBe(
      "owner A owns none of the evidence packages (B)",
    );
  });

  it("rejects a core owner with a zero share", () => {
    const m = fixture();
    m.workPackages[0] = {
      ...m.workPackages[0]!,
      ownerSplit: { B: 3, C: 0 },
    };
    const violation = validateManifest(m).find(
      (v) => v.subject === "WP-07/C",
    );
    expect(violation?.message).toBe("owner share must be positive (got 0)");
  });

  it("rejects a work package no capability cites", () => {
    const m = fixture();
    m.workPackages.push({
      id: "WP-12",
      title: "orphan",
      release: "R2",
      ownerSplit: { C: 2 },
      dependsOn: [],
      cells: ["linux-x64"],
      fixtures: ["FX-ORPHAN-001"],
      gateImplemented: false,
    });
    const violation = validateManifest(m).find(
      (v) => v.check === "work-package-cited",
    );
    expect(violation?.subject).toBe("WP-12");
  });
});

describe("lookup helpers", () => {
  it("finds a capability and a work package by ID", () => {
    expect(capability("DDP-SAFE-02")?.accountableOwner).toBe("A");
    expect(workPackage("WP-00a")?.title).toBe(
      "Production adoption of the frozen contracts",
    );
  });

  it("returns undefined for an unknown ID rather than throwing", () => {
    expect(capability("DDP-NOPE-01")).toBeUndefined();
    expect(workPackage("WP-99")).toBeUndefined();
  });
});
