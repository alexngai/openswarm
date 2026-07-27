/**
 * status.ts — capability status derived from parity artifacts.
 *
 * The manifest deliberately has no status field. A capability is verified when the gates that prove
 * it have actually run and passed, and the only honest source for that is the artifacts
 * `scripts/verify-parity-wp.sh` writes to `artifacts/parity/<WP>/<cell>.json`. Anything else is a
 * claim about a claim.
 *
 * Two qualifiers matter for release evidence and are tracked separately from pass/fail, because both
 * describe artifacts that passed but should not count:
 *
 *   - *stale*: the artifact was produced at a different commit, so it says nothing about the code
 *     being shipped;
 *   - *dirty*: the artifact was produced from a modified working tree, so it is not reproducible.
 *
 * Reading the filesystem is confined to `readArtifacts`; everything else is a pure function over the
 * index so status derivation is testable without fixtures on disk.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Capability, Cell, WorkPackageId } from "./contracts.js";
import { CAPABILITIES } from "./capabilities.js";

/** A parity artifact, narrowed to the fields status derivation depends on. */
export interface ArtifactRecord {
  readonly workPackage: WorkPackageId;
  readonly cell: string;
  readonly result: "pass" | "fail" | "error" | "not-implemented" | string;
  readonly commit: string;
  readonly workingTreeDirty: boolean;
}

/** Artifacts keyed by `<WP>/<cell>`. */
export type ArtifactIndex = ReadonlyMap<string, ArtifactRecord>;

export function artifactKey(wp: WorkPackageId, cell: string): string {
  return `${wp}/${cell}`;
}

/**
 * Loads every artifact under `root`. Unreadable or malformed files are skipped rather than thrown on:
 * a corrupt artifact is absent evidence, which the caller already handles, and failing the whole
 * report because one file is truncated would hide the other capabilities' real state.
 */
export function readArtifacts(root: string): ArtifactIndex {
  const index = new Map<string, ArtifactRecord>();
  let packages: fs.Dirent[];
  try {
    packages = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return index;
  }

  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      } catch {
        continue;
      }
      const record = toRecord(parsed);
      if (record !== undefined) {
        index.set(artifactKey(record.workPackage, record.cell), record);
      }
    }
  }
  return index;
}

function toRecord(value: unknown): ArtifactRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const workPackage = raw["work_package"];
  const cell = raw["cell"];
  const result = raw["result"];
  if (
    typeof workPackage !== "string" ||
    typeof cell !== "string" ||
    typeof result !== "string"
  ) {
    return undefined;
  }
  return {
    workPackage,
    cell,
    result,
    commit: typeof raw["commit"] === "string" ? raw["commit"] : "unknown",
    workingTreeDirty: raw["working_tree_dirty"] === true,
  };
}

export type EvidenceState =
  | "pass"
  | "fail"
  | "not-implemented"
  | "missing"
  | "stale"
  | "dirty";

export interface EvidenceStatus {
  readonly workPackage: WorkPackageId;
  readonly cell: Cell;
  readonly state: EvidenceState;
}

/**
 * `verified` requires every piece of evidence to pass. `failing` means at least one gate ran and did
 * not pass — a strictly worse signal than never having run, so it wins. `unproven` covers gates that
 * are missing, unimplemented, stale, or dirty: all of them mean the same thing, which is that nobody
 * has shown this works on this code.
 */
export type CapabilityStatus = "verified" | "failing" | "unproven";

export interface CapabilityReport {
  readonly id: string;
  readonly status: CapabilityStatus;
  readonly evidence: readonly EvidenceStatus[];
}

export interface StatusOptions {
  /**
   * When set, an artifact from any other commit counts as stale. Release gates must set this;
   * local runs generally should not, or every uncommitted edit invalidates the whole ledger.
   */
  readonly atCommit?: string;
  /** When true, artifacts produced from a modified working tree do not count. Defaults to true. */
  readonly requireCleanTree?: boolean;
}

export function statusOf(
  cap: Capability,
  index: ArtifactIndex,
  options: StatusOptions = {},
): CapabilityReport {
  const requireCleanTree = options.requireCleanTree ?? true;
  const evidence: EvidenceStatus[] = [];

  for (const ref of cap.evidence) {
    for (const cell of ref.cells) {
      const record = index.get(artifactKey(ref.workPackage, cell));
      evidence.push({
        workPackage: ref.workPackage,
        cell,
        state: stateOf(record, options.atCommit, requireCleanTree),
      });
    }
  }

  const states = new Set(evidence.map((e) => e.state));
  const status: CapabilityStatus = states.has("fail")
    ? "failing"
    : evidence.length > 0 && states.size === 1 && states.has("pass")
      ? "verified"
      : "unproven";

  return { id: cap.id, status, evidence };
}

function stateOf(
  record: ArtifactRecord | undefined,
  atCommit: string | undefined,
  requireCleanTree: boolean,
): EvidenceState {
  if (record === undefined) return "missing";
  if (record.result === "not-implemented") return "not-implemented";
  if (record.result !== "pass") return "fail";
  // Order matters below: a dirty tree is the stronger objection, since a stale
  // artifact at least describes some identifiable commit.
  if (requireCleanTree && record.workingTreeDirty) return "dirty";
  if (atCommit !== undefined && record.commit !== atCommit) return "stale";
  return "pass";
}

export function reportAll(
  index: ArtifactIndex,
  options: StatusOptions = {},
  capabilities: readonly Capability[] = CAPABILITIES,
): CapabilityReport[] {
  return capabilities.map((cap) => statusOf(cap, index, options));
}

/** Counts by status, for a one-line summary. */
export function summarize(
  reports: readonly CapabilityReport[],
): Record<CapabilityStatus, number> {
  const out: Record<CapabilityStatus, number> = {
    verified: 0,
    failing: 0,
    unproven: 0,
  };
  for (const report of reports) out[report.status] += 1;
  return out;
}
