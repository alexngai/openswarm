/**
 * Canonical path authority (docs/67 §A4, WP-00).
 *
 * Today every tier-0 file tool re-derives its own answer to "is this path
 * allowed?": `path.resolve`, then `isUnderCwd`, then a `realpath` only when the
 * leaf itself is a symlink. That last condition is the gap — a path whose
 * *parent* is a symlink out of the workspace passes the check, because nothing
 * resolves the ancestor chain. Only `write_file` realpaths its parent, and only
 * after mkdir.
 *
 * Centralizing it here means resolution and containment happen once, before any
 * policy decision is recorded, so a decision and the path it authorized cannot
 * disagree. Tools receive an already-canonical path and must not re-resolve it.
 *
 * Containment is checked against the resolved ancestor chain, so it holds for
 * paths that do not exist yet — the case a create has to get right.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CanonicalPath, FileIdentity } from "./contracts.js";

/** Raised when a path resolves outside the workspace, or cannot be resolved. */
export class PathEscapeError extends Error {
  constructor(
    readonly requested: string,
    readonly resolved: string,
    readonly workspaceRoot: string,
    /** Present when the path could not be resolved at all. */
    readonly reason?: string,
  ) {
    super(
      reason !== undefined
        ? `path ${JSON.stringify(requested)} cannot be proven inside workspace ` +
          `${JSON.stringify(workspaceRoot)}: ${reason}`
        : `path ${JSON.stringify(requested)} resolves to ${JSON.stringify(resolved)}, ` +
          `outside workspace ${JSON.stringify(workspaceRoot)}`,
    );
    this.name = "PathEscapeError";
  }
}

/**
 * Cap on links followed by hand while resolving a broken chain. Matches the
 * usual kernel MAXSYMLINKS; realpath enforces its own limit for links that
 * resolve, so this only bounds the dangling case.
 */
const MAX_LINK_HOPS = 40;

/**
 * The link target if `candidate` is a symbolic link, else null. Used only on
 * the ENOENT path, to tell a broken link apart from an absent name.
 */
async function readLinkTarget(candidate: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isSymbolicLink()) return null;
    return await fs.readlink(candidate);
  } catch {
    return null;
  }
}

/**
 * The one identity a workspace root has: absolute and symlink-resolved.
 *
 * Anything that keys a decision by workspace — a trust grant, a lookup that has
 * to find it again — must derive the key from here, or the two spellings of one
 * directory become two workspaces. `path.resolve` alone is not enough: on macOS
 * a temporary directory is reached through `/var`, which is a link to
 * `/private/var`, so a grant recorded on the way in is invisible on the way out.
 * That is the whole of `FX-TRUST-007`.
 *
 * Falls back to the resolved path when the root does not exist yet, since a
 * caller naming a directory that is about to be created should get a usable key
 * rather than an exception.
 *
 * Only for roots. Candidates *beneath* a root are deliberately judged lexically
 * — see the `@security` note in `../trust/provenance.ts`, where resolving one
 * through a link is how a repository file comes to look user-owned.
 */
export async function canonicalRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  return await fs.realpath(resolved).catch(() => resolved);
}

/** True when `candidate` is the root itself or genuinely beneath it. */
export function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = path.relative(root, candidate);
  // path.relative gives ".." or an absolute path when candidate escapes.
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export class WorkspaceAuthority {
  /** Set by init(); the symlink-resolved workspace root. */
  private root: string | undefined;
  private currentGeneration = 1;

  constructor(private readonly declaredRoot: string) {}

  /**
   * Resolves the workspace root itself. Required before any canonicalization,
   * because containment is meaningless if the root is a symlink whose target we
   * never resolved (on macOS /tmp is exactly that).
   */
  async init(): Promise<void> {
    this.root = await fs.realpath(this.declaredRoot);
  }

  get workspaceRoot(): string {
    if (this.root === undefined) {
      throw new Error("WorkspaceAuthority.init() must run before use");
    }
    return this.root;
  }

  /** Workspace generation; bumped by each committed mutation. */
  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Advances the generation. Called by the effect runtime after a mutation
   * commits, so a ReadSet formed earlier can be detected as stale.
   */
  bumpGeneration(): number {
    this.currentGeneration += 1;
    return this.currentGeneration;
  }

  /**
   * Resolves a caller-supplied path and proves it stays in the workspace.
   *
   * Walks up to the deepest ancestor that exists, resolves *that* through
   * realpath, then re-attaches the remaining segments. A symlinked ancestor is
   * therefore followed and judged on its target, and a path that does not exist
   * yet still gets a trustworthy answer.
   *
   * A *broken* link needs care, because realpath reports ENOENT for it exactly
   * as it does for a name that was never there. Reading that as "does not exist
   * yet" is what let `link -> /outside/absent` pass: the link is judged at its
   * own in-workspace location, and the write then follows it out. So an ENOENT
   * is only believed once lstat agrees nothing is there; a link is followed to
   * its target by hand and the target is what gets judged.
   *
   * Anything else — a cycle, an unreadable ancestor, a name too long — means
   * containment cannot be established, and that refuses rather than throws.
   * The caller's question is "may I touch this?", and "I could not tell" has
   * only one safe answer.
   */
  async canonicalize(requested: string): Promise<CanonicalPath> {
    const root = this.workspaceRoot;

    if (requested.includes("\0")) {
      throw new PathEscapeError(requested, requested, root, "path contains a null byte");
    }

    const absolute = path.resolve(root, requested);

    // Find the deepest existing ancestor. Anything below it cannot be a
    // symlink, because it does not exist.
    let existing = absolute;
    const trailing: string[] = [];
    let hops = 0;
    for (;;) {
      try {
        existing = await fs.realpath(existing);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          throw new PathEscapeError(requested, absolute, root, `cannot resolve (${code})`);
        }

        if (code === "ENOENT") {
          const target = await readLinkTarget(existing);
          if (target !== null) {
            if (++hops > MAX_LINK_HOPS) {
              throw new PathEscapeError(requested, absolute, root, "too many symbolic links");
            }
            existing = path.resolve(path.dirname(existing), target);
            continue;
          }
        }

        const parent = path.dirname(existing);
        if (parent === existing) {
          // Walked to the filesystem root without finding anything real.
          throw new PathEscapeError(requested, absolute, root, "no existing ancestor");
        }
        trailing.unshift(path.basename(existing));
        existing = parent;
      }
    }

    const canonical = trailing.length === 0 ? existing : path.join(existing, ...trailing);

    if (!isWithin(canonical, root)) {
      throw new PathEscapeError(requested, canonical, root);
    }

    const relative = canonical === root ? "" : path.relative(root, canonical);
    return {
      canonical,
      workspaceRoot: root,
      relative: relative.split(path.sep).join("/"),
    };
  }

  /**
   * Observes a path's current state. An absent file yields all-null fields,
   * which is a usable expectation ("create only if still absent") rather than
   * an error.
   */
  async identify(target: CanonicalPath): Promise<FileIdentity> {
    try {
      const bytes = await fs.readFile(target.canonical);
      const stat = await fs.stat(target.canonical);
      return {
        path: target,
        contentHash: crypto.createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR") {
        return { path: target, contentHash: null, sizeBytes: null, mtimeMs: null };
      }
      throw err;
    }
  }

  /**
   * Whether a file still matches a previously observed identity. This is the
   * compare-and-swap predicate: the runtime refuses a write whose expectation
   * no longer holds, turning a concurrent modification into a clean conflict
   * instead of a lost update.
   */
  async matches(expected: FileIdentity): Promise<boolean> {
    const actual = await this.identify(expected.path);
    return actual.contentHash === expected.contentHash;
  }
}
