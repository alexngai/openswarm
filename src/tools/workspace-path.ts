/**
 * One containment check for the file-bearing tools.
 *
 * Seven tools each carried their own copy of the same three steps — resolve
 * against cwd, prefix-compare with `isUnderCwd`, then `realpath` only when the
 * leaf itself is a symlink — and six of the seven shared the same gap. A leaf
 * that is an ordinary file reached through a symlinked *parent* directory is
 * not a symlink, so the third step never runs and the path escapes.
 * `write_file` alone also resolved its parent, which is how it avoided the
 * problem, and is why the checks were never quite identical either.
 *
 * `canUseTool` now decides containment before a tool runs, so this is the
 * second of two checks rather than the only one. That redundancy is worth
 * keeping: the gate decides before execution, and a path can change underneath
 * it — a directory swapped for a symlink between decision and write is exactly
 * the race a single up-front check cannot close.
 *
 * What this returns is `path.resolve(cwd, requested)`, not the canonical path.
 * Callers write to and read from the path the user named, so resolving
 * symlinks here would silently retarget an in-workspace symlink to its
 * destination and change what an atomic rename replaces. Containment is judged
 * against the canonical form; the value handed back is the one the tool has
 * always used.
 */

import * as path from "node:path";
import { WorkspaceAuthority, PathEscapeError } from "../kernel/workspace-authority.js";
import { isUnderCwd } from "./tier0/internal.js";

export type ResolvedWorkspacePath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

// One authority per workspace root. Each realpaths its root once, and tools
// resolve paths often enough that repeating that per call is pure waste.
const authorities = new Map<string, Promise<WorkspaceAuthority>>();

function authorityFor(cwd: string): Promise<WorkspaceAuthority> {
  let existing = authorities.get(cwd);
  if (existing === undefined) {
    const authority = new WorkspaceAuthority(cwd);
    existing = authority.init().then(
      () => authority,
      (err: unknown) => {
        // Do not cache a rejection: a workspace that does not exist yet may
        // exist by the next call, and a stuck failure would outlast the cause.
        authorities.delete(cwd);
        throw err;
      },
    );
    authorities.set(cwd, existing);
  }
  return existing;
}

/**
 * Resolve `requested` against `cwd` and confirm it stays inside the workspace.
 *
 * On failure the message distinguishes a path that never pointed inside from
 * one that reached out through a link, because they are different mistakes:
 * the first is usually a wrong argument, the second is usually a surprise
 * about the repository's own layout.
 */
export async function resolveInWorkspace(
  requested: string,
  cwd: string,
): Promise<ResolvedWorkspacePath> {
  const resolved = path.resolve(cwd, requested);

  let authority: WorkspaceAuthority;
  try {
    authority = await authorityFor(cwd);
  } catch {
    // An unresolvable workspace root cannot contain anything.
    return {
      ok: false,
      message: `workspace root ${JSON.stringify(cwd)} could not be resolved`,
    };
  }

  try {
    await authority.canonicalize(resolved);
    return { ok: true, path: resolved };
  } catch (err) {
    if (!(err instanceof PathEscapeError)) throw err;
    // Lexically inside but canonically outside means a link led out of the
    // workspace somewhere along the way.
    const viaLink = isUnderCwd(resolved, path.resolve(cwd));
    return {
      ok: false,
      message: viaLink
        ? `path ${JSON.stringify(requested)} is a symlink pointing outside the workspace boundary`
        : `path ${JSON.stringify(requested)} resolves outside the workspace boundary`,
    };
  }
}

/** Test seam: drop cached authorities so a reused temp path is not stale. */
export function resetWorkspaceAuthorities(): void {
  authorities.clear();
}
