#!/usr/bin/env bun
// Register @opentui/solid's JSX transform plugin before any .tsx module is
// loaded. In dev (`bun src/cli.ts`) this installs the plugin at startup; in
// compiled binaries (Phase 0e) the JSX is already pre-transformed and this
// import is a harmless no-op.
import "@opentui/solid/preload";
import { main } from "./cli/main.js";
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
