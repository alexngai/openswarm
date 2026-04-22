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
 * Usage:
 *   bun scripts/build-binary.ts [target]
 *
 * Targets (default: bun-darwin-arm64):
 *   bun-darwin-arm64, bun-darwin-x64, bun-linux-x64, bun-windows-x64
 */

import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";

const target =
  (process.argv[2] as
    | "bun-darwin-arm64"
    | "bun-darwin-x64"
    | "bun-linux-x64"
    | "bun-windows-x64"
    | undefined) ?? "bun-darwin-arm64";

const outfile =
  target === "bun-windows-x64"
    ? "dist/swarm-coder.exe"
    : "dist/swarm-coder";

console.log(`Building ${outfile} for ${target}…`);

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  compile: {
    target,
    outfile,
  },
  plugins: [createSolidTransformPlugin({ moduleName: "@opentui/solid" })],
  // Mark the OpenTUI preload as external — compile-target bundles it; the
  // runtime bunfig.toml preload isn't applicable inside the binary.
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`OK. ${outfile}`);
