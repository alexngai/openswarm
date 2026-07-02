/**
 * stale-branch — compare a branch's freshness against a main ref.
 *
 * Ported from claw's `rust/crates/runtime/src/stale_branch.rs`. Claw's
 * `missing_fix_subjects` does NOT filter commits by regex; it returns every
 * non-empty subject line in the `main..branch` range. We mirror that here.
 *
 * `mainRef` fallback chain: explicit arg → `origin/main` → `main` →
 * `origin/master` → `master`. Throws if none resolve.
 *
 * `applyPolicy` maps a Freshness + PolicyKind to a PolicyIntent. Intent only —
 * no rebase/merge is actually performed here (same as claw).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Freshness =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "stale";
      readonly commitsBehind: number;
      readonly missingFixes: readonly string[];
    }
  | {
      readonly kind: "diverged";
      readonly ahead: number;
      readonly behind: number;
      readonly missingFixes: readonly string[];
    };

export type PolicyKind =
  | "AutoRebase"
  | "AutoMergeForward"
  | "WarnOnly"
  | "Block";

export type PolicyIntent =
  | { readonly kind: "Noop" }
  | { readonly kind: "Warn"; readonly message: string }
  | { readonly kind: "Block"; readonly reason: string }
  | { readonly kind: "Rebase" }
  | { readonly kind: "MergeForward" };

export interface CheckOptions {
  readonly cwd?: string;
}

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

export async function check(
  branch: string,
  mainRef?: string,
  opts: CheckOptions = {},
): Promise<Freshness> {
  const cwd = opts.cwd ?? process.cwd();
  const resolvedMain = mainRef ?? (await resolveMainRef(cwd));

  const behind = await revListCount(resolvedMain, branch, cwd);
  const ahead = await revListCount(branch, resolvedMain, cwd);

  if (behind === 0 && ahead === 0) {
    return { kind: "fresh" };
  }
  if (behind === 0 && ahead > 0) {
    // Branch is ahead but not behind — fresh (nothing upstream to catch up on).
    return { kind: "fresh" };
  }
  if (behind > 0 && ahead > 0) {
    const missingFixes = await missingFixSubjects(resolvedMain, branch, cwd);
    return { kind: "diverged", ahead, behind, missingFixes };
  }
  // behind > 0 && ahead === 0
  const missingFixes = await missingFixSubjects(resolvedMain, branch, cwd);
  return { kind: "stale", commitsBehind: behind, missingFixes };
}

// ---------------------------------------------------------------------------
// applyPolicy
// ---------------------------------------------------------------------------

export function applyPolicy(
  freshness: Freshness,
  policy: PolicyKind,
): PolicyIntent {
  if (freshness.kind === "fresh") {
    return { kind: "Noop" };
  }
  if (freshness.kind === "stale") {
    switch (policy) {
      case "AutoRebase":
        return { kind: "Rebase" };
      case "AutoMergeForward":
        return { kind: "MergeForward" };
      case "WarnOnly":
        return {
          kind: "Warn",
          message: `Branch is ${freshness.commitsBehind} commit(s) behind main. Missing fixes: ${formatFixes(freshness.missingFixes)}`,
        };
      case "Block":
        return {
          kind: "Block",
          reason: `Branch is ${freshness.commitsBehind} commit(s) behind main and must be updated before proceeding.`,
        };
    }
  }
  // diverged
  switch (policy) {
    case "AutoRebase":
      return { kind: "Rebase" };
    case "AutoMergeForward":
      return { kind: "MergeForward" };
    case "WarnOnly":
      return {
        kind: "Warn",
        message: `Branch has diverged: ${freshness.ahead} commit(s) ahead, ${freshness.behind} commit(s) behind main. Missing fixes: ${formatFixes(freshness.missingFixes)}`,
      };
    case "Block":
      return {
        kind: "Block",
        reason: `Branch has diverged (${freshness.ahead} ahead, ${freshness.behind} behind) and must be reconciled before proceeding. Missing fixes: ${formatFixes(freshness.missingFixes)}`,
      };
  }
}

function formatFixes(fixes: readonly string[]): string {
  return fixes.length === 0 ? "(none)" : fixes.join("; ");
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

async function revListCount(a: string, b: string, cwd: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", `${b}..${a}`],
      { cwd },
    );
    const n = parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function missingFixSubjects(
  a: string,
  b: string,
  cwd: string,
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--format=%s", `${b}..${a}`],
      { cwd },
    );
    return stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/** Resolve `mainRef` — try origin/main, main, origin/master, master in order. */
export async function resolveMainRef(cwd: string): Promise<string> {
  const candidates = ["origin/main", "main", "origin/master", "master"];
  for (const ref of candidates) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd });
      return ref;
    } catch {
      // try next
    }
  }
  throw new Error(
    "stale-branch: could not resolve a main ref (tried origin/main, main, origin/master, master)",
  );
}
