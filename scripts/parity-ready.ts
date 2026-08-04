#!/usr/bin/env bun
/**
 * Reports which work packages are ready to start: every dependency is complete,
 * and this one is not. Ordering within a release is by how much the package
 * unblocks, so the head of a critical path sorts first.
 *
 * Complete means gated *and* owing no fixtures, which is not the same as having a
 * passing gate. Reading a green gate as a finished package is what let `WP-12`
 * become schedulable while nothing in production recorded the facts it projects:
 * `WP-00a` was gated, its remainder existed only as prose in docs/67, and a
 * dependency check could not see it. Packages with open obligations are listed
 * separately rather than hidden, because the work is real and someone owns it.
 */
import { WORK_PACKAGES } from "../src/parity/work-packages.js";
import { CAPABILITIES } from "../src/parity/capabilities.js";
import { estimateOf, expandFixtures, ownersOf } from "../src/parity/contracts.js";
import type { WorkPackageId } from "../src/parity/contracts.js";
import { completePackages, isComplete } from "../src/parity/fixture-coverage.js";

const byId = new Map(WORK_PACKAGES.map((w) => [w.id, w]));
const done = completePackages();
const owing = WORK_PACKAGES.filter((w) => w.gateImplemented && !isComplete(w));

/** Transitive count of packages that cannot start until `id` is delivered. */
function unblocks(id: WorkPackageId): number {
  const seen = new Set<WorkPackageId>();
  const queue: WorkPackageId[] = [id];
  while (queue.length > 0) {
    const head = queue.pop() as WorkPackageId;
    for (const w of WORK_PACKAGES) {
      if (w.dependsOn.includes(head) && !seen.has(w.id)) {
        seen.add(w.id);
        queue.push(w.id);
      }
    }
  }
  return seen.size;
}

function citedBy(id: WorkPackageId): string[] {
  return CAPABILITIES.filter((c) => c.evidence.some((e) => e.workPackage === id)).map((c) => c.id);
}

const ready = WORK_PACKAGES.filter(
  (w) => !done.has(w.id) && w.dependsOn.every((d) => done.has(d)),
).sort((a, b) => {
  const rel = a.release.localeCompare(b.release);
  return rel !== 0 ? rel : unblocks(b.id) - unblocks(a.id);
});

const blocked = WORK_PACKAGES.filter(
  (w) => !done.has(w.id) && !w.dependsOn.every((d) => done.has(d)),
);

// Packages that are gated but owing are counted in the span, not the weeks: their
// estimates were spent, and what is left has no separate estimate until someone
// gives it one. Saying "0 remaining" for a package with open fixtures is the
// overstatement this whole mechanism exists to stop.
const remaining = WORK_PACKAGES.filter((w) => !w.gateImplemented).reduce(
  (sum, w) => sum + estimateOf(w),
  0,
);

console.log(`complete ${done.size}/${WORK_PACKAGES.length} packages`);
console.log(`remaining ${remaining} person-weeks across ${blocked.length + ready.length}`);
if (owing.length > 0) {
  console.log(
    `gated but owing: ${owing.map((w) => `${w.id}(${expandFixtures(w.owes ?? []).length})`).join(" ")}`,
  );
}
console.log();

console.log("READY NOW");
for (const w of ready) {
  const owners = ownersOf(w).join("+");
  const caps = citedBy(w.id).join(" ") || "(structural)";
  // A gated package's estimate was spent getting it gated, so printing it beside
  // the finishing work would overstate what is left as badly as counting the
  // package done understated it. The owed fixture count is the honest figure
  // available; a re-estimate is a person's job, not this script's.
  const size = w.gateImplemented
    ? `owes ${String(expandFixtures(w.owes ?? []).length).padStart(2)}`
    : `${String(estimateOf(w)).padStart(2)}pw  `;
  console.log(
    `  ${w.id.padEnd(6)} ${w.release}  ${size}  ${owners.padEnd(6)}  unblocks ${String(unblocks(w.id)).padStart(2)}  ${w.title}`,
  );
  console.log(`         ${caps}`);
}

console.log("\nBLOCKED (next release heads only)");
for (const w of blocked.filter((w) => w.release <= "R2")) {
  const waiting = w.dependsOn.filter((d) => !done.has(d)).join(" ");
  console.log(
    `  ${w.id.padEnd(6)} ${w.release}  ${String(estimateOf(w)).padStart(2)}pw  waits on ${waiting}  ${w.title}`,
  );
}
