/**
 * validate.ts — structural checks over the parity manifest (`FX-MANIFEST-001`).
 *
 * docs/67 states the `WP-01` gate as "CI fails when a mandatory ID has no evidence owner". Taken
 * literally that is one check; taken usefully it is a family, because every way a capability can
 * *appear* to have evidence while having none is the same failure wearing a disguise: evidence that
 * points at a work package that does not exist, at a cell that package never runs, at a fixture it
 * never exercises, or at work scheduled after the release that is supposed to be proven by it.
 *
 * All checks are pure functions over the manifest so they can run in a unit test as well as in CI.
 * Nothing here reads the filesystem; artifact-derived status lives in `status.ts`.
 */
import type { Capability, Owner, Release, WorkPackage } from "./contracts.js";
import {
  estimateOf,
  expandFixtures,
  isCapabilityId,
  isFixtureRef,
  ownersOf,
  releaseIndex,
} from "./contracts.js";
import { CAPABILITIES } from "./capabilities.js";
import { WORK_PACKAGES } from "./work-packages.js";

export interface Violation {
  /** Stable machine-readable check name, so CI output can be diffed across runs. */
  readonly check: string;
  /** The manifest entity at fault. */
  readonly subject: string;
  readonly message: string;
}

export interface ManifestInput {
  readonly capabilities: readonly Capability[];
  readonly workPackages: readonly WorkPackage[];
}

const MANIFEST: ManifestInput = {
  capabilities: CAPABILITIES,
  workPackages: WORK_PACKAGES,
};

/** Runs every structural check. An empty result is the pass condition for `FX-MANIFEST-001`. */
export function validateManifest(input: ManifestInput = MANIFEST): Violation[] {
  return [
    ...checkWorkPackageIdentity(input),
    ...checkWorkPackageDependencies(input),
    ...checkCapabilityIdentity(input),
    ...checkEvidenceOwnership(input),
    ...checkEvidenceReachesRelease(input),
    ...checkAccountableOwnership(input),
    ...checkEveryWorkPackageIsCited(input),
  ];
}

/** Work-package IDs are unique, well formed, and carry a positive estimate. */
function checkWorkPackageIdentity({ workPackages }: ManifestInput): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const wp of workPackages) {
    if (!/^WP-\d{2}[a-z]?$/.test(wp.id)) {
      out.push({
        check: "work-package-id",
        subject: wp.id,
        message: "identifier must look like WP-00 or WP-00a",
      });
    }
    if (seen.has(wp.id)) {
      out.push({
        check: "work-package-id",
        subject: wp.id,
        message: "duplicate work-package identifier",
      });
    }
    seen.add(wp.id);

    if (estimateOf(wp) <= 0) {
      out.push({
        check: "work-package-estimate",
        subject: wp.id,
        message: "owner split must total a positive number of core person-weeks",
      });
    }
    if (ownersOf(wp).length === 0) {
      out.push({
        check: "work-package-owner",
        subject: wp.id,
        message: "work package has no owner",
      });
    }
    for (const owner of ownersOf(wp)) {
      const weeks = wp.ownerSplit[owner] ?? 0;
      // A core engineer with a zero share is not an owner; only bought external
      // time legitimately participates without consuming core capacity.
      if (weeks < 0 || (weeks === 0 && owner !== "External")) {
        out.push({
          check: "work-package-owner",
          subject: `${wp.id}/${owner}`,
          message: `owner share must be positive (got ${weeks})`,
        });
      }
    }
    if (wp.cells.length === 0) {
      out.push({
        check: "work-package-cell",
        subject: wp.id,
        message: "work package declares no verification cell",
      });
    }
    for (const fixture of wp.fixtures) {
      if (!isFixtureRef(fixture)) {
        out.push({
          check: "work-package-fixture",
          subject: `${wp.id}/${fixture}`,
          message: "fixture reference is malformed",
        });
      }
    }
  }
  return out;
}

/**
 * Dependencies resolve, do not cycle, and never point forward in the schedule. The forward check is
 * the one that earns its keep: a package cannot be gated by work that is not delivered until a later
 * release, and prose review missed exactly this class of error repeatedly.
 */
function checkWorkPackageDependencies({
  workPackages,
}: ManifestInput): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(workPackages.map((wp) => [wp.id, wp]));

  for (const wp of workPackages) {
    for (const dep of wp.dependsOn) {
      const target = byId.get(dep);
      if (target === undefined) {
        out.push({
          check: "dependency-resolves",
          subject: `${wp.id} -> ${dep}`,
          message: "dependency names an unknown work package",
        });
        continue;
      }
      if (releaseIndex(target.release) > releaseIndex(wp.release)) {
        out.push({
          check: "dependency-not-forward",
          subject: `${wp.id} -> ${dep}`,
          message: `${wp.id} is scheduled in ${wp.release} but depends on ${dep} in ${target.release}`,
        });
      }
    }
  }

  for (const wp of workPackages) {
    const cycle = findCycle(wp.id, byId);
    if (cycle !== undefined) {
      out.push({
        check: "dependency-acyclic",
        subject: wp.id,
        message: `dependency cycle: ${cycle.join(" -> ")}`,
      });
    }
  }
  return out;
}

function findCycle(
  start: string,
  byId: ReadonlyMap<string, WorkPackage>,
): string[] | undefined {
  const path: string[] = [];
  const onPath = new Set<string>();

  const walk = (id: string): string[] | undefined => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    const wp = byId.get(id);
    if (wp === undefined) return undefined;
    path.push(id);
    onPath.add(id);
    for (const dep of wp.dependsOn) {
      const found = walk(dep);
      if (found !== undefined) return found;
    }
    path.pop();
    onPath.delete(id);
    return undefined;
  };

  return walk(start);
}

/** Capability IDs are unique and well formed, and `partialFrom` precedes `release`. */
function checkCapabilityIdentity({ capabilities }: ManifestInput): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (!isCapabilityId(cap.id)) {
      out.push({
        check: "capability-id",
        subject: cap.id,
        message: "identifier must look like DDP-CORE-01",
      });
    }
    if (seen.has(cap.id)) {
      out.push({
        check: "capability-id",
        subject: cap.id,
        message: "duplicate capability identifier",
      });
    }
    seen.add(cap.id);

    if (cap.outcome.trim() === "" || cap.betaEvidence.trim() === "") {
      out.push({
        check: "capability-prose",
        subject: cap.id,
        message: "outcome and beta evidence must both be stated",
      });
    }
    if (
      cap.partialFrom !== undefined &&
      releaseIndex(cap.partialFrom) >= releaseIndex(cap.release)
    ) {
      out.push({
        check: "capability-partial-order",
        subject: cap.id,
        message: `partialFrom ${cap.partialFrom} must precede release ${cap.release}`,
      });
    }
  }
  return out;
}

/**
 * The gate docs/67 names: every mandatory capability must have evidence, and that evidence must
 * resolve to a real work package, real cells of that package, and real fixtures of that package.
 * An evidence pointer that does not resolve is indistinguishable from no evidence at all.
 */
function checkEvidenceOwnership({
  capabilities,
  workPackages,
}: ManifestInput): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(workPackages.map((wp) => [wp.id, wp]));

  for (const cap of capabilities) {
    if (cap.mandatory && cap.evidence.length === 0) {
      out.push({
        check: "evidence-present",
        subject: cap.id,
        message: "mandatory capability has no evidence owner",
      });
      continue;
    }

    for (const ref of cap.evidence) {
      const wp = byId.get(ref.workPackage);
      if (wp === undefined) {
        out.push({
          check: "evidence-resolves",
          subject: `${cap.id} -> ${ref.workPackage}`,
          message: "evidence names an unknown work package",
        });
        continue;
      }

      if (ref.cells.length === 0) {
        out.push({
          check: "evidence-cell",
          subject: `${cap.id} -> ${wp.id}`,
          message: "evidence names no verification cell",
        });
      }
      for (const cell of ref.cells) {
        if (!wp.cells.includes(cell)) {
          out.push({
            check: "evidence-cell",
            subject: `${cap.id} -> ${wp.id}/${cell}`,
            message: `${wp.id} does not run in cell ${cell}`,
          });
        }
      }

      if (ref.fixtures.length === 0) {
        out.push({
          check: "evidence-fixture",
          subject: `${cap.id} -> ${wp.id}`,
          message: "evidence names no fixture",
        });
      }
      const available = new Set(expandFixtures(wp.fixtures));
      for (const fixture of expandFixtures(ref.fixtures)) {
        if (!available.has(fixture)) {
          out.push({
            check: "evidence-fixture",
            subject: `${cap.id} -> ${wp.id}/${fixture}`,
            message: `${wp.id} does not exercise fixture ${fixture}`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * A capability cannot be proven by work that lands after the release whose exit gate claims it.
 * Encoding this check is what surfaced `DDP-SAFE-03`, `DDP-SWM-04`, and `DDP-PRIV-01`.
 */
function checkEvidenceReachesRelease({
  capabilities,
  workPackages,
}: ManifestInput): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(workPackages.map((wp) => [wp.id, wp]));

  for (const cap of capabilities) {
    for (const ref of cap.evidence) {
      const wp = byId.get(ref.workPackage);
      if (wp === undefined) continue; // already reported by checkEvidenceOwnership
      if (releaseIndex(wp.release) > releaseIndex(cap.release)) {
        out.push({
          check: "evidence-reaches-release",
          subject: `${cap.id} -> ${wp.id}`,
          message: `${cap.id} must pass in ${cap.release} but ${wp.id} does not land until ${wp.release}`,
        });
      }
    }
  }
  return out;
}

/** You cannot be accountable for a capability without owning some of the work that proves it. */
function checkAccountableOwnership({
  capabilities,
  workPackages,
}: ManifestInput): Violation[] {
  const out: Violation[] = [];
  const byId = new Map(workPackages.map((wp) => [wp.id, wp]));

  for (const cap of capabilities) {
    const owners = new Set<Owner>();
    for (const ref of cap.evidence) {
      const wp = byId.get(ref.workPackage);
      if (wp === undefined) continue;
      for (const owner of ownersOf(wp)) owners.add(owner);
    }
    if (owners.size > 0 && !owners.has(cap.accountableOwner)) {
      out.push({
        check: "accountable-owner",
        subject: cap.id,
        message: `owner ${cap.accountableOwner} owns none of the evidence packages (${[...owners].join(", ")})`,
      });
    }
  }
  return out;
}

/**
 * Every work package must prove at least one capability. A package no capability depends on is
 * either unnecessary work or a capability the manifest forgot to record; both are worth a failure.
 */
function checkEveryWorkPackageIsCited({
  capabilities,
  workPackages,
}: ManifestInput): Violation[] {
  const cited = new Set<string>();
  for (const cap of capabilities) {
    for (const ref of cap.evidence) cited.add(ref.workPackage);
  }
  // Three packages legitimately prove no product capability, because what they produce is release
  // quality rather than product behaviour: the external review, its remediation, and the release
  // train. Everything else must be required by something, and keeping this list to three is the
  // point — it is what surfaced WP-17 as work no capability had asked for.
  const releaseQuality = new Set(["WP-29", "WP-30", "WP-33"]);
  return workPackages
    .filter((wp) => !cited.has(wp.id) && !releaseQuality.has(wp.id))
    .map((wp) => ({
      check: "work-package-cited",
      subject: wp.id,
      message: "no capability cites this work package as evidence",
    }));
}

/**
 * Feature-package loading per release and owner. This is the manifest's half of the docs/67 loading
 * table; the test asserts the two agree, which is what makes the table's arithmetic checkable rather
 * than merely reviewed. Cross-package quality allocation is not modelled here — it is reassignable
 * between owners, so it is a scheduling decision rather than a property of a package.
 */
export function loadingByRelease(
  input: ManifestInput = MANIFEST,
): Map<Release, Record<Owner, number>> {
  const out = new Map<Release, Record<Owner, number>>();
  for (const wp of input.workPackages) {
    const perOwner =
      out.get(wp.release) ?? { A: 0, B: 0, C: 0, External: 0 };
    for (const owner of ownersOf(wp)) {
      perOwner[owner] += wp.ownerSplit[owner] ?? 0;
    }
    out.set(wp.release, perOwner);
  }
  return out;
}

/** Total committed core person-weeks across all work packages. */
export function committedPersonWeeks(input: ManifestInput = MANIFEST): number {
  return input.workPackages.reduce((sum, wp) => sum + estimateOf(wp), 0);
}
