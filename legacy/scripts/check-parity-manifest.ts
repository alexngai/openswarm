#!/usr/bin/env bun
/**
 * check-parity-manifest.ts — the `WP-01` gate (docs/67).
 *
 * docs/67 states two conditions: CI fails when a mandatory capability ID has no evidence owner
 * (`FX-MANIFEST-001`), and public capability claims without an ID fail documentation validation
 * (`FX-CLAIM-001`). Both are structural checks over `src/parity/`, which is where the capability
 * contract and the work-package schedule live as data.
 *
 * `FX-MANIFEST-002` is the third, added because the first two can only catch a manifest that
 * disagrees with itself. A package can name fixtures nobody wrote, or claim a gate the script does
 * not have, and every structural check passes because each reference is well-formed. That one reads
 * the tree, so it is the only check here that is not purely structural.
 *
 * Run:
 *   bun scripts/check-parity-manifest.ts            # both gates
 *   bun scripts/check-parity-manifest.ts --ledger   # derived capability status from artifacts
 *   bun scripts/check-parity-manifest.ts --json     # machine-readable
 *
 * The pure logic lives in src/parity/{validate,docs-sync,status}.ts and is unit-tested there; this
 * file is only the filesystem and reporting shell.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CAPABILITIES } from "../src/parity/capabilities.js";
import { WORK_PACKAGES } from "../src/parity/work-packages.js";
import { checkDocsSync } from "../src/parity/docs-sync.js";
import { committedPersonWeeks, validateManifest } from "../src/parity/validate.js";
import { expandFixtures } from "../src/parity/contracts.js";
import type { Violation } from "../src/parity/validate.js";
import { readArtifacts, reportAll, summarize } from "../src/parity/status.js";
import { coverageViolations, scanTree } from "../src/parity/fixture-coverage.js";
import { MINIMUM_PAIRS, validateEvalPlan } from "../src/parity/eval-plan.js";
import { evidenceEligibleModels } from "../src/parity/certification.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Every markdown document that may cite a capability or work-package ID. */
function documents(): Record<string, string> {
  const out: Record<string, string> = {};
  const roots = ["README.md", "AGENTS.md", "CLAUDE.md"];
  for (const rel of roots) {
    const abs = path.join(REPO_ROOT, rel);
    if (fs.existsSync(abs)) out[rel] = fs.readFileSync(abs, "utf8");
  }
  const docsDir = path.join(REPO_ROOT, "docs");
  for (const entry of walk(docsDir)) {
    const rel = path.relative(REPO_ROOT, entry);
    if (rel === "docs/67-product-parity-roadmap.md") continue; // passed separately as the roadmap
    out[rel] = fs.readFileSync(entry, "utf8");
  }
  return out;
}

function walk(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

function headCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function printViolations(label: string, violations: readonly Violation[]): void {
  if (violations.length === 0) {
    console.log(`  ${label}: pass`);
    return;
  }
  console.log(`  ${label}: ${violations.length} violation(s)`);
  for (const v of violations) {
    console.log(`    ${v.check}  ${v.subject}`);
    for (const line of v.message.split("\n")) console.log(`      ${line}`);
  }
}

function ledger(): void {
  const artifacts = readArtifacts(path.join(REPO_ROOT, "artifacts", "parity"));
  const reports = reportAll(artifacts, { atCommit: headCommit() });
  const counts = summarize(reports);

  console.log("Capability evidence ledger (against HEAD, clean tree required)");
  console.log(
    `  ${counts.verified} verified · ${counts.failing} failing · ${counts.unproven} unproven`,
  );
  console.log();
  for (const report of reports) {
    const detail = report.evidence
      .map((e) => `${e.workPackage}/${e.cell}=${e.state}`)
      .join(" ");
    console.log(`  ${report.status.padEnd(9)} ${report.id.padEnd(14)} ${detail}`);
  }
}

function main(): number {
  const args = new Set(process.argv.slice(2));

  const manifestViolations = validateManifest();
  const roadmapPath = path.join(
    REPO_ROOT,
    "docs",
    "67-product-parity-roadmap.md",
  );
  const docs = checkDocsSync({
    roadmap: fs.readFileSync(roadmapPath, "utf8"),
    others: documents(),
  });
  const planViolations = validateEvalPlan();
  const coverage = coverageViolations(scanTree(REPO_ROOT));
  const total =
    manifestViolations.length +
    docs.violations.length +
    planViolations.length +
    coverage.length;

  if (args.has("--json")) {
    console.log(
      JSON.stringify(
        {
          capabilities: CAPABILITIES.length,
          work_packages: WORK_PACKAGES.length,
          committed_person_weeks: committedPersonWeeks(),
          claim_lines_bound: docs.claimBlockCount,
          minimum_paired_instances: MINIMUM_PAIRS,
          evidence_eligible_models: evidenceEligibleModels(),
          manifest_violations: manifestViolations,
          docs_violations: docs.violations,
          eval_plan_violations: planViolations,
          coverage_violations: coverage,
        },
        null,
        2,
      ),
    );
    return total === 0 ? 0 : 1;
  }

  if (args.has("--ledger")) {
    ledger();
    return 0;
  }

  console.log("parity manifest");
  console.log(
    `  ${CAPABILITIES.length} capabilities · ${WORK_PACKAGES.length} work packages · ` +
      `${committedPersonWeeks()} committed person-weeks`,
  );
  printViolations("FX-MANIFEST-001 structural", manifestViolations);
  printViolations("FX-CLAIM-001 documentation", docs.violations);
  printViolations("FX-EVAL-PLAN-001 preregistration", planViolations);
  printViolations("FX-MANIFEST-002 evidence exists", coverage);
  console.log(
    `  claim lines bound to an ID: ${docs.claimBlockCount}` +
      (docs.claimBlockCount === 0
        ? " (expected until WP-32 binds public copy)"
        : ""),
  );
  console.log(
    `  minimum paired instances: ${MINIMUM_PAIRS} · ` +
      `evidence-eligible models: ${evidenceEligibleModels().length} ` +
      "(none until WP-16 certifies)",
  );
  const owing = WORK_PACKAGES.filter((wp) => (wp.owes ?? []).length > 0);
  if (owing.length > 0) {
    // Printed unconditionally rather than only on failure. Owing is a legal state,
    // and the reason it is legal is that it is visible.
    console.log(
      `  gated but owing evidence: ${owing
        .map((wp) => `${wp.id} (${expandFixtures(wp.owes ?? []).length})`)
        .join(", ")}`,
    );
  }

  return total === 0 ? 0 : 1;
}

process.exit(main());
