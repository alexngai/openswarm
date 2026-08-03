/**
 * status.test.ts — capability status is derived, and cannot be talked up.
 *
 * The cases that matter are the ones where an artifact says "pass" but the pass should not count:
 * produced at another commit, or produced from a dirty tree. Those are how an evidence ledger
 * quietly starts lying.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Capability } from "./contracts.js";
import type { ArtifactRecord } from "./status.js";
import {
  artifactKey,
  readArtifacts,
  reportAll,
  statusOf,
  owingPackages,
  summarize,
} from "./status.js";
import { CAPABILITIES } from "./capabilities.js";

const CAP: Capability = {
  id: "DDP-TEST-01",
  group: "Daily-driver core",
  outcome: "two gates must both pass",
  betaEvidence: "both gates pass",
  mandatory: true,
  release: "R2",
  accountableOwner: "B",
  evidence: [
    { workPackage: "WP-00", cells: ["linux-x64"], fixtures: ["FX-A-001"] },
    { workPackage: "WP-07", cells: ["linux-x64"], fixtures: ["FX-B-001"] },
  ],
};

function index(
  ...records: readonly Partial<ArtifactRecord>[]
): Map<string, ArtifactRecord> {
  const map = new Map<string, ArtifactRecord>();
  for (const partial of records) {
    const record: ArtifactRecord = {
      workPackage: "WP-00",
      cell: "linux-x64",
      result: "pass",
      commit: "abc123",
      workingTreeDirty: false,
      ...partial,
    };
    map.set(artifactKey(record.workPackage, record.cell), record);
  }
  return map;
}

describe("derived capability status", () => {
  it("is verified only when every gate passed", () => {
    const report = statusOf(
      CAP,
      index({ workPackage: "WP-00" }, { workPackage: "WP-07" }),
    );
    expect(report.status).toBe("verified");
  });

  it("is unproven when one gate never ran", () => {
    const report = statusOf(CAP, index({ workPackage: "WP-00" }));
    expect(report.status).toBe("unproven");
    expect(report.evidence.map((e) => e.state)).toEqual(["pass", "missing"]);
  });

  it("is failing when a gate ran and failed, even if the other passed", () => {
    const report = statusOf(
      CAP,
      index(
        { workPackage: "WP-00" },
        { workPackage: "WP-07", result: "fail" },
      ),
    );
    expect(report.status).toBe("failing");
  });

  it("treats an unimplemented gate as unproven, not failing", () => {
    // The distinction is real: nobody has written the check yet, which is
    // different from having written it and watched it fail.
    const report = statusOf(
      CAP,
      index(
        { workPackage: "WP-00" },
        { workPackage: "WP-07", result: "not-implemented" },
      ),
    );
    expect(report.status).toBe("unproven");
    expect(report.evidence[1]?.state).toBe("not-implemented");
  });

  it("does not count a pass recorded at a different commit", () => {
    const report = statusOf(
      CAP,
      index({ workPackage: "WP-00" }, { workPackage: "WP-07" }),
      { atCommit: "def456" },
    );
    expect(report.status).toBe("unproven");
    expect(report.evidence.map((e) => e.state)).toEqual(["stale", "stale"]);
  });

  it("counts a pass at the requested commit", () => {
    const report = statusOf(
      CAP,
      index({ workPackage: "WP-00" }, { workPackage: "WP-07" }),
      { atCommit: "abc123" },
    );
    expect(report.status).toBe("verified");
  });

  it("does not count a pass produced from a dirty working tree", () => {
    const report = statusOf(
      CAP,
      index(
        { workPackage: "WP-00" },
        { workPackage: "WP-07", workingTreeDirty: true },
      ),
    );
    expect(report.status).toBe("unproven");
    expect(report.evidence[1]?.state).toBe("dirty");
  });

  it("can be asked to accept a dirty tree for local runs", () => {
    const report = statusOf(
      CAP,
      index(
        { workPackage: "WP-00" },
        { workPackage: "WP-07", workingTreeDirty: true },
      ),
      { requireCleanTree: false },
    );
    expect(report.status).toBe("verified");
  });

  it("prefers the dirty objection over the stale one", () => {
    const report = statusOf(
      CAP,
      index(
        { workPackage: "WP-00", workingTreeDirty: true },
        { workPackage: "WP-07" },
      ),
      { atCommit: "def456" },
    );
    expect(report.evidence[0]?.state).toBe("dirty");
  });

  it("expands multi-cell evidence into one entry per cell", () => {
    const multi: Capability = {
      ...CAP,
      evidence: [
        {
          workPackage: "WP-00",
          cells: ["linux-x64", "macos-arm64"],
          fixtures: ["FX-A-001"],
        },
      ],
    };
    const report = statusOf(multi, index({ workPackage: "WP-00" }));
    expect(report.evidence).toHaveLength(2);
    expect(report.evidence.map((e) => e.state)).toEqual(["pass", "missing"]);
  });
});

describe("the whole ledger", () => {
  it("reports every shipped capability as unproven against an empty index", () => {
    const reports = reportAll(new Map());
    expect(reports).toHaveLength(CAPABILITIES.length);
    expect(summarize(reports)).toEqual({
      verified: 0,
      failing: 0,
      unproven: CAPABILITIES.length,
    });
  });
});

describe("reading artifacts from disk", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "parity-status-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function write(wp: string, cell: string, body: unknown): void {
    fs.mkdirSync(path.join(root, wp), { recursive: true });
    fs.writeFileSync(
      path.join(root, wp, `${cell}.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }

  it("indexes artifacts by work package and cell", () => {
    write("WP-00", "linux-x64", {
      work_package: "WP-00",
      cell: "linux-x64",
      result: "pass",
      commit: "abc",
      working_tree_dirty: false,
    });
    const loaded = readArtifacts(root);
    expect(loaded.get("WP-00/linux-x64")?.result).toBe("pass");
  });

  it("returns an empty index when the directory does not exist", () => {
    expect(readArtifacts(path.join(root, "absent")).size).toBe(0);
  });

  it("skips a truncated artifact instead of failing the whole report", () => {
    write("WP-00", "linux-x64", '{"work_package": "WP-00", "cel');
    write("WP-07", "linux-x64", {
      work_package: "WP-07",
      cell: "linux-x64",
      result: "pass",
      commit: "abc",
      working_tree_dirty: false,
    });
    const loaded = readArtifacts(root);
    expect([...loaded.keys()]).toEqual(["WP-07/linux-x64"]);
  });

  it("skips an artifact missing the fields status depends on", () => {
    write("WP-00", "linux-x64", { result: "pass" });
    expect(readArtifacts(root).size).toBe(0);
  });

  it("defaults an absent commit to unknown rather than dropping the artifact", () => {
    write("WP-00", "linux-x64", {
      work_package: "WP-00",
      cell: "linux-x64",
      result: "pass",
    });
    expect(readArtifacts(root).get("WP-00/linux-x64")?.commit).toBe("unknown");
  });

  it("ignores non-JSON files such as the per-check log directory", () => {
    fs.mkdirSync(path.join(root, "WP-00", "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "WP-00", "logs", "E1.log"), "output");
    expect(readArtifacts(root).size).toBe(0);
  });
});

describe("evidence from a package that owes fixtures", () => {
  it("is not verified, even though both gates passed", () => {
    // The state that had no representation before `owes`: the gates ran, they
    // passed, and the package that owns them says outright that it is unfinished.
    // Reading that as verified is how a capability comes to rest on a surface that
    // does not implement it.
    const report = statusOf(
      CAP,
      index({ workPackage: "WP-00" }, { workPackage: "WP-07" }),
      { owing: new Set(["WP-07"]) },
    );
    expect(report.status).toBe("unproven");
    expect(report.evidence.map((e) => e.state)).toEqual(["pass", "owed"]);
  });

  it("still reports a failure as a failure", () => {
    // `owed` must never mask a fail: an unfinished package is the milder problem,
    // and a gate that ran and failed is the one to act on first.
    const report = statusOf(
      CAP,
      index({ workPackage: "WP-00" }, { workPackage: "WP-07", result: "fail" }),
      { owing: new Set(["WP-07"]) },
    );
    expect(report.status).toBe("failing");
    expect(report.evidence.map((e) => e.state)).toEqual(["pass", "fail"]);
  });

  it("defaults to the packages the manifest says are owing", () => {
    // No injected set, so the default is consulted. Guards the wiring: a default
    // that silently resolved to empty would make every assertion above vacuous in
    // production while passing here.
    expect([...owingPackages()].sort()).toEqual(["WP-00a", "WP-08", "WP-11"]);
  });
});
