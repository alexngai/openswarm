#!/usr/bin/env bun
/**
 * Reports which work packages are ready to start: every dependency has a
 * built gate, and its own gate is not built yet. Ordering within a release
 * is by how much the package unblocks, so the head of a critical path sorts
 * first.
 */
import { WORK_PACKAGES } from "../src/parity/work-packages.js";
import { CAPABILITIES } from "../src/parity/capabilities.js";
import { estimateOf, ownersOf } from "../src/parity/contracts.js";
import type { WorkPackageId } from "../src/parity/contracts.js";

const byId = new Map(WORK_PACKAGES.map((w) => [w.id, w]));
const done = new Set(WORK_PACKAGES.filter((w) => w.gateImplemented).map((w) => w.id));

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

const remaining = WORK_PACKAGES.filter((w) => !done.has(w.id)).reduce(
  (sum, w) => sum + estimateOf(w),
  0,
);

console.log(`delivered ${done.size}/${WORK_PACKAGES.length} packages`);
console.log(`remaining ${remaining} person-weeks across ${blocked.length + ready.length}\n`);

console.log("READY NOW");
for (const w of ready) {
  const owners = ownersOf(w).join("+");
  const caps = citedBy(w.id).join(" ") || "(structural)";
  console.log(
    `  ${w.id.padEnd(6)} ${w.release}  ${String(estimateOf(w)).padStart(2)}pw  ${owners.padEnd(6)}  unblocks ${String(unblocks(w.id)).padStart(2)}  ${w.title}`,
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
