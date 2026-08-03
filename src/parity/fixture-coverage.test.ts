/**
 * FX-MANIFEST-002 — the evidence a package declares exists, and the evidence it
 * owes does not (docs/67 `WP-01`).
 *
 * `FX-MANIFEST-001` proves the manifest agrees with itself. This proves it agrees
 * with the repository, which is a different question and the one that went wrong:
 * three packages reached a passing gate with work still outstanding, the
 * remainder lived in prose, and `parity-ready.ts` handed their dependents a green
 * light because a dependency check cannot read a paragraph.
 *
 * The unit tests below run against synthetic manifests, because a check that only
 * ever sees a passing corpus is not known to fail. The last two run against the
 * real tree and the real gate script.
 */

import { describe, it, expect } from "vitest";

import {
  coverageViolations,
  isComplete,
  scanTree,
  type TreeScan,
} from "./fixture-coverage.js";
import { WORK_PACKAGES } from "./work-packages.js";
import type { WorkPackage } from "./contracts.js";

const pkg = (over: Partial<WorkPackage>): WorkPackage =>
  ({
    id: "WP-00",
    title: "t",
    release: "R1",
    ownerSplit: { A: 1 },
    dependsOn: [],
    cells: ["linux-x64"],
    fixtures: [],
    gateImplemented: false,
    ...over,
  }) as WorkPackage;

const scan = (covered: string[], gated: string[] = []): TreeScan => ({
  covered: new Set(covered),
  gated: new Set(gated),
});

describe("declared evidence must exist", () => {
  it("flags a gated package whose fixture was never written", () => {
    const v = coverageViolations(scan([], ["WP-00"]), [
      pkg({ fixtures: ["FX-GHOST-001"], gateImplemented: true }),
    ]);
    expect(v.map((x) => x.check)).toContain("declared-fixture-missing");
  });

  it("accepts a range citation for the ids it covers", () => {
    // How the tree actually cites a corpus: `WP-03` proves twenty path shapes in
    // one generated test whose header names the range. Demanding twenty literals
    // would fail a package whose evidence is real.
    const v = coverageViolations(
      scan(["FX-PATH-001", "FX-PATH-002", "FX-PATH-003"], ["WP-00"]),
      [pkg({ fixtures: ["FX-PATH-001..003"], gateImplemented: true })],
    );
    expect(v.filter((x) => x.check === "declared-fixture-missing")).toEqual([]);
  });

  it("says nothing about an ungated package's fixtures", () => {
    // They are planned, not owed. Every unbuilt package names the fixtures it will
    // have, and demanding they exist would make the manifest unable to describe
    // future work.
    const v = coverageViolations(scan([]), [
      pkg({ fixtures: ["FX-FUTURE-001"], gateImplemented: false }),
    ]);
    expect(v).toEqual([]);
  });
});

describe("owed evidence must not exist", () => {
  it("flags an owed fixture that has already been written", () => {
    // The direction that makes `owes` self-maintaining: the commit that writes the
    // evidence is the commit that has to move the entry, or this fails.
    const v = coverageViolations(scan(["FX-AUDIT-020"], ["WP-00"]), [
      pkg({ owes: ["FX-AUDIT-020"], gateImplemented: true }),
    ]);
    expect(v.map((x) => x.check)).toContain("owed-fixture-already-written");
  });

  it("flags a fixture that is both declared and owed", () => {
    const v = coverageViolations(scan(["FX-X-001"], ["WP-00"]), [
      pkg({ fixtures: ["FX-X-001"], owes: ["FX-X-001"], gateImplemented: true }),
    ]);
    expect(v.map((x) => x.check)).toContain("fixture-both-declared-and-owed");
  });

  it("does not treat owing as incomplete evidence", () => {
    const p = pkg({ fixtures: ["FX-X-001"], owes: ["FX-X-002"], gateImplemented: true });
    expect(coverageViolations(scan(["FX-X-001"], ["WP-00"]), [p])).toEqual([]);
    // Consistent but unfinished, which is exactly the state that had no
    // representation before.
    expect(isComplete(p)).toBe(false);
  });
});

describe("gateImplemented is checked against the script", () => {
  it("flags a package claiming a gate the script does not have", () => {
    const v = coverageViolations(scan([], []), [pkg({ gateImplemented: true })]);
    expect(v.map((x) => x.check)).toContain("gate-implemented-mismatch");
  });

  it("flags a script branch the manifest does not admit to", () => {
    const v = coverageViolations(scan([], ["WP-00"]), [pkg({ gateImplemented: false })]);
    expect(v.map((x) => x.check)).toContain("gate-implemented-mismatch");
  });
});

describe("the real tree", () => {
  it("satisfies every coverage invariant", () => {
    const violations = coverageViolations(scanTree(process.cwd()));
    expect(violations.map((v) => `${v.check} ${v.subject}: ${v.message}`)).toEqual([]);
  }, 60_000);

  it("finds the fixtures and gates it claims to check", () => {
    // Guards the scan itself. A regex that matched nothing would satisfy every
    // assertion above by vacuously covering nothing and gating nothing.
    const found = scanTree(process.cwd());
    expect(found.covered.size).toBeGreaterThan(100);
    expect(found.gated.size).toBe(WORK_PACKAGES.filter((w) => w.gateImplemented).length);
    expect(found.covered.has("FX-AUDIT-001")).toBe(true);
    // Owed by WP-00a, so it must not be found; this is the assertion that fails
    // when someone writes the ACP fixture and forgets to move the entry.
    expect(found.covered.has("FX-AUDIT-020")).toBe(false);
  }, 60_000);
});
