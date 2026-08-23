/**
 * stale-base — compare HEAD against a declared base commit.
 *
 * Expected-base source priority:
 *   1. `opts.expectedBase` (explicit)
 *   2. `<cwd>/.openswarm-base` file contents (trimmed)
 *   3. none — returns { kind: "no-expected-base" }
 *
 * `actual` = `git rev-parse HEAD`. A non-zero git exit surfaces as
 * `{ kind: "not-a-git-repo" }`.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type StaleBaseResult =
  | { readonly kind: "matches" }
  | { readonly kind: "diverged"; readonly expected: string; readonly actual: string }
  | { readonly kind: "no-expected-base" }
  | { readonly kind: "not-a-git-repo" };

export interface CheckOptions {
  readonly cwd?: string;
  readonly expectedBase?: string;
}

export async function check(opts: CheckOptions = {}): Promise<StaleBaseResult> {
  const cwd = opts.cwd ?? process.cwd();

  const expected = await resolveExpectedBase(opts.expectedBase, cwd);
  if (expected === undefined) {
    return { kind: "no-expected-base" };
  }

  let actual: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
    });
    actual = stdout.trim();
  } catch {
    return { kind: "not-a-git-repo" };
  }

  if (actual === expected) {
    return { kind: "matches" };
  }
  return { kind: "diverged", expected, actual };
}

async function resolveExpectedBase(
  override: string | undefined,
  cwd: string,
): Promise<string | undefined> {
  if (override !== undefined && override.length > 0) return override.trim();
  try {
    const raw = await fs.readFile(path.join(cwd, ".openswarm-base"), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns a human-readable warning for a diverged result, or null for the
 * three non-warning cases.
 */
export function formatWarning(result: StaleBaseResult): string | null {
  if (result.kind !== "diverged") return null;
  return `base diverged: expected ${result.expected}, got ${result.actual}`;
}
