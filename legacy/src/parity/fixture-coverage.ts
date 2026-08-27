/**
 * fixture-coverage.ts — does the evidence a package declares actually exist?
 *
 * `validate.ts` checks that the manifest is internally consistent, and deliberately reads no files.
 * That leaves one class of disguise it cannot see through: a package can name fixtures nobody ever
 * wrote, and every structural check passes because the reference is well-formed. The manifest agrees
 * with itself and disagrees with the repository.
 *
 * This is the half that reads the tree, so it lives beside `status.ts` rather than inside
 * `validate.ts`, and follows the same rule — reading is confined to `scanTree`, everything else is a
 * pure function over what it found.
 *
 * Two invariants, opposite in direction, which is what makes `WorkPackage.owes` falsifiable rather
 * than decorative:
 *
 *   - a gated package's declared fixtures must all exist, or its gate is proving less than it claims;
 *   - an *owed* fixture must not exist, so the commit that writes the evidence is the commit that has
 *     to move the entry out of `owes`.
 *
 * Fixture references are matched as written, ranges included, because that is how the tree cites
 * them: `WP-03` covers twenty path shapes in one generated corpus whose header names
 * `FX-PATH-001..020`, and demanding twenty separate literals would fail a package whose evidence is
 * real. Expanding both sides and comparing sets is what makes the two notations comparable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import type { WorkPackage, WorkPackageId } from "./contracts.js";
import { expandFixtures } from "./contracts.js";
import { WORK_PACKAGES } from "./work-packages.js";
import type { Violation } from "./validate.js";

/** Any fixture reference, single or range, as the tree spells them. */
const FIXTURE_PATTERN = /FX-[A-Z0-9-]*[A-Z]-\d+(?:\.\.\d+)?/g;

/** Where a gate branch begins in `scripts/verify-parity-wp.sh`. */
const GATE_CASE_PATTERN = /^\s{2}(WP-[0-9a-z]+)\)/gm;

export interface TreeScan {
  /** Every fixture id mentioned anywhere outside the manifest itself. */
  readonly covered: ReadonlySet<string>;
  /** Packages with a real branch in the gate script. */
  readonly gated: ReadonlySet<string>;
}

/**
 * The manifest and the roadmap are excluded from the scan.
 *
 * Both name every fixture that exists or is planned, so including them would make every reference
 * self-satisfying: `owes` would be violated the instant it was populated, and a declared fixture
 * would count as written because the manifest declared it. Only files that could *implement* a
 * fixture are evidence that one exists.
 */
function isEvidenceFile(file: string): boolean {
  if (file.startsWith("src/parity/") || file.startsWith("docs/")) return false;
  return /\.(ts|tsx|sh)$/.test(file);
}

/** The one function here that touches disk. */
export function scanTree(root: string): TreeScan {
  const listed = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => f !== "");

  const refs = new Set<string>();
  for (const file of listed.filter(isEvidenceFile)) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, file), "utf8");
    } catch {
      // A listed-but-unreadable file is absent evidence, which the caller already
      // reports; throwing here would hide every other package's real state.
      continue;
    }
    for (const match of text.matchAll(FIXTURE_PATTERN)) refs.add(match[0]);
  }

  const script = fs.readFileSync(path.join(root, "scripts/verify-parity-wp.sh"), "utf8");
  const gated = new Set<string>();
  for (const match of script.matchAll(GATE_CASE_PATTERN)) gated.add(match[1]!);

  return { covered: new Set(expandFixtures([...refs])), gated };
}

/**
 * Whether a package's scope is closed: gated, and owing nothing.
 *
 * The distinction `gateImplemented` alone cannot draw. A dependent needs to know that the work is
 * *done*, not that some of it is proven, and reading a passing gate as a finished package is what let
 * `WP-12` become schedulable before anything recorded the facts it projects.
 */
export function isComplete(wp: WorkPackage): boolean {
  return wp.gateImplemented && (wp.owes ?? []).length === 0;
}

export function completePackages(
  packages: readonly WorkPackage[] = WORK_PACKAGES,
): ReadonlySet<WorkPackageId> {
  return new Set(packages.filter(isComplete).map((wp) => wp.id));
}

/** Pure: the violations implied by a scan. */
export function coverageViolations(
  scan: TreeScan,
  packages: readonly WorkPackage[] = WORK_PACKAGES,
): Violation[] {
  const violations: Violation[] = [];

  for (const wp of packages) {
    if (wp.gateImplemented) {
      const missing = expandFixtures(wp.fixtures).filter((id) => !scan.covered.has(id));
      if (missing.length > 0) {
        violations.push({
          check: "declared-fixture-missing",
          subject: wp.id,
          message:
            `gate is marked built but ${missing.length} declared fixture(s) exist nowhere in the tree ` +
            `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}); ` +
            `either write them, or move them to \`owes\``,
        });
      }
    }

    const owed = expandFixtures(wp.owes ?? []);
    const written = owed.filter((id) => scan.covered.has(id));
    if (written.length > 0) {
      violations.push({
        check: "owed-fixture-already-written",
        subject: wp.id,
        message:
          `${written.length} fixture(s) listed as owed already exist ` +
          `(${written.slice(0, 5).join(", ")}${written.length > 5 ? ", …" : ""}); ` +
          `move them from \`owes\` to \`fixtures\``,
      });
    }

    const overlap = expandFixtures(wp.fixtures).filter((id) => owed.includes(id));
    if (overlap.length > 0) {
      violations.push({
        check: "fixture-both-declared-and-owed",
        subject: wp.id,
        message: `${overlap.join(", ")} appear in both \`fixtures\` and \`owes\``,
      });
    }

    // `gateImplemented` is a claim about a shell script, so it is checked against the shell script.
    // It used to be checked against a hand-maintained array in a test — a claim about a claim, in the
    // file whose job was to stop exactly that.
    const hasBranch = scan.gated.has(wp.id);
    if (wp.gateImplemented !== hasBranch) {
      violations.push({
        check: "gate-implemented-mismatch",
        subject: wp.id,
        message: hasBranch
          ? "scripts/verify-parity-wp.sh has a branch for this package but `gateImplemented` is false"
          : "`gateImplemented` is true but scripts/verify-parity-wp.sh has no branch for this package",
      });
    }
  }

  return violations;
}
