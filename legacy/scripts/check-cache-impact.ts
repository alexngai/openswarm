#!/usr/bin/env bun
/**
 * check-cache-impact.ts — TE-27 cache-impact gate (docs/55).
 *
 * Reasonix treats the cacheable request prefix as a hard, CI-enforced invariant: any change to a
 * cache-sensitive path must re-prove byte-stability before it ships. This is the lightweight adoption
 * — no PR-body ritual (docs/55 open question resolved "guard test in CI is enough"), just a focused,
 * ATTRIBUTED gate: when a diff touches a cache-sensitive file, run the byte-stability (TE-23) and
 * cache-accounting (TE-22) guards and fail loudly if the invariant broke. When the diff touches
 * nothing cache-sensitive, it's a no-op (the general suite already ran the same tests) — so the gate
 * adds signal, not latency, on the PRs that matter.
 *
 * Run (CI): BASE_REF=<base sha|ref> bun scripts/check-cache-impact.ts
 * Run (local, vs main): bun scripts/check-cache-impact.ts
 *
 * The pure classifier (isCacheSensitive / classifyChanges) is exported and unit-tested in
 * test/cache-impact.test.ts; the git/spawn orchestration runs only as the entrypoint.
 */
import { execFileSync } from "node:child_process";

/**
 * Paths whose bytes end up in (or reshape) the cached request prefix: the transports that serialize
 * it, the shared assembly modules (message replay, tool translation), the compaction path that
 * rebuilds it, the system-prompt/prompt-cache sources, and the tool specs (their JSON schema is part
 * of the prefix). Matched against repo-relative POSIX paths.
 */
export const CACHE_SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^src\/engine\/compact.*\.ts$/, // compact-prompts / compact-rebuild / compact-remote / compaction-runner / compactor
  /^src\/engine\/microcompact\.ts$/,
  /^src\/engine\/default-system-prompt\.ts$/,
  /^src\/engine\/prompt-cache\.ts$/,
  /^src\/providers\/[a-z0-9-]+-transport\.ts$/, // azure/openai/xai/google/dashscope/litellm transports
  /^src\/providers\/message-replay\.ts$/,
  /^src\/providers\/tool-translation\.ts$/,
  /^src\/tools\/.*\.ts$/, // tool specs — their schema bytes ride in the prefix
];

/** The guard test itself: a change here means someone touched the invariant's definition — flag it. */
const GUARD_TEST_PATH = /^src\/providers\/prefix-stability\.test\.ts$/;

/**
 * True when a changed path can move the cacheable prefix. Test files are excluded (they don't ship in
 * the prefix) EXCEPT the byte-stability guard itself — weakening the guard is exactly what we want the
 * gate to surface for review.
 */
export function isCacheSensitive(path: string): boolean {
  if (GUARD_TEST_PATH.test(path)) return true;
  if (/\.test\.ts$/.test(path)) return false;
  return CACHE_SENSITIVE_PATTERNS.some((re) => re.test(path));
}

export function classifyChanges(files: readonly string[]): { impacted: string[] } {
  return { impacted: files.filter(isCacheSensitive) };
}

/** The invariants a cache-sensitive change must re-prove: byte-stability (TE-23) + cache math (TE-22). */
export const GUARD_TESTS: readonly string[] = [
  "src/providers/prefix-stability.test.ts", // TE-23 — the cacheable prefix is byte-stable across turns
  "src/engine/prompt-cache.test.ts", // prompt-cache fingerprint determinism
  "src/core/efficiency-report.test.ts", // TE-22 — cache%/ctx-turn/$ math
];

/** Files changed on HEAD since its merge-base with `base`. Fail-safe: on any git error, return null so
 *  the caller runs the guards anyway (never skip the invariant because a ref was unavailable). */
function changedFiles(base: string): string[] | null {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function main(): void {
  const base = process.env.BASE_REF || process.env.GITHUB_BASE_REF || "origin/main";
  const files = changedFiles(base);

  if (files === null) {
    console.warn(`cache-impact: could not diff against "${base}" — running guards fail-safe.`);
    runGuards();
    return;
  }

  const { impacted } = classifyChanges(files);
  if (impacted.length === 0) {
    console.log(
      `cache-impact: no cache-sensitive paths in this diff (vs ${base}); ` +
        "byte-stability guard not required (the general suite already covered it).",
    );
    return;
  }

  console.log(`cache-impact: ${impacted.length} cache-sensitive file(s) changed:`);
  for (const f of impacted) console.log(`  • ${f}`);
  console.log("\nRe-proving the cacheable-prefix invariants (TE-23 byte-stability + TE-22 cache math)…\n");
  runGuards();
  console.log("\ncache-impact: PASS — the cacheable prefix stays byte-stable under this change.");
}

function runGuards(): void {
  try {
    execFileSync("npx", ["vitest", "run", ...GUARD_TESTS], { stdio: "inherit" });
  } catch {
    console.error(
      "\ncache-impact: FAIL — a cache-sensitive change broke a byte-stability/cache-accounting " +
        "invariant (TE-23/TE-22). Restore the byte-stable prefix, or update the guard deliberately " +
        "(and say so in the PR).",
    );
    process.exit(1);
  }
}

// Entrypoint only — importing this module (e.g. from the unit test) must not run git or spawn vitest.
if (import.meta.main) main();
