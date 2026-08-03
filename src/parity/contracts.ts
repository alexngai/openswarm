/**
 * contracts.ts — types for the product-parity capability manifest (docs/67 `WP-01`).
 *
 * The manifest exists to stop one specific failure: a capability claim drifting away from the
 * evidence that is supposed to back it. Every mandatory capability carries a stable `DDP-*` ID,
 * an accountable owner, the release whose exit gate requires it, and — the part that does the
 * work — an explicit pointer at the work-package gate, verification cells, and fixtures that
 * prove it.
 *
 * The one thing deliberately absent from the declared data is status. A capability's status is
 * *derived* from the parity artifacts on disk (see `status.ts`), never asserted here, because a
 * hand-editable status field is exactly the marketing surface the manifest exists to remove.
 */

/**
 * Implementation owners. `A`, `B`, and `C` are the three core engineers in the docs/67 loading
 * model; `External` covers the security review and the UX/QA/soak vendors, whose work is bought
 * rather than scheduled against core capacity.
 */
export type Owner = "A" | "B" | "C" | "External";

export const OWNERS: readonly Owner[] = ["A", "B", "C", "External"];

/** The six staged releases. `R1` is weeks 1–9; `R6` ends in the parity beta. */
export type Release = "R1" | "R2" | "R3" | "R4" | "R5" | "R6";

export const RELEASES: readonly Release[] = ["R1", "R2", "R3", "R4", "R5", "R6"];

/**
 * Verification cells. A cell names *where* a gate runs, and it is part of the evidence: the same
 * work package passing on `linux-x64` and on `macos-arm64` are two different facts. Host-native
 * controls (Seatbelt, PTY, WSL2) cannot be proven from inside a Linux container, so those cells
 * name signed host runners even though the Compose service dispatches them.
 */
export type Cell =
  | "linux-x64"
  | "linux-arm64"
  | "macos-arm64"
  | "macos-x64"
  | "windows11-wsl2-x64"
  | "linux-x64-pty"
  | "linux-x64-load"
  | "linux-x64-git"
  | "linux-x64-team"
  | "provider-contract"
  | "lsp-matrix"
  | "image-matrix"
  | "surface-matrix"
  | "crypto-matrix"
  | "release-matrix"
  | "security-review"
  | "security-retest"
  | "soak-8h"
  | "migration-claims"
  | "release";

/**
 * The five platform targets of `DDP-PLAT-01`. Named as a group because `WP-25` must pass all five
 * or fail — an unavailable runner fails its cell rather than skipping it.
 */
export const PLATFORM_CELLS: readonly Cell[] = [
  "linux-x64",
  "linux-arm64",
  "macos-arm64",
  "macos-x64",
  "windows11-wsl2-x64",
];

/**
 * A fixture reference as docs/67 writes it, which includes contiguous ranges such as
 * `FX-TRUST-001..006`. Stored in the doc's own notation so the manifest and the roadmap can be
 * compared literally; use `expandFixtures` when concrete IDs are needed.
 */
export type FixtureRef = string;

/** A work-package identifier: `WP-00` through `WP-33`, plus the inserted adoption package `WP-00a`. */
export type WorkPackageId = string;

/** A capability identifier of the form `DDP-<AREA>-<NN>`. */
export type CapabilityId = string;

/**
 * A work package as scheduled in docs/67. `cells` and `fixtures` are the authoritative record of
 * what this package's gate covers, so a capability cannot claim evidence from a cell the package
 * never runs or a fixture it never exercises.
 */
export interface WorkPackage {
  readonly id: WorkPackageId;
  readonly title: string;
  readonly release: Release;
  /**
   * Core person-weeks per owner, as the docs/67 cross-owner split table states them. Stored per
   * owner rather than as a total plus an owner list because the splits are uneven (`WP-11` is A2/C1)
   * and because the per-owner totals are what the release loading table can be checked against.
   *
   * `External` may appear with zero weeks: the security review and the UX/QA vendors participate in
   * a package without drawing on core capacity, since their time is bought rather than scheduled.
   */
  readonly ownerSplit: Readonly<Partial<Record<Owner, number>>>;
  readonly dependsOn: readonly WorkPackageId[];
  readonly cells: readonly Cell[];
  readonly fixtures: readonly FixtureRef[];
  /**
   * Fixtures this package's contract includes and that nothing yet proves.
   *
   * A passing gate is not a finished package. Three packages reached `gateImplemented` while work
   * they owned was still outstanding, and because the manifest had nowhere to say so,
   * `scripts/parity-ready.ts` counted them as done and handed their dependents a green light —
   * which is how `WP-12` came to be schedulable on facts production did not yet record.
   *
   * Stated as fixtures rather than prose because `status.ts` is right that "anything else is a claim
   * about a claim": a `remainder: "ACP sink pending"` string is an assertion nobody can falsify, and
   * would rot exactly like the paragraph it replaced. An owed *fixture* is checkable in both
   * directions — `fixture-coverage.ts` requires that a gated package's declared fixtures all exist
   * in the tree, and that an owed one does not — so writing the evidence forces the entry to move
   * here-to-`fixtures` in the same commit, or CI fails.
   *
   * `Capability.partialFrom` is the same idea one level up: recorded so a partial pass can never be
   * read as a full one.
   */
  readonly owes?: readonly FixtureRef[];
  /**
   * Whether `scripts/verify-parity-wp.sh` has a real gate for this package. Declared rather than
   * probed so the manifest can be validated without a shell, and cross-checked against the script
   * by `fixture-coverage.ts` so the two cannot drift.
   */
  readonly gateImplemented: boolean;
}

/**
 * One evidence pointer: this work package, run in these cells, exercising these fixtures, is what
 * proves the capability. A capability with no evidence pointer fails validation — that is the
 * `WP-01` gate "CI fails when a mandatory ID has no evidence owner".
 */
export interface EvidenceRef {
  readonly workPackage: WorkPackageId;
  readonly cells: readonly Cell[];
  readonly fixtures: readonly FixtureRef[];
}

/** Thematic grouping, matching the docs/67 capability-contract subsections. */
export type CapabilityGroup =
  | "Daily-driver core"
  | "Sessions and recovery"
  | "Safety and extensions"
  | "Providers, intelligence, and media"
  | "Product UX and observability"
  | "Swarm and platform correctness";

export interface Capability {
  readonly id: CapabilityId;
  readonly group: CapabilityGroup;
  /** The required outcome, as the docs/67 capability contract states it. */
  readonly outcome: string;
  /** What the beta must show. Prose, because it is the human-readable acceptance statement. */
  readonly betaEvidence: string;
  /**
   * Every capability in this manifest is mandatory: a weighted average cannot hide a failed safety
   * or correctness capability. The field is explicit so that adding a non-mandatory capability
   * later is a visible decision rather than a silent one.
   */
  readonly mandatory: boolean;
  /** The release whose exit gate requires this capability to pass in full. */
  readonly release: Release;
  /**
   * Set when an earlier release requires a partial pass — docs/67 gates "initial `DDP-PROV-01`" at
   * R3 and the full capability at R5. Recorded so a partial pass can never be read as a full one.
   */
  readonly partialFrom?: Release;
  /** Single accountable owner. Validated to be one of the owners of the evidence work packages. */
  readonly accountableOwner: Owner;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * Expands docs/67 fixture notation into concrete IDs. `FX-TRUST-001..006` becomes six IDs;
 * a plain `FX-GATE-001` passes through. Non-numeric suffixes are returned as-is rather than
 * silently dropped, so a malformed reference surfaces in validation instead of vanishing.
 */
export function expandFixtures(refs: readonly FixtureRef[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const range = /^(.*?)(\d+)\.\.(\d+)$/.exec(ref);
    if (range === null) {
      out.push(ref);
      continue;
    }
    const [, prefix, startRaw, endRaw] = range as unknown as [string, string, string, string];
    const start = Number(startRaw);
    const end = Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      out.push(ref);
      continue;
    }
    const width = startRaw.length;
    for (let n = start; n <= end; n += 1) {
      out.push(`${prefix}${String(n).padStart(width, "0")}`);
    }
  }
  return out;
}

/** True when `ref` is syntactically a fixture reference. Keeps typo detection out of the data. */
export function isFixtureRef(ref: string): boolean {
  return /^FX-[A-Z0-9-]+-\d{3}(\.\.\d{3})?$/.test(ref);
}

/** True when `id` is syntactically a capability ID. */
export function isCapabilityId(id: string): boolean {
  return /^DDP-[A-Z]+-\d{2}$/.test(id);
}

/** Ordinal position of a release, for "must not depend on a later release" checks. */
export function releaseIndex(release: Release): number {
  return RELEASES.indexOf(release);
}

/** Owners participating in a work package, in the canonical A/B/C/External order. */
export function ownersOf(wp: WorkPackage): Owner[] {
  return OWNERS.filter((owner) => wp.ownerSplit[owner] !== undefined);
}

/** Core person-weeks for a work package: the sum of its owner split. */
export function estimateOf(wp: WorkPackage): number {
  return ownersOf(wp).reduce((sum, owner) => sum + (wp.ownerSplit[owner] ?? 0), 0);
}
