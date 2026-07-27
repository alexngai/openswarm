/**
 * docs-sync.test.ts — `FX-CLAIM-001`.
 *
 * The checks run against the real manifest, so the negative cases are expressed as synthetic
 * documents. The real docs are covered by `bun scripts/check-parity-manifest.ts` in CI and by the
 * `WP-01` parity gate.
 */
import { describe, expect, it } from "vitest";
import {
  checkDocsSync,
  citedIds,
  normalizeProse,
  parseCapabilityTables,
  parseClaimBlocks,
  parseVerificationTable,
} from "./docs-sync.js";
import { capability } from "./capabilities.js";
import { workPackage } from "./work-packages.js";

/** A roadmap fragment that agrees with the manifest for the IDs it mentions. */
function agreeingRoadmap(ids: readonly string[]): string {
  const rows = ids.map((id) => {
    const cap = capability(id)!;
    return `| \`${cap.id}\` | ${cap.outcome} | ${cap.betaEvidence} |`;
  });
  return ["| ID | Required outcome | Beta evidence |", "|---|---|---|", ...rows].join(
    "\n",
  );
}

describe("prose normalization", () => {
  it("ignores inline code markup and whitespace differences", () => {
    expect(normalizeProse("Ten turns retain results without  `/resume`")).toBe(
      "Ten turns retain results without /resume",
    );
  });

  it("preserves the typographic minus used in the −5-point bound", () => {
    expect(normalizeProse("clears the −5-point bound")).toContain("−5-point");
  });
});

describe("capability table parsing", () => {
  it("reads ID, outcome, and beta evidence from a three-column row", () => {
    const parsed = parseCapabilityTables(
      "| `DDP-CORE-01` | Do the thing | A fixture proves it |",
    );
    expect(parsed.get("DDP-CORE-01")).toEqual({
      outcome: "Do the thing",
      betaEvidence: "A fixture proves it",
    });
  });

  it("ignores rows that are not capability rows", () => {
    const parsed = parseCapabilityTables(
      [
        "| Release | Weeks | Total |",
        "|---|---:|---:|",
        "| R1 | 1–9 | 27 |",
        "| `WP-00` | something | else |",
      ].join("\n"),
    );
    expect(parsed.size).toBe(0);
  });
});

describe("verification table parsing", () => {
  it("takes the cell from the command rather than a separate column", () => {
    const parsed = parseVerificationTable(
      "| `WP-10` | `./scripts/verify-parity-wp.sh WP-10 linux-x64-pty` | `FX-TUI-KEYS-001..014` | Zero dropped input |",
    );
    expect(parsed.get("WP-10")).toEqual({
      cell: "linux-x64-pty",
      fixtures: ["FX-TUI-KEYS-001..014"],
    });
  });

  it("skips a row whose command does not invoke that work package", () => {
    // Guards against a copy-paste error in the table naming the wrong package.
    const parsed = parseVerificationTable(
      "| `WP-11` | `./scripts/verify-parity-wp.sh WP-10 linux-x64` | `FX-RW-001..012` | x |",
    );
    expect(parsed.size).toBe(0);
  });
});

describe("citation scanning", () => {
  it("finds capability and work-package IDs in running prose", () => {
    const cited = citedIds("See `DDP-SAFE-02`, delivered by WP-03 and WP-00a.");
    expect([...cited.capabilities]).toEqual(["DDP-SAFE-02"]);
    expect([...cited.workPackages].sort()).toEqual(["WP-00a", "WP-03"]);
  });

  it("rejects a citation that resolves to nothing", () => {
    const result = checkDocsSync({
      roadmap: agreeingRoadmap([]),
      others: { "docs/x.md": "We support DDP-MAGIC-01 today." },
    });
    expect(
      result.violations.some(
        (v) =>
          v.check === "doc-citation-resolves" &&
          v.subject === "docs/x.md: DDP-MAGIC-01",
      ),
    ).toBe(true);
  });

  it("rejects a citation of a work package that was never scheduled", () => {
    const result = checkDocsSync({
      roadmap: agreeingRoadmap([]),
      others: { "docs/x.md": "Tracked in WP-91." },
    });
    expect(
      result.violations.some(
        (v) => v.check === "doc-citation-resolves" && v.subject.endsWith("WP-91"),
      ),
    ).toBe(true);
  });
});

describe("manifest and roadmap agreement", () => {
  it("rejects an outcome that the roadmap states differently", () => {
    const cap = capability("DDP-SAFE-02")!;
    const roadmap = `| \`${cap.id}\` | Something else entirely | ${cap.betaEvidence} |`;
    const result = checkDocsSync({ roadmap, others: {} });
    const violation = result.violations.find(
      (v) => v.check === "doc-capability-outcome" && v.subject === cap.id,
    );
    expect(violation?.message).toContain("Something else entirely");
  });

  it("rejects a capability the roadmap documents but the manifest omits", () => {
    const roadmap = "| `DDP-GHOST-01` | Ghost | Nothing |";
    const result = checkDocsSync({ roadmap, others: {} });
    expect(
      result.violations.some(
        (v) =>
          v.check === "doc-capability-documented" && v.subject === "DDP-GHOST-01",
      ),
    ).toBe(true);
  });

  it("rejects a verification row naming a fixture the manifest does not declare", () => {
    const roadmap = [
      agreeingRoadmap([]),
      "| `WP-06` | `./scripts/verify-parity-wp.sh WP-06 linux-x64` | `FX-INVENTED-001` | x |",
    ].join("\n");
    const result = checkDocsSync({ roadmap, others: {} });
    expect(
      result.violations.some(
        (v) => v.check === "doc-verification-fixture" && v.subject === "WP-06/FX-INVENTED-001",
      ),
    ).toBe(true);
  });

  it("accepts a verification row whose fixture sits inside a declared range", () => {
    const wp = workPackage("WP-02")!;
    expect(wp.fixtures).toEqual(["FX-TRUST-001..006"]);
    const roadmap = [
      agreeingRoadmap([]),
      "| `WP-02` | `./scripts/verify-parity-wp.sh WP-02 linux-x64` | `FX-TRUST-003` | x |",
    ].join("\n");
    const result = checkDocsSync({ roadmap, others: {} });
    expect(
      result.violations.filter((v) => v.subject.startsWith("WP-02/")),
    ).toEqual([]);
  });
});

describe("claim blocks", () => {
  const block = (body: string) =>
    ["<!-- parity:claims -->", body, "<!-- /parity:claims -->"].join("\n");

  it("counts a claim that cites an ID", () => {
    const claims = parseClaimBlocks(
      block("- Confines every file tool to the workspace (`DDP-SAFE-02`)."),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.citedCapabilities).toEqual(["DDP-SAFE-02"]);
  });

  it("ignores text outside the markers", () => {
    expect(parseClaimBlocks("- An unmarked marketing line.")).toEqual([]);
  });

  it("ignores blank lines and headings inside a block", () => {
    const claims = parseClaimBlocks(
      block("### Safety\n\n- Confined (`DDP-SAFE-02`)."),
    );
    expect(claims).toHaveLength(1);
  });

  it("rejects a claim inside a block that cites no ID", () => {
    const result = checkDocsSync({
      roadmap: agreeingRoadmap([]),
      others: { "README.md": block("- The fastest coding agent available.") },
    });
    const violation = result.violations.find(
      (v) => v.check === "claim-cites-capability",
    );
    expect(violation?.message).toBe(
      "public capability claim cites no DDP-* identifier",
    );
  });

  it("reports how many claims are bound so an empty ledger stays visible", () => {
    const result = checkDocsSync({
      roadmap: agreeingRoadmap([]),
      others: { "README.md": block("- Confined (`DDP-SAFE-02`).") },
    });
    expect(result.claimBlockCount).toBe(1);
    expect(
      result.violations.filter((v) => v.check === "claim-cites-capability"),
    ).toEqual([]);
  });
});
