/**
 * docs-sync.ts — `FX-CLAIM-001`: the manifest and the documents cannot drift apart.
 *
 * docs/67 states this gate as "public capability claims without an ID fail documentation
 * validation". The literal reading needs a definition of "claim", which is why this module enforces
 * three things instead of one:
 *
 *   1. Every `DDP-*` and `WP-*` identifier cited in any document resolves in the manifest. This is
 *      the check that fires in practice, because renaming or dropping an ID leaves citations behind.
 *   2. The docs/67 capability contract and verification tables agree with the manifest, field for
 *      field. Without this the manifest is a second source of truth rather than a checkable one.
 *   3. Text inside a `parity:claims` block must cite an ID. The block is opt-in, and no document
 *      uses one yet — `WP-32`'s claims audit is where public copy gets bound. The mechanism exists
 *      now so that audit has something to enforce with, and `claimBlockCount` is reported so "no
 *      claims are bound yet" stays visible instead of passing silently.
 *
 * Everything here is a pure function over document text; file reading belongs to the caller.
 */
import type { Violation } from "./validate.js";
import { CAPABILITIES } from "./capabilities.js";
import { WORK_PACKAGES } from "./work-packages.js";
import { expandFixtures } from "./contracts.js";

/** A parsed capability-contract row. */
export interface DocCapability {
  readonly outcome: string;
  readonly betaEvidence: string;
}

/** A parsed verification-contract row. */
export interface DocVerification {
  readonly cell: string;
  readonly fixtures: readonly string[];
}

/**
 * Normalizes table prose for comparison: drops backticks and collapses whitespace. The documents
 * mark up identifiers such as `/resume` and `unverified` inline; the manifest stores plain prose,
 * and neither should have to imitate the other's formatting to compare equal.
 */
export function normalizeProse(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** Parses every `| \`DDP-*\` | outcome | beta evidence |` row in a document. */
export function parseCapabilityTables(
  markdown: string,
): Map<string, DocCapability> {
  const out = new Map<string, DocCapability>();
  for (const line of markdown.split("\n")) {
    const cells = tableCells(line);
    if (cells.length !== 3) continue;
    const id = /^`(DDP-[A-Z]+-\d{2})`$/.exec(cells[0] ?? "");
    if (id === null) continue;
    out.set(id[1]!, {
      outcome: normalizeProse(cells[1] ?? ""),
      betaEvidence: normalizeProse(cells[2] ?? ""),
    });
  }
  return out;
}

/**
 * Parses the per-work-package verification table, taking the cell from the command itself rather
 * than a separate column — the command is what someone actually runs, so it is the authority on
 * which cell a row describes.
 */
export function parseVerificationTable(
  markdown: string,
): Map<string, DocVerification> {
  const out = new Map<string, DocVerification>();
  for (const line of markdown.split("\n")) {
    const cells = tableCells(line);
    if (cells.length !== 4) continue;
    const id = /^`(WP-\d{2}[a-z]?)`$/.exec(cells[0] ?? "");
    if (id === null) continue;
    const command = cells[1] ?? "";
    const invocation = new RegExp(
      `verify-parity-wp\\.sh\\s+${id[1]}\\s+([A-Za-z0-9-]+)`,
    ).exec(command);
    if (invocation === null) continue;
    const fixtures = [...(cells[2] ?? "").matchAll(/`(FX-[A-Z0-9-]+-\d{3}(?:\.\.\d{3})?)`/g)].map(
      (m) => m[1]!,
    );
    out.set(id[1]!, { cell: invocation[1]!, fixtures });
  }
  return out;
}

/** Every `DDP-*` and `WP-*` identifier mentioned anywhere in a document. */
export function citedIds(markdown: string): {
  capabilities: Set<string>;
  workPackages: Set<string>;
} {
  const capabilities = new Set(
    [...markdown.matchAll(/\bDDP-[A-Z]+-\d{2}\b/g)].map((m) => m[0]),
  );
  const workPackages = new Set(
    [...markdown.matchAll(/\bWP-\d{2}[a-z]?\b/g)].map((m) => m[0]),
  );
  return { capabilities, workPackages };
}

const CLAIM_OPEN = "<!-- parity:claims -->";
const CLAIM_CLOSE = "<!-- /parity:claims -->";

export interface ClaimLine {
  readonly text: string;
  readonly citedCapabilities: readonly string[];
}

/**
 * Extracts claim lines from `parity:claims` blocks. Only non-empty, non-heading lines count as
 * claims; a block's prose scaffolding is not a claim needing an ID.
 */
export function parseClaimBlocks(markdown: string): ClaimLine[] {
  const claims: ClaimLine[] = [];
  let inside = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line === CLAIM_OPEN) {
      inside = true;
      continue;
    }
    if (line === CLAIM_CLOSE) {
      inside = false;
      continue;
    }
    if (!inside || line === "" || line.startsWith("#")) continue;
    claims.push({
      text: line,
      citedCapabilities: [...line.matchAll(/\bDDP-[A-Z]+-\d{2}\b/g)].map(
        (m) => m[0],
      ),
    });
  }
  return claims;
}

export interface DocsInput {
  /** Contents of docs/67, the document of record for the capability and verification contracts. */
  readonly roadmap: string;
  /** Every other document to scan for citations and claim blocks, keyed by path. */
  readonly others: Readonly<Record<string, string>>;
}

export interface DocsSyncResult {
  readonly violations: readonly Violation[];
  /** How many claim lines are bound to an ID. Zero is expected until `WP-32`. */
  readonly claimBlockCount: number;
}

export function checkDocsSync(input: DocsInput): DocsSyncResult {
  const violations: Violation[] = [];
  const knownCaps = new Set(CAPABILITIES.map((c) => c.id));
  const knownWps = new Set(WORK_PACKAGES.map((wp) => wp.id));

  // 1. Citations resolve, in the roadmap and everywhere else.
  const documents: Record<string, string> = {
    "docs/67-product-parity-roadmap.md": input.roadmap,
    ...input.others,
  };
  for (const [file, text] of Object.entries(documents)) {
    const cited = citedIds(text);
    for (const id of cited.capabilities) {
      if (!knownCaps.has(id)) {
        violations.push({
          check: "doc-citation-resolves",
          subject: `${file}: ${id}`,
          message: "document cites a capability that is not in the manifest",
        });
      }
    }
    for (const id of cited.workPackages) {
      if (!knownWps.has(id)) {
        violations.push({
          check: "doc-citation-resolves",
          subject: `${file}: ${id}`,
          message: "document cites a work package that is not in the manifest",
        });
      }
    }
  }

  // 2. The roadmap's capability contract matches the manifest.
  const documented = parseCapabilityTables(input.roadmap);
  for (const cap of CAPABILITIES) {
    const row = documented.get(cap.id);
    if (row === undefined) {
      violations.push({
        check: "doc-capability-documented",
        subject: cap.id,
        message: "capability is in the manifest but not in the docs/67 contract table",
      });
      continue;
    }
    if (row.outcome !== normalizeProse(cap.outcome)) {
      violations.push({
        check: "doc-capability-outcome",
        subject: cap.id,
        message: `outcome differs\n    docs: ${row.outcome}\n    code: ${normalizeProse(cap.outcome)}`,
      });
    }
    if (row.betaEvidence !== normalizeProse(cap.betaEvidence)) {
      violations.push({
        check: "doc-capability-evidence",
        subject: cap.id,
        message: `beta evidence differs\n    docs: ${row.betaEvidence}\n    code: ${normalizeProse(cap.betaEvidence)}`,
      });
    }
  }
  for (const id of documented.keys()) {
    if (!knownCaps.has(id)) {
      violations.push({
        check: "doc-capability-documented",
        subject: id,
        message: "docs/67 documents a capability the manifest does not define",
      });
    }
  }

  // 3. The roadmap's verification contract matches the work-package registry.
  const verification = parseVerificationTable(input.roadmap);
  for (const wp of WORK_PACKAGES) {
    const row = verification.get(wp.id);
    if (row === undefined) {
      // WP-00a was inserted after the table was written; it is verified through the
      // same script and is recorded in the roadmap prose instead of the table.
      if (wp.id === "WP-00a") continue;
      violations.push({
        check: "doc-verification-documented",
        subject: wp.id,
        message: "work package has no row in the docs/67 verification table",
      });
      continue;
    }
    if (!wp.cells.includes(row.cell as never)) {
      violations.push({
        check: "doc-verification-cell",
        subject: `${wp.id}/${row.cell}`,
        message: `docs/67 runs ${wp.id} in a cell the manifest does not declare (${wp.cells.join(", ")})`,
      });
    }
    const declared = new Set(expandFixtures(wp.fixtures));
    for (const fixture of expandFixtures(row.fixtures)) {
      if (!declared.has(fixture)) {
        violations.push({
          check: "doc-verification-fixture",
          subject: `${wp.id}/${fixture}`,
          message: "docs/67 names a fixture the manifest does not declare",
        });
      }
    }
  }

  // 4. Claims inside a parity:claims block must cite an ID.
  let claimBlockCount = 0;
  for (const [file, text] of Object.entries(documents)) {
    for (const claim of parseClaimBlocks(text)) {
      claimBlockCount += 1;
      if (claim.citedCapabilities.length === 0) {
        violations.push({
          check: "claim-cites-capability",
          subject: `${file}: ${claim.text.slice(0, 60)}`,
          message: "public capability claim cites no DDP-* identifier",
        });
      }
    }
  }

  return { violations, claimBlockCount };
}
