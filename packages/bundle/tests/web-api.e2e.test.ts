/**
 * The `openswarm-web` surface driven over its real HTTP api-gateway — the
 * exact path the browser uses, minus the browser (docs/03).
 *
 * Composition tests prove rows are PRESENT; these prove the surface WORKS:
 * a session is created on an agent preset, the browser's command list carries
 * `/swarm`, and executing it runs a real coordinator team whose model turns
 * reach the scripted mock through our own adapter.
 *
 * Wire contract (reverse-engineered from `dsh-client-connection` +
 * `dsh-api-gateway`, both mounted in this profile):
 *   POST /api/<endpoint>  content-type: application/json
 *   { type: 'client-request', rpcId, method: <endpoint>, payload }
 * Static endpoints (`session.create`) take a plain payload; typert Remotes
 * (`commands/execute`) take `{ args: { …named } }`. The browser-trust fence
 * admits a loopback Host with no Origin, which is what fetch() sends here.
 *
 * Requires the built dist (npm run build) and the dsh app; skips without them.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer, type MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'

const execFileAsync = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const dshBin = resolve(repo, 'node_modules', '.bin', 'dsh')
const ready =
  existsSync(dshBin) &&
  existsSync(resolve(repo, 'packages', 'swarm', 'dist', 'command.js')) &&
  existsSync(resolve(repo, 'packages', 'swarm-client', 'dist', 'client.js'))

let dshHome: string
const running: { child: ChildProcess; mock: MockLlmServer }[] = []

beforeAll(async () => {
  if (!ready) return
  dshHome = mkdtempSync(resolve(tmpdir(), 'openswarm-web-api-'))
  await execFileAsync('node', [resolve(repo, 'scripts', 'init-profile.mjs'), dshHome], { cwd: repo })
})
afterAll(async () => {
  for (const { child, mock } of running) {
    child.kill('SIGTERM')
    await mock.close()
  }
})

interface WebSurface {
  url: string
  pid: number
  mock: MockLlmServer
  /** One gateway call; returns the decoded `result` envelope. */
  rpc(method: string, payload: unknown): Promise<any>
}

/**
 * Boot the web profile against a scripted mock and wait for its bind. dsh
 * prints the URL only after the whole tree settles, so reaching this point is
 * itself proof every row in the composition resolved.
 */
async function bootWeb(
  script: MockLlmServerOptions,
  env: Record<string, string> = {},
): Promise<WebSurface> {
  const mock = await startMockLlmServer({ apiKey: 'mock-key', ...script })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  const child = spawn(dshBin, ['--profile', 'openswarm-web', '--port', '0', '--no-open'], {
    cwd: repo,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NO_COLOR: '1',
      OPENSWARM_LLM_BASE_URL: base,
      OPENSWARM_LLM_API_KEY: 'mock-key',
      OPENSWARM_OPENAI_MODELS: JSON.stringify([{ id: 'mock-model', contextWindow: 128_000 }]),
      OPENSWARM_DEFAULT_MODEL: 'mock-model',
      OPENSWARM_DEFAULT_PROVIDER: 'openai',
      ...env,
    },
  })
  running.push({ child, mock })

  let output = ''
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`no URL line in 60s:\n${output}`)), 60_000)
    const scan = (d: Buffer) => {
      output += d
      const match = /https?:\/\/[\d.]+:\d+/.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolveUrl(match[0])
      }
    }
    child.stdout!.on('data', scan)
    child.stderr!.on('data', scan)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`exited ${code} before binding:\n${output}`))
    })
  })

  let seq = 0
  return {
    url,
    pid: child.pid!,
    mock,
    async rpc(method, payload) {
      const response = await fetch(`${url}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `r${seq++}`, method, payload }),
      })
      expect(response.status, `${method} HTTP status`).toBe(200)
      const body = (await response.json()) as any
      expect(body.result, `${method} failed: ${JSON.stringify(body.result?.error)}`).toMatchObject({
        ok: true,
      })
      return body.result.value
    },
  }
}

it.skipIf(!ready)('serves the built UI, the Swarm tab, and both carriers', async () => {
  const home = mkdtempSync(resolve(tmpdir(), 'openswarm-web-home-'))
  const web = await bootWeb({ sequence: ['success'], repeatLast: true, successText: 'x' }, { OPENSWARM_HOME: home })
  const response = await fetch(web.url)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('<!doctype html>')
  // The web carrier's `@Remote` methods answer on the same gateway, owner-only, no token.
  expect(await web.rpc('swarm/runs', { args: {} })).toEqual({ runs: expect.any(Array) })

  // dsh's client-modules found the `dsh.client` package and serves its bundle.
  const bundle = await fetch(`${web.url}/plugins/openswarm-swarm-client/client.js`)
  expect(bundle.status).toBe(200)
  expect(await bundle.text()).toMatch(/^window\.__ModuleLoader__\.load\(\{ id: "openswarm-swarm-client", factory: /)

  // The socket carrier is up in the same process, for the CLI's direction verbs.
  const file = resolve(home, 'app-server.json')
  const deadline = Date.now() + 10_000
  while (!existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    url: expect.stringMatching(/^127\.0\.0\.1:\d+$/),
    token: expect.any(String),
    pid: web.pid,
  })
}, 90_000)

it.skipIf(!ready)('lists and executes /swarm --wait over the api-gateway', async () => {
  // Every scripted turn returns the same text: as the coordinator's plan it is
  // a two-item numbered list, and as a worker/synthesis answer it is prose.
  const web = await bootWeb({
    sequence: ['success'],
    repeatLast: true,
    successText: '1. inspect the parser\n2. add the test',
  })

  // A session on an agent preset — the web surface composes the agent plane
  // behind presets, unlike the headless profile every other test uses.
  const session = await web.rpc('session.create', {})
  expect(session.agentPreset).toBe('standard')

  // The command the browser's palette reads, from the real registry.
  const listed = await web.rpc('commands/list', { args: { agentId: session.sessionId } })
  expect(listed.map((c: any) => c.name)).toContain('swarm')
  expect(listed.find((c: any) => c.name === 'swarm').input.hint).toBe('[--wait] [--workers <n>] <task>')

  const execution = await web.rpc('commands/execute', {
    args: {
      agentId: session.sessionId,
      line: '/swarm --wait --workers 2 refactor the parser',
      images: [],
    },
  })
  expect(execution.result.kind).toBe('success')
  expect(execution.result.text).toContain('2 subtask(s) across 2 worker(s)')
  expect(execution.result.text).toContain('[worker-1] inspect the parser')
  expect(execution.result.text).toContain('[worker-2] add the test')
  // plan + 2 subtasks + synthesis: the team really ran, through our adapter.
  expect(web.mock.requests.length).toBe(4)
}, 120_000)

it.skipIf(!ready)('/swarm returns at once over the api-gateway; the run settles without waking the lead, and the next turn carries its outcome', async () => {
  const web = await bootWeb(
    { sequence: ['success'], repeatLast: true, successText: '1. inspect the parser\n2. add the test' },
    { OPENSWARM_HOME: mkdtempSync(resolve(tmpdir(), 'openswarm-web-home-')) },
  )
  const session = await web.rpc('session.create', {})
  const execution = await web.rpc('commands/execute', {
    args: { agentId: session.sessionId, line: '/swarm --workers 2 refactor the parser', images: [] },
  })
  expect(execution.result.kind).toBe('success')
  const runId = /^Started (run-[0-9a-f]{8}): coordinator with 2 worker\(s\)\./.exec(execution.result.text)?.[1]
  expect(runId, execution.result.text).toBeDefined()

  // The run outlives the request that started it, and its synthesis is where the Swarm tab reads it.
  const deadline = Date.now() + 60_000
  let view = await web.rpc('swarm/view', { args: { runId } })
  while (view.run.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    view = await web.rpc('swarm/view', { args: { runId } })
  }
  expect(view.run.status).toBe('finished')
  expect(view.run.result.synthesis.text).toBe('1. inspect the parser\n2. add the test')
  // The team's 4 turns plus the one lead turn the start message opens on a
  // blank session (dsh titling the session is not a turn). The settled
  // outcome is injected, and tool-jobs' completion notice suppressed, so
  // neither wakes the lead for another.
  const turns = () => web.mock.requests.filter((r) => !JSON.stringify(r.body).includes('Generate the session title')).length
  expect(turns()).toBe(5)
  await new Promise((r) => setTimeout(r, 1_500))
  expect(turns()).toBe(5)

  // The next turn the person starts carries the outcome as context.
  await web.rpc('session.prompt', { sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'what did the swarm find?' }] })
  const deadlineNext = Date.now() + 30_000
  let next: string | undefined
  while (next === undefined && Date.now() < deadlineNext) {
    await new Promise((r) => setTimeout(r, 100))
    next = web.mock.requests.map((r) => JSON.stringify(r.body)).find((b) => b.includes('what did the swarm find?'))
  }
  expect(next).toContain(`/swarm run ${runId} settled.`)
  expect(next).toContain('Swarm finished: 2 subtask(s) across 2 worker(s).')
}, 120_000)

it.skipIf(!ready)(
  'a lead-scope plugin mount goes through the real approval seam and is refused fail-closed',
  async () => {
    // The F3 gate is only worth anything if it reaches the REAL ApprovalService
    // in the REAL surface. `danger-full-access` resolves the base `approval`
    // row to policy `never`, which settles every ask `rejected` deterministically
    // without an interactive answerer — so this asserts the fail-closed path
    // end to end. The granted path needs a human at a browser.
    const web = await bootWeb(
      {
        sequence: ['tool_call_success', 'success'],
        repeatLast: true,
        successText: 'done',
        toolName: 'swarm_author_plugin',
        toolArguments: JSON.stringify({
          name: 'probe',
          scope: 'lead',
          source: 'export function apply(ctx){}',
        }),
      },
      { DSH_PERMISSION_MODE: 'danger-full-access' },
    )
    const session = await web.rpc('session.create', {})
    // session.prompt only ACCEPTS the turn; the run settles asynchronously.
    const accepted = await web.rpc('session.prompt', {
      sessionId: session.sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: 'author a lead-scope plugin' }],
    })
    expect(accepted.accepted).toBe(true)

    const deadline = Date.now() + 60_000
    let events: any[] = []
    while (Date.now() < deadline) {
      events = (await web.rpc('session.history', { sessionId: session.sessionId })).events
      if (events.some((e) => e.event.type === 'approval/decided')) break
      await new Promise((r) => setTimeout(r, 250))
    }
    const typed = (type: string) => events.filter((e) => e.event.type === type).map((e) => e.event.data)

    // The tool is in the preset-composed agent's catalog at all...
    expect(typed('tool/call').map((d: any) => d.message?.content?.[0]?.toolName ?? d.name)).toContainEqual(
      expect.stringContaining('swarm_author_plugin'),
    )
    // ...the gate asked the real seam, naming the tool and its blast radius...
    const [asked] = typed('approval/asked')
    expect(asked).toMatchObject({ toolName: 'swarm_author_plugin' })
    expect(asked.reason).toContain('SHARED harness')
    // ...the seam settled it under session policy, and the audit pair matches...
    const [decided] = typed('approval/decided')
    expect(decided).toMatchObject({ id: asked.id, outcome: 'rejected' })
    // ...and the model was told the mount was refused, not that it succeeded.
    expect(JSON.stringify(typed('tool/result'))).toContain('lead-scope mount not approved')
  },
  120_000,
)
