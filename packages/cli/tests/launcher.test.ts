/**
 * The installed launcher routes a gated run to packages/cli's runCli, where
 * the gate lives (docs/03 documents `openswarm run --gate`); it used to reject
 * `--gate` as an unknown option. Needs the build, as the launcher imports dist.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const built = existsSync(join(repo, 'packages', 'cli', 'dist', 'index.js'))

it.skipIf(!built)('openswarm run --gate reaches the gate, not an unknown-option error', async () => {
  // Outside a git work tree the gate refuses before any model call.
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-launcher-'))
  const env = { PATH: process.env['PATH'] ?? '', HOME: cwd, AZURE_API_KEY: 'unused', AZURE_API_BASE: 'http://127.0.0.1:9' }
  const run = promisify(execFile)(process.execPath, [join(repo, 'bin', 'openswarm.mjs'), 'run', '--gate', '--gate-check', 'true', 'do it'], { cwd, env })
  const failed = await run.then(() => undefined, (e: { stdout: string; stderr: string }) => e)
  expect(failed).toBeDefined()
  const said = `${failed!.stdout}${failed!.stderr}`
  expect(said).not.toMatch(/unknown option/)
  expect(said).toMatch(/the gate needs a git work tree/)
}, 60_000)
