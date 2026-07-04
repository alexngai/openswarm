#!/usr/bin/env bun
/**
 * update-grammars.ts — download extra Tree-sitter grammars for the TUI.
 *
 * OpenTUI bundles only typescript/javascript/markdown/zig. The REPL registers
 * additional grammars at runtime from a directory (see
 * src/ui/repl-solid/syntax.ts `registerExtraGrammars`, gated on
 * OPENSWARM_GRAMMAR_DIR). This script populates that directory by downloading
 * the .wasm + highlights.scm assets described in a parsers-config file, using
 * OpenTUI's own `updateAssets` downloader.
 *
 * Usage:
 *   bun scripts/update-grammars.ts [--config <path>] [--out <dir>]
 *
 * Defaults:
 *   --config  scripts/grammar-parsers-config.json
 *   --out     assets/grammars   (point OPENSWARM_GRAMMAR_DIR here at runtime)
 *
 * The config format matches OpenTUI's parsers-config: an object with a
 * `parsers` array, each entry `{ filetype, aliases?, wasm, queries: {
 * highlights: string[], injections?: string[] }, injectionMapping? }` where
 * `wasm` / query entries are URLs (or paths relative to the config file).
 *
 * NETWORK REQUIRED. Assets are intentionally NOT committed to the repo; run
 * this once locally / in CI and ship the output dir with the binary build.
 */

import path from "node:path";
import { updateAssets } from "@opentui/core";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined
    ? process.argv[i + 1]!
    : fallback;
}

async function main(): Promise<void> {
  const configPath = path.resolve(
    arg("--config", "scripts/grammar-parsers-config.json"),
  );
  const assetsDir = path.resolve(arg("--out", "assets/grammars"));
  // updateAssets also emits a generated TS index; we don't consume it (runtime
  // discovery is directory-based), so write it inside the assets dir.
  const outputPath = path.join(assetsDir, "generated-parsers.ts");

  console.log(`Downloading grammars`);
  console.log(`  config: ${configPath}`);
  console.log(`  out:    ${assetsDir}`);
  await updateAssets({ configPath, assetsDir, outputPath });
  console.log(`Done. Set OPENSWARM_GRAMMAR_DIR=${assetsDir} to enable them.`);
}

main().catch((err) => {
  console.error("update-grammars failed:", err);
  process.exit(1);
});
