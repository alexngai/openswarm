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

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

/**
 * Why a contained write did not happen. Callers treat these differently:
 * `stale` is a lost race with another editor and is retryable after a re-read,
 * `escaped` is a containment refusal and is not.
 */
export type ContainedWriteFailure = "stale" | "escaped" | "io";

export type ContainedWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ContainedWriteFailure; readonly message: string };

/**
 * A directory pinned by descriptor, so later operations reach the inode that
 * was verified rather than whatever its name means at the time.
 *
 * On Linux `/proc/self/fd/N` is a magic symlink the kernel resolves straight
 * to the open file description, which is the one primitive that turns a
 * check-then-act sequence into an anchored one without `openat`. Nothing
 * equivalent exists on macOS or Windows, so those platforms fall back to
 * name-based operations and keep the residual race documented on the caller.
 */
type DirectoryAnchor =
  /** Pinned: operations resolve through the descriptor. */
  | { readonly kind: "anchored"; join: (target: string) => string; release: () => Promise<void> }
  /** The platform has no way to pin, so the caller proceeds by name. */
  | { readonly kind: "unsupported"; release: () => Promise<void> }
  /** The platform can pin but this directory could not be; the caller refuses. */
  | { readonly kind: "unpinnable"; release: () => Promise<void> };

const PROC_SELF_FD = "/proc/self/fd";
let procSelfFdUsable: Promise<boolean> | undefined;

/**
 * Whether writes on this platform anchor their rename to a directory
 * descriptor, closing the swap race, or fall back to resolving by name and
 * merely detecting an escape after the fact. Exposed so the difference is
 * observable rather than inferred: a change that quietly loses the anchor
 * would otherwise only show up as a rare, deniable test failure.
 */
export function anchoredRenamesAvailable(): Promise<boolean> {
  procSelfFdUsable ??= fs.access(PROC_SELF_FD).then(
    () => true,
    () => false,
  );
  return procSelfFdUsable;
}

async function anchorDirectory(dir: string, root: string): Promise<DirectoryAnchor> {
  const noop = async (): Promise<void> => undefined;
  if (!(await anchoredRenamesAvailable())) return { kind: "unsupported", release: noop };

  let handle;
  try {
    handle = await fs.open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  } catch {
    // Where pinning is possible, failing to pin must refuse rather than fall
    // back to resolving by name. A directory that cannot be opened right now
    // is usually one being swapped, which is exactly the case the anchor
    // exists for — quietly downgrading to the racy path hands the attacker the
    // window back by making the swap itself the trigger.
    return { kind: "unpinnable", release: noop };
  }
  const release = async (): Promise<void> => {
    await handle.close().catch(() => undefined);
  };

  const base = `${PROC_SELF_FD}/${handle.fd}`;
  try {
    if (!isUnderCwd(await fs.realpath(base), root)) {
      return { kind: "unpinnable", release };
    }
  } catch {
    return { kind: "unpinnable", release };
  }

  return {
    kind: "anchored",
    join: (target: string) => `${base}/${path.basename(target)}`,
    release,
  };
}

/**
 * Move a staged file onto a target on another filesystem, where rename cannot
 * reach. The second stage is a same-directory rename, so the destination still
 * never sees a partial file — but it does stage beside the target, which is
 * the exposure the root staging above exists to avoid. Only a mount boundary
 * inside the workspace reaches this path.
 */
async function relayAcrossDevice(
  staged: string,
  target: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const beside = `${target}.openswarm-tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.copyFile(staged, beside);
    await fs.rename(beside, target);
    return { ok: true };
  } catch (err: unknown) {
    await fs.unlink(beside).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `write failed: ${msg}` };
  }
}

/**
 * Write `content` to `target` atomically, and prove the bytes landed inside
 * the workspace.
 *
 * Every containment check resolves a path by name, and a name can mean
 * something else by the next syscall. An attacker who can replace a directory
 * with a symlink between the last check and the rename does not have to defeat
 * any check — it only has to land between two of them. Measured against a
 * thread doing nothing but that swap, the previous check-then-write sequence
 * put both temp files and finished files outside the workspace.
 *
 * Three things close it, in decreasing order of strength.
 *
 * The staged file is created at the workspace root, not beside the target.
 * Every component of the target's directory is a name that may be redirected,
 * and a temp file that lands outside cannot reliably be cleaned up: by the
 * time the escape is noticed the name points back inside, the unlink misses,
 * and the file is orphaned where no later check will find it. The root is
 * already resolved and held, so nothing is ever created outside.
 *
 * The rename is anchored to a directory descriptor where the platform allows
 * it. Node exposes no `openat`, but Linux exposes `/proc/self/fd/N`, which the
 * kernel resolves straight to the open file description — so the directory
 * verified before the rename is the directory the rename reaches, whatever its
 * name means by then. On Linux this closes the race rather than narrowing it.
 *
 * Elsewhere the sequence falls back to names, and the residual is real: a swap
 * landing between the last check and the rename can place the file outside.
 * That case is always detected and the write always refused, but repair is
 * best effort, and the guarantee off Linux is correspondingly narrower — no
 * content chosen here survives outside the workspace, while an empty file may,
 * at a path an attacker chose. Removal is attempted first and usually works;
 * emptying the file through the still-open descriptor is what remains when the
 * redirect has reverted and the file no longer has a name. Preventing the
 * escape needs `openat2(RESOLVE_BENEATH)` or kernel-level containment, which
 * belongs with the sandbox work rather than here.
 */
export async function atomicWriteInWorkspace(
  target: string,
  content: string,
  cwd: string,
  expectedHash?: string,
): Promise<ContainedWrite> {
  let root: string;
  try {
    root = (await authorityFor(cwd)).workspaceRoot;
  } catch {
    return {
      ok: false,
      reason: "escaped",
      message: `workspace root ${JSON.stringify(cwd)} could not be resolved`,
    };
  }

  const dir = path.dirname(target);
  // Random rather than pid+time so concurrent writers cannot collide on the
  // temp name and have one rename over the other's file mid-write.
  const leaf = `.openswarm-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  // Staged at the workspace root rather than beside the target. Every
  // component of the target's directory is a name an attacker may redirect
  // between the check and the create, and a temp file that lands outside
  // cannot reliably be cleaned up afterwards: by the time the escape is
  // noticed the name points back inside, so the unlink misses and the file is
  // orphaned. The root is already resolved and held, so staging there means
  // nothing is ever created outside — redirecting it would require replacing
  // the workspace itself, at which point containment has no meaning anyway.
  const tmp = path.join(root, leaf);

  /**
   * Where a name currently points, and whether that is inside. The resolved
   * location matters as much as the verdict: it is the only handle on the file
   * that survives the next swap, since the name will point somewhere else.
   */
  const locate = async (p: string): Promise<{ inside: boolean; real: string | null }> => {
    try {
      const real = await fs.realpath(p);
      return { inside: isUnderCwd(real, root), real };
    } catch {
      return { inside: false, real: null };
    }
  };

  // Every failure below leaves the temp file behind unless it is removed here,
  // and a swap can have moved it outside. Deleting it by name loses the same
  // race that put it there — by then the name points back inside and the
  // unlink misses — so delete the location it was found at.
  const fail = async (
    reason: ContainedWriteFailure,
    message: string,
    at?: string | null,
  ): Promise<ContainedWrite> => {
    await fs.unlink(at ?? tmp).catch(() => undefined);
    if (at != null) await fs.unlink(tmp).catch(() => undefined);
    return { ok: false, reason, message };
  };
  const swapped = "parent directory was replaced outside the workspace";

  // Exclusive create: never adopt a file an attacker placed at the temp name.
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "io", message: `write failed: ${msg}` };
  }

  // Identity of the staged file, taken from the descriptor rather than from a
  // name. If a swap carries this file outside, the inode is the only thing
  // that still identifies it: unlinking a path that merely looks right would
  // delete whatever the attacker happens to have left there instead.
  const ours = await handle.stat().then(
    (st) => st.ino,
    () => null,
  );

  /** Unlink `p`, but only if `p` is the file staged above. */
  const unlinkIfOurs = async (p: string): Promise<boolean> => {
    try {
      const st = await fs.lstat(p);
      if (ours === null || st.ino !== ours) return false;
      await fs.unlink(p);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Dispose of a file a swap placed outside the workspace: remove it, or
   * failing that empty it.
   *
   * Removal needs a name, and a name is what the swap just proved unreliable.
   * Once the redirect reverts, `target` resolves back inside and the escaped
   * file has no name this process can compute — which is why undoing by name
   * alone silently left finished, attacker-named files outside, reporting the
   * refusal correctly while the bytes stayed put.
   *
   * The descriptor opened above still refers to the file, because a descriptor
   * follows the inode through a rename. So when no name reaches it, truncating
   * through the handle is the one thing that does. That cannot unlink it, so an
   * empty file may persist at a path an attacker chose, and a pre-existing file
   * there is already destroyed by the rename either way. What it does buy is
   * that no content chosen here survives outside the workspace. Preventing the
   * escape rather than repairing it needs an anchor the platform does not
   * offer, which is `WP-25`.
   */
  const discardEscaped = async (real: string | null): Promise<void> => {
    if (real !== null && (await unlinkIfOurs(real))) return;
    // The redirect may be back in place even though the name resolved inside a
    // moment ago, in which case the parent names the file once more.
    const parent = await fs.realpath(dir).catch(() => null);
    if (parent !== null && !isUnderCwd(parent, root)) {
      if (await unlinkIfOurs(path.join(parent, path.basename(target)))) return;
    }
    await handle.truncate(0).catch(() => undefined);
  };

  // The handle stays open until the bytes are known to have landed inside,
  // because it is the fallback `discardEscaped` relies on. Holding a write
  // descriptor across the rename is safe on posix, and native Windows is
  // rejected outright rather than partially supported.
  try {
    // Before any content exists, confirm the empty file is where it belongs.
    const placed = await locate(tmp);
    if (!placed.inside) return fail("escaped", swapped, placed.real);

    try {
      await handle.writeFile(content, "utf8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail("io", `write failed: ${msg}`, placed.real);
    }

    if (expectedHash !== undefined) {
      try {
        const current = await fs.readFile(target, "utf8");
        const hash = crypto.createHash("sha256").update(current).digest("hex");
        if (hash !== expectedHash) {
          return fail(
            "stale",
            `file ${JSON.stringify(target)} was modified between read and write ` +
              `(expected hash ${expectedHash.slice(0, 12)}…, got ${hash.slice(0, 12)}…)`,
          );
        }
      } catch {
        // Deleted between read and write. Unusual, but not a stale-content edit.
      }
    }

    // Narrow the window as far as a name-based check can be narrowed.
    if (!(await locate(dir)).inside) return fail("escaped", swapped, placed.real);

    const anchor = await anchorDirectory(dir, root);
    if (anchor.kind === "unpinnable") {
      await anchor.release();
      return fail("escaped", swapped, placed.real);
    }

    try {
      // With an anchor this resolves through the descriptor, so a swap of the
      // directory's *name* after this point cannot redirect it.
      await fs.rename(tmp, anchor.kind === "anchored" ? anchor.join(target) : target);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        // A separate mount inside the workspace, so the staged file cannot be
        // renamed across. Copying keeps the write atomic at the destination.
        const relayed = await relayAcrossDevice(tmp, target);
        if (!relayed.ok) {
          await anchor.release();
          return fail("io", relayed.message, tmp);
        }
      } else {
        await anchor.release();
        const msg = err instanceof Error ? err.message : String(err);
        return fail("io", `write failed: ${msg}`, placed.real);
      }
    }

    // Verify through the anchor too. Checking the name here would misreport a
    // correct write as a failure whenever the name happens to point elsewhere
    // at this instant, even though the file went to the verified directory.
    const landed = await locate(anchor.kind === "anchored" ? anchor.join(target) : target);
    await anchor.release();
    if (!landed.inside) {
      // The swap won the race, so refuse rather than report a success that put
      // chosen content at a chosen path, and take the content back.
      await discardEscaped(landed.real);
      return { ok: false, reason: "escaped", message: swapped };
    }

    return { ok: true };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
