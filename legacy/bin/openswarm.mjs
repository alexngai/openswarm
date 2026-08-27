#!/usr/bin/env node
/**
 * OpenSwarm launcher (pure node, no deps).
 *
 * Prefers the self-contained, bun-compiled platform binary shipped as an
 * optional dependency (@openswarm/cli-<platform>-<arch>) — it
 * bundles the bun runtime and the full interactive TUI. Falls back to running
 * the node bundle (dist/cli.js) when no binary is available for this platform:
 * that covers everything except the interactive TUI, which main.ts degrades to
 * headless under node.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const { platform, arch } = process;
const exe = platform === "win32" ? "openswarm.exe" : "openswarm";

function resolvePlatformBinary() {
  // Escape hatch: force the node bundle (dist/cli.js) instead of a possibly-STALE
  // compiled platform binary. Needed when running working-tree changes whose features
  // (e.g. a new `topology cascade`) aren't in the published @openswarm/cli-* binary —
  // the eval harness sets this in sandboxes. See docs/51.
  if (process.env.OPENSWARM_NODE_CLI === "1") return null;
  const pkgName = `@openswarm/cli-${platform}-${arch}`;
  // Production: the installed optional-dependency package.
  try {
    const pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
    const p = join(pkgDir, exe);
    if (existsSync(p)) return p;
  } catch {
    /* not installed for this platform */
  }

  // Development: the local packages/ build output.
  const local = join(here, "..", "packages", `cli-${platform}-${arch}`, exe);
  return existsSync(local) ? local : null;
}

const bin = resolvePlatformBinary();
try {
  if (bin !== null) {
    execFileSync(bin, args, { stdio: "inherit", env: process.env });
  } else {
    const cli = join(here, "..", "dist", "cli.js");
    execFileSync(process.execPath, [cli, ...args], { stdio: "inherit", env: process.env });
  }
} catch (err) {
  if (err && typeof err.status === "number") process.exit(err.status);
  throw err;
}
