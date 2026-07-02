#!/usr/bin/env bun
/**
 * scripts/publish.ts — bump versions, build, and publish all OpenSwarm
 * packages to npm.
 *
 * Publishes in dependency order (platform binaries first, main package last,
 * since the main package's optionalDependencies point at the platform ones):
 *   1. @openswarm/cli-darwin-arm64
 *   2. @openswarm/cli-darwin-x64
 *   3. @openswarm/cli-linux-x64
 *   4. openswarm (main package)
 *
 * By default builds + publishes only the CURRENT platform's compiled binary.
 * Use --all-platforms to cross-compile and publish every platform package.
 * (The main package still ships the pure-node launcher + dist fallback, so it
 * works on platforms whose binary wasn't published — just without the
 * interactive TUI.)
 *
 * Usage:
 *   bun scripts/publish.ts patch                  # 0.3.0 → 0.3.1 (current platform)
 *   bun scripts/publish.ts minor                  # 0.3.0 → 0.4.0
 *   bun scripts/publish.ts major                  # 0.3.0 → 1.0.0
 *   bun scripts/publish.ts 0.5.2                  # explicit version
 *   bun scripts/publish.ts                        # re-publish current version (no bump)
 *   bun scripts/publish.ts patch --dry-run        # preview without publishing
 *   bun scripts/publish.ts patch --skip-build     # skip the build step
 *   bun scripts/publish.ts patch --tag beta       # publish under a dist-tag
 *   bun scripts/publish.ts patch --all-platforms  # cross-compile + publish all
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Platform packages we ship as optional dependencies. Each maps to a bun
// --compile target. Keep in sync with package.json optionalDependencies and
// the TARGETS table in scripts/build-binary.ts.
const PLATFORM_PACKAGES = [
  { dir: "packages/cli-darwin-arm64", target: "bun-darwin-arm64", platform: "darwin", arch: "arm64" },
  { dir: "packages/cli-darwin-x64", target: "bun-darwin-x64", platform: "darwin", arch: "x64" },
  { dir: "packages/cli-linux-x64", target: "bun-linux-x64", platform: "linux", arch: "x64" },
];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipBuild = args.includes("--skip-build");
const allPlatforms = args.includes("--all-platforms");
const tagIdx = args.indexOf("--tag");
const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;
const versionArg = args.find((a) => !a.startsWith("--") && a !== tag);

const currentPlatformDir = `packages/cli-${process.platform}-${process.arch}`;
const targetPackages = allPlatforms
  ? PLATFORM_PACKAGES
  : PLATFORM_PACKAGES.filter((p) => p.dir === currentPlatformDir);

// ---------------------------------------------------------------------------
// Version handling
// ---------------------------------------------------------------------------

function readPkg(dir: string): { path: string; json: Record<string, unknown> } {
  const path = resolve(ROOT, dir, "package.json");
  return { path, json: JSON.parse(readFileSync(path, "utf-8")) };
}

function bumpVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;
  const [major, minor, patch] = current.split(".").map(Number);
  switch (bump) {
    case "patch": return `${major}.${minor}.${patch + 1}`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "major": return `${major + 1}.0.0`;
    default:
      console.error(`Invalid version bump: ${bump}`);
      process.exit(1);
  }
}

const rootPkg = readPkg(".");
const currentVersion = rootPkg.json.version as string;
const newVersion = versionArg ? bumpVersion(currentVersion, versionArg) : currentVersion;
const isBump = newVersion !== currentVersion;

console.log(`\n╔════════════════════════════════════════╗`);
console.log(`║            OpenSwarm publish           ║`);
console.log(`╚════════════════════════════════════════╝\n`);
console.log(`  Version:   ${isBump ? `${currentVersion} → ${newVersion}` : `${currentVersion} (no bump)`}`);
console.log(`  Platforms: ${allPlatforms ? "all" : `${process.platform}-${process.arch} (current)`}`);
if (dryRun) console.log(`  Mode:      DRY RUN (no publish)`);
if (tag) console.log(`  Tag:       ${tag}`);
console.log();

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

console.log("── Pre-flight checks ───────────────────");

try {
  const status = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf-8" }).trim();
  if (status && !dryRun) {
    console.error("  Error: working directory has uncommitted changes.");
    console.error("  Commit or stash before publishing.\n");
    console.error(status);
    process.exit(1);
  }
  console.log(status ? "  Warning: uncommitted changes (ignored in dry-run)" : "  Working directory clean ✓");
} catch {
  console.log("  Warning: git not available, skipping dirty check");
}

try {
  const who = execSync("npm whoami", { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }).trim();
  console.log(`  npm authenticated as ${who} ✓`);
} catch {
  if (!dryRun) {
    console.error("  Error: not logged in to npm. Run `npm login` first.");
    process.exit(1);
  }
  console.log("  Warning: not logged in to npm (ignored in dry-run)");
}

if (targetPackages.length === 0) {
  console.log(
    `  Warning: no platform package for ${process.platform}-${process.arch}; ` +
      `only the main package (node launcher + dist) will be published.`,
  );
}

// ---------------------------------------------------------------------------
// Bump versions across root + all platform packages
// ---------------------------------------------------------------------------

if (isBump) {
  console.log("\n── Updating versions ───────────────────");
  const updateVersion = (dir: string) => {
    const { path, json } = readPkg(dir);
    json.version = newVersion;
    const optDeps = json.optionalDependencies as Record<string, string> | undefined;
    if (optDeps) {
      for (const name of Object.keys(optDeps)) {
        if (name.startsWith("@openswarm/cli-")) optDeps[name] = newVersion;
      }
    }
    // Never mutate files on disk during a dry-run.
    if (dryRun) {
      console.log(`  [dry-run] ${dir}/package.json → ${newVersion}`);
      return;
    }
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
    console.log(`  ${dir}/package.json → ${newVersion}`);
  };
  updateVersion(".");
  for (const p of PLATFORM_PACKAGES) updateVersion(p.dir);
} else {
  console.log("\n── Version unchanged ───────────────────");
}

// ---------------------------------------------------------------------------
// Build: the node dist (for the main package) + each platform binary.
// ---------------------------------------------------------------------------

if (!skipBuild) {
  console.log("\n── Building ───────────────────────────");
  console.log("  Building node dist (tsc)…");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  for (const p of targetPackages) {
    console.log(`  Compiling ${p.platform}-${p.arch} binary…`);
    execSync(`bun scripts/build-binary.ts ${p.target}`, { cwd: ROOT, stdio: "inherit" });
  }
} else {
  console.log("\n── Build skipped ──────────────────────");
}

// Verify each platform package we're about to publish actually has its binary
// (a preferUnpacked package with no binary would publish a broken install).
for (const p of targetPackages) {
  const exe = p.platform === "win32" ? "openswarm.exe" : "openswarm";
  const binPath = resolve(ROOT, p.dir, exe);
  if (!existsSync(binPath) && !dryRun) {
    console.error(`\n  Error: ${p.dir}/${exe} missing — run without --skip-build, or build it first.`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

console.log("\n── Publishing ─────────────────────────");

function isPublished(name: string, version: string): boolean {
  try {
    execSync(`npm view ${name}@${version} version`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function publishPkg(dir: string) {
  const { json } = readPkg(dir);
  const name = json.name as string;
  const pkgDir = resolve(ROOT, dir);

  if (isPublished(name, newVersion)) {
    console.log(`  ~ ${name}@${newVersion} already published, skipping`);
    return;
  }

  const tagFlag = tag ? `--tag ${tag}` : "";
  const accessFlag = name.startsWith("@") ? "--access public" : "";
  const cmd = `npm publish ${accessFlag} ${tagFlag}`.replace(/\s+/g, " ").trim();

  if (dryRun) {
    console.log(`  [dry-run] ${name}@${newVersion}: ${cmd}`);
  } else {
    console.log(`  Publishing ${name}@${newVersion}…`);
    execSync(cmd, { cwd: pkgDir, stdio: "inherit" });
    console.log(`  ✓ ${name}@${newVersion} published`);
  }
}

// Platform packages first (main package's optionalDependencies reference them).
for (const p of targetPackages) publishPkg(p.dir);
// Main package last.
publishPkg(".");

// ---------------------------------------------------------------------------
// Git tag
// ---------------------------------------------------------------------------

if (!dryRun && isBump) {
  console.log("\n── Git tag ────────────────────────────");
  const tagName = `v${newVersion}`;
  try {
    execSync(`git add -A && git commit -m "release: ${tagName}"`, { cwd: ROOT, stdio: "inherit" });
    execSync(`git tag ${tagName}`, { cwd: ROOT, stdio: "inherit" });
    console.log(`  Tagged ${tagName}`);
    console.log(`  Run \`git push && git push --tags\` to push the release.`);
  } catch {
    console.log("  Warning: failed to create git tag (tag manually if needed).");
  }
}

console.log(`\n════════════════════════════════════════`);
console.log(
  dryRun
    ? "Dry run complete. No packages were published."
    : `Published openswarm@${newVersion} 🎉`,
);
console.log(`════════════════════════════════════════\n`);
