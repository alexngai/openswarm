/**
 * local.ts — run the LOCAL working-tree swarm-harness in evals, without publishing to npm.
 *
 * Two regimes (E2B template builds run server-side and can't see local files — docs/45 §8 Q5):
 *   - Local-FS backend (in-process): `localSwarmHarness()` runs the built CLI directly via `node <bin>`.
 *     Iterate with: edit src → `npm run build:dev` → re-run the eval. No install, no publish.
 *   - Sandbox backend (E2B/docker): pack the CLI (`eval/scripts/pack-local-harness.sh`) and install the
 *     tarball INSIDE the sandbox via `sandboxInstallLocalHarness()`. Getting the tarball into the sandbox
 *     is the open transport decision (runtime base64 FileSeed, or a hosted URL).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  swarmHarnessSpec,
  harnessOf,
  npmCliInstall,
  type Harness,
  type CliHarnessAdapterOptions,
} from "swarmkit-eval";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Absolute path to the working-tree CLI entry (built output is loaded by this shim). */
export const LOCAL_HARNESS_BIN = resolve(REPO_ROOT, "bin", "swarm-harness.mjs");

/** Stable path to the packed tarball produced by eval/scripts/pack-local-harness.sh. */
export const LOCAL_HARNESS_TARBALL = resolve(REPO_ROOT, "eval", ".artifacts", "swarm-harness-local.tgz");

/**
 * The SAME tarball as a path RELATIVE to the repo root (= the e2b template build context / cwd).
 * The e2b SDK `.copy()` rejects absolute source paths ("Use a relative path within the context
 * directory"), so template staging must use this. Runs are invoked from the repo root.
 */
export const LOCAL_HARNESS_TARBALL_REL = "eval/.artifacts/swarm-harness-local.tgz";

/** The unpublished local sibling dep `skill-tree` (packed by pack-local-harness.sh), installed alongside. */
export const LOCAL_SKILLTREE_TARBALL = resolve(REPO_ROOT, "eval", ".artifacts", "skill-tree-local.tgz");

/**
 * Local-FS backend harness: the registered `swarm-harness` spec with its npm-install stripped and the
 * binary pointed at the local build (`node <bin>`). Use with `InProcessBackend`. Rebuild after edits.
 */
export function localSwarmHarness(opts: CliHarnessAdapterOptions = {}): Harness {
  return harnessOf(
    { ...swarmHarnessSpec, install: [], readyCmd: undefined },
    { bin: `node ${LOCAL_HARNESS_BIN}`, ...opts },
  );
}

/**
 * Sandbox install commands for the LOCAL packed tarball (E2B/docker). Reuses swarmkit-eval's
 * `npmCliInstall` so the node bootstrap (task images like swebench's ship no node) + the
 * `swarm-harness` symlink + version check are identical to the published path — only the package
 * is a local `.tgz` path (staged into the sandbox via `copyFiles`) instead of an npm name.
 */
export function sandboxInstallLocalHarness(
  tarballPathInSandbox: string,
  depTarballsInSandbox: string[] = [],
): string[] {
  // Install all tarballs in ONE `npm install` so cross-deps (swarm-harness → skill-tree) resolve from
  // the co-installed tarballs rather than the registry.
  const pkgs = [...depTarballsInSandbox, tarballPathInSandbox].join(" ");
  return npmCliInstall(pkgs, ["swarm-harness"]);
}
