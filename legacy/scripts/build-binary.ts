#!/usr/bin/env bun
/**
 * scripts/build-binary.ts — produce a standalone compiled binary via
 * `Bun.build({ compile: ... })`.
 *
 * The Solid JSX transform needs to run at BUILD time (not runtime), so this
 * script registers @opentui/solid's bun-plugin as a build plugin. The
 * runtime-preload pattern used for `bun src/cli.ts` doesn't work with
 * --compile because the bundler has already emitted final JS by then.
 *
 * Native-library handling (mirrors Swarm Runner's build-tui.ts):
 *   @opentui/core dynamically does
 *     `import("@opentui/core-${process.platform}-${process.arch}/index.ts")`
 *   and that module does `import("./libopentui.dylib", { with: {type:"file"} })`
 *   — a Bun file import that resolves to a $bunfs path inside compiled
 *   binaries. dlopen can't load from $bunfs, so the TUI crashes at startup.
 *
 *   We fix this two ways, both required:
 *     1. createNativeLibShim() rewrites that import to resolve the library
 *        next to process.execPath at runtime.
 *     2. After compiling we copy libopentui.<ext> into the platform package
 *        dir (and the package's `files` array ships it), so it sits beside the
 *        installed binary.
 *
 *   Defining process.platform/arch to the *target* makes the dynamic import
 *   statically analyzable, which is what lets the shim's onResolve match it
 *   (and is required for cross-compilation).
 *
 * Usage:
 *   bun scripts/build-binary.ts [target]
 *
 * Targets (default: bun-darwin-arm64):
 *   bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-linux-arm64,
 *   bun-windows-x64
 */

import { mkdirSync, existsSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import type { BunPlugin } from "bun";
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import sdkPkg from "@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" };
import pkg from "../package.json" with { type: "json" };

// The compiled binary can't read package.json from its embedded fs at runtime,
// so inject versions as compile-time constants (see src/index.ts and the
// SDK-version lookup in doctor).
const SDK_VERSION: string = (sdkPkg as { version?: string }).version ?? "unknown";
const PKG_VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";

// The @opentui/core-<platform>-<arch> native packages must match the
// @opentui/core version. Derive it from the declared dependency range.
const OPENTUI_VERSION: string = ((
  pkg as { dependencies?: Record<string, string> }
).dependencies?.["@opentui/core"] ?? "0.1.99").replace(/^[\^~]/, "");

interface Target {
  bunTarget: string;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  libName: string | null; // null for platforms with no opentui native package
  exe: string;
}

const TARGETS: Record<string, Target> = {
  "bun-darwin-arm64": { bunTarget: "bun-darwin-arm64", platform: "darwin", arch: "arm64", libName: "libopentui.dylib", exe: "openswarm" },
  "bun-darwin-x64":   { bunTarget: "bun-darwin-x64",   platform: "darwin", arch: "x64",   libName: "libopentui.dylib", exe: "openswarm" },
  "bun-linux-x64":    { bunTarget: "bun-linux-x64",    platform: "linux",  arch: "x64",   libName: "libopentui.so",     exe: "openswarm" },
  "bun-linux-arm64":  { bunTarget: "bun-linux-arm64",  platform: "linux",  arch: "arm64", libName: "libopentui.so",     exe: "openswarm" },
  "bun-windows-x64":  { bunTarget: "bun-windows-x64",  platform: "win32",  arch: "x64",   libName: null,                exe: "openswarm.exe" },
};

// Default to the HOST, not a fixed platform. The release scripts always pass an
// explicit target, so cross-compiles are unaffected; the default only serves
// callers that mean "build something I can run here". It used to be a hardcoded
// bun-darwin-arm64, so a no-arg build on a Linux x64 CI runner produced a
// Mach-O binary and the smoke check then failed with "Exec format error" —
// reported as though the binary itself were broken.
const hostKey = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const targetKey = process.argv[2] ?? (hostKey in TARGETS ? hostKey : "bun-darwin-arm64");
const target = TARGETS[targetKey];
if (!target) {
  console.error(`Unknown target: ${targetKey}. Valid: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Native library shim plugin
//
// Rewrites `@opentui/core-<platform>-<arch>/index.ts` to a shim that resolves
// libopentui.<ext> next to process.execPath (where step 3 copies it), instead
// of the $bunfs file import that dlopen can't read in compiled binaries.
// ---------------------------------------------------------------------------
function createNativeLibShim(t: Target): BunPlugin {
  const ext = t.platform === "darwin" ? "dylib" : "so";
  return {
    name: "opentui-native-shim",
    setup(build) {
      build.onResolve(
        { filter: /^@opentui\/core-(darwin|linux)-(arm64|x64)\/index\.ts$/ },
        () => ({ path: "opentui-native-shim", namespace: "opentui-native" }),
      );
      build.onLoad(
        { filter: /.*/, namespace: "opentui-native" },
        () => ({
          contents: `
            import { dirname, join } from "node:path";
            const libPath = join(dirname(process.execPath), "libopentui.${ext}");
            export default libPath;
          `,
          loader: "js",
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Resolve the target platform's native libopentui.<ext> for the copy step.
//
// For the host platform it's already in node_modules. For cross-compile the
// package manager refuses to *install* an os/cpu-mismatched package, so we
// fetch the tarball directly with `npm pack` (which ignores os/cpu gating) and
// extract the lib into a build cache. Returns the lib's path, or null if it
// can't be obtained.
// ---------------------------------------------------------------------------
function ensureNativePackage(t: Target): string | null {
  if (!t.libName) return null;
  const nativePkg = `@opentui/core-${t.platform}-${t.arch}`;

  // Fast path: installed for the host platform.
  const installed = resolve(`node_modules/${nativePkg}`, t.libName);
  if (existsSync(installed)) return installed;

  // Cross-compile: fetch + extract the tarball.
  const cacheDir = resolve(`.build/native/${t.platform}-${t.arch}`);
  const cachedLib = resolve(cacheDir, "package", t.libName);
  if (existsSync(cachedLib)) return cachedLib;

  console.log(`  Fetching ${nativePkg}@${OPENTUI_VERSION} native lib (cross-compile)…`);
  mkdirSync(cacheDir, { recursive: true });
  try {
    const out = execSync(
      `npm pack ${nativePkg}@${OPENTUI_VERSION} --pack-destination ${cacheDir} --json`,
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const filename = (JSON.parse(out) as Array<{ filename: string }>)[0]?.filename;
    if (!filename) throw new Error("npm pack returned no filename");
    execSync(`tar -xzf ${resolve(cacheDir, filename)} -C ${cacheDir}`, { stdio: "pipe" });
  } catch (err) {
    console.error(`  Failed to fetch ${nativePkg}. Cross-compilation needs its native lib.`);
    throw err;
  }
  return existsSync(cachedLib) ? cachedLib : null;
}

// Emit into the per-platform package dir (mirrors Swarm Runner), so each
// @openswarm/cli-<platform>-<arch> optional-dep ships its own binary.
const platformArch = target.bunTarget.replace(/^bun-/, ""); // e.g. darwin-arm64
const pkgDir = `packages/cli-${platformArch}`;
const outfile = `${pkgDir}/${target.exe}`;
mkdirSync(pkgDir, { recursive: true });

const libSrc = ensureNativePackage(target);

console.log(`Building ${outfile} for ${target.bunTarget} (v${PKG_VERSION})…`);

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  external: [
    // Optional runtime integrations. The CLI already degrades gracefully when
    // they are absent, and bundling them can pull in Node-only modules that Bun
    // cannot compile into the standalone binary.
    "minimem",
    "sessionlog",
  ],
  compile: {
    target: target.bunTarget,
    outfile,
  },
  plugins: [
    // Shim must run before the Solid transform plugin.
    createNativeLibShim(target),
    createSolidTransformPlugin({ moduleName: "@opentui/solid" }),
  ],
  define: {
    // Inject the SDK + package versions so the compiled binary reports the
    // real versions (runtime package.json lookup fails in compiled binaries —
    // node_modules isn't in the embedded fs).
    __OPENSWARM_AGENT_SDK_VERSION__: JSON.stringify(SDK_VERSION),
    __OPENSWARM_VERSION__: JSON.stringify(PKG_VERSION),
    // Pin the dynamic native-lib import to the target so it's statically
    // analyzable (lets the shim match it; required for cross-compile).
    "process.platform": JSON.stringify(target.platform),
    "process.arch": JSON.stringify(target.arch),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// Step 3: co-locate the native library next to the compiled binary so the
// shim's runtime path (dirname(process.execPath)/libopentui.<ext>) resolves.
if (target.libName) {
  if (libSrc) {
    cpSync(libSrc, `${pkgDir}/${target.libName}`);
    console.log(`  Copied ${target.libName} → ${pkgDir}/`);
  } else {
    console.warn(`  Warning: native lib not found for ${platformArch} — interactive TUI will fail to load.`);
  }
}

// The claude-agent-sdk native `claude` helper is intentionally NOT bundled here:
// it ships as an optional dependency of @anthropic-ai/claude-agent-sdk, so a
// normal install already has it in node_modules. resolveClaudeExecutable() in
// src/engine/claude-agent-sdk.ts finds it there at runtime (the compiled binary
// can't use the SDK's own require.resolve). Non-Claude engines don't need it.

console.log(`OK. ${outfile}`);
