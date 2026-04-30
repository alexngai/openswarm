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
import sdkPkg from "@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" };

// The compiled binary can't read @anthropic-ai/claude-agent-sdk/package.json
// at runtime (embedded filesystem doesn't expose node_modules paths). Inject
// the version as a compile-time constant so `doctor` shows the right value.
const SDK_VERSION: string = (sdkPkg as { version?: string }).version ?? "unknown";

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
  // Inject the SDK version so the compiled binary's `doctor` command reports
  // the real version (runtime package.json lookup doesn't work in compiled
  // binaries — the node_modules path isn't in the embedded fs).
  define: {
    __SWARM_CODER_AGENT_SDK_VERSION__: JSON.stringify(SDK_VERSION),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`OK. ${outfile}`);
