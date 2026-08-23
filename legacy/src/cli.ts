#!/usr/bin/env bun
// JSX transform registration.
//
// Dev path (`bun src/cli.ts`): load @opentui/solid/preload to register the
// Solid JSX Bun plugin before any .tsx file is dynamically imported. Uses a
// variable-path dynamic import so tsc doesn't statically resolve into
// @opentui/solid's Bun-only source (which uses globals not in @types/node).
//
// Compiled binary (`bun build --compile`): JSX is pre-transformed at build
// time via scripts/build-binary.ts's plugin option — no runtime preload
// needed. Detecting compile mode lets us skip the dynamic import, and the
// bundler won't try to resolve it either (variable path).
//
// Ordering: cli.ts's static imports (./cli/main.js) run first. main.js has
// no static .tsx imports — every TSX file is behind a dynamic import. So
// registration completes before any Solid JSX is evaluated.
const exec = process.execPath;
const runningUnderBunExecutable =
  exec.endsWith("bun") || exec.endsWith("bun.exe");
if (runningUnderBunExecutable) {
  const preloadPath = "@opentui/solid/preload";
  await import(preloadPath);
}

import { main } from "./cli/main.js";
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
