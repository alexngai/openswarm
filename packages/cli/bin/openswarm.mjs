#!/usr/bin/env node
// Dev entry: runs the TS sources via the workspace tsx. The sandbox
// deployment path (bundled single file) is a separate build step.
import { runCli } from '../src/index.ts'
process.exitCode = await runCli(process.argv.slice(2))
