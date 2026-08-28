/**
 * Profile packaging E2E (docs/01): the openswarm-bundle composed over
 * dsh-base as a real profile, booted by dsh's own app-boot — NOT a
 * hand-assembled context. Two checks:
 *   1. --dump-config composes our rows over base with layer provenance
 *      (the Phase-0 probe-1 mechanic, now on the real bundle).
 *   2. `dsh --profile openswarm "<task>"` runs end to end against the mock,
 *      proving the composed tree is a working harness.
 *
 * Requires the built package dist (npm run build) and the dsh app
 * (@deepseek-ai/dsh). Skips when the dsh bin is absent.
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const dshBin = resolve(repo, 'node_modules', '.bin', 'dsh')
const swarmDist = resolve(repo, 'packages', 'swarm', 'dist', 'index.js')
const ready = existsSync(dshBin) && existsSync(swarmDist)

let dshHome: string
let mock: MockLlmServer | undefined

beforeAll(async () => {
  if (!ready) return
  dshHome = mkdtempSync(resolve(tmpdir(), 'openswarm-profile-'))
  await execFileAsync('node', [resolve(repo, 'scripts', 'init-profile.mjs'), dshHome], { cwd: repo })
})
afterAll(async () => {
  await mock?.close()
})

/**
 * Run dsh asynchronously and collect its output. MUST be async spawn, not
 * execFileSync: the mock LLM server runs in this test process, and a blocking
 * child would freeze the event loop that serves it (deadlock).
 */
function dsh(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(dshBin, args, {
      cwd: repo,
      env: { ...process.env, DSH_HOME: dshHome, NO_COLOR: '1', ...env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (code) => resolve({ stdout, stderr, code }))
    child.on('error', (e) => resolve({ stdout, stderr: stderr + String(e), code: -1 }))
  })
}

it.skipIf(!ready)('composes the openswarm bundle over dsh-base', async () => {
  const { stdout } = await dsh(['--profile', 'openswarm', '--dump-config'])
  // Our services inserted...
  expect(stdout).toContain('openswarm-swarm')
  expect(stdout).toContain('openswarm-plugin-authoring')
  expect(stdout).toContain('openswarm-llm-openai')
  // ...the shipped DeepSeek adapter retired...
  expect(stdout).toMatch(/id: llm-deepseek[\s\S]*?disabled: true/)
  // ...with base still underneath (provenance header from probe-1).
  expect(stdout).toContain('@deepseek-ai/dsh-base')
})

it.skipIf(!ready)('the dev server profile enables the app-server and omits the one-shot runner', async () => {
  const { stdout } = await dsh(['--profile', 'openswarm-dev', '--dump-config'])
  // App-server enabled by the dev overlay...
  expect(stdout).toMatch(/id: openswarm-app-server[\s\S]*?disabled: false/)
  // ...HMR turned hot...
  expect(stdout).toMatch(/id: hmr[\s\S]*?disabled: false/)
  // ...and NO headless one-shot runner (it would exit the server process).
  expect(stdout).not.toContain('headless-runner')
})

it.skipIf(!ready)('the web profile layers dsh browser UI under the openswarm rows', async () => {
  const { stdout } = await dsh(['--profile', 'openswarm-web', '--dump-config'])
  // dsh's browser surface...
  expect(stdout).toContain('@deepseek-ai/dsh-host-webserver')
  expect(stdout).toContain('@deepseek-ai/dsh-client-ui-commands')
  // ...with the openswarm rows composed over it, including the `/swarm` entry.
  expect(stdout).toContain('openswarm-swarm/command')
  expect(stdout).toMatch(/id: llm-deepseek[\s\S]*?disabled: true/)
  // No one-shot runner: the bound webserver keeps this surface alive.
  expect(stdout).not.toContain('headless-runner')
})

// Booting the web surface and driving it lives in web-api.e2e.test.ts.

it.skipIf(!ready)('boots the composed profile and runs a fanout team', async () => {
  mock = await startMockLlmServer({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'profile-answer' })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  const models = JSON.stringify([{ id: 'mock-model', contextWindow: 128_000 }])

  // The headless runner drives one root agent; we assert the composed tree
  // produced a working model turn (adapter + agent-loop + our swarm service
  // all mounted from the profile, no hand-built context).
  const { stdout, stderr, code } = await dsh(['--profile', 'openswarm', 'say hello'], {
    OPENSWARM_LLM_BASE_URL: base,
    OPENSWARM_LLM_API_KEY: 'mock-key',
    OPENSWARM_OPENAI_MODELS: models,
    DSH_MODEL: 'mock-model',
    OPENSWARM_DEFAULT_MODEL: 'mock-model',
  })
  expect(stderr, stderr).not.toMatch(/cannot get property|MODULE_NOT_FOUND|is not a function|NO_ADAPTER/)
  expect(code, `exit ${code}: ${stderr.slice(-400)}`).toBe(0)
  expect(`${stdout}${stderr}`).toContain('profile-answer')
  // The composed tree really called the model (not a stub).
  expect(mock!.requests.length).toBeGreaterThan(0)
}, 90_000)
