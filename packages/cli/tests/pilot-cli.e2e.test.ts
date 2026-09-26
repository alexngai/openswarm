/**
 * Plan mode end to end (docs/05 pilot): real `runCli`, real dsh subprocess
 * members in real worktrees of a scratch repo, real landings — keyless.
 *
 * Threads run concurrently across subprocesses, so the dsh mock's single FIFO
 * script would hand a tool call to whichever member asked first. A small router
 * picks the reply from the conversation instead: a member's first turn gets a
 * bash call, the turn after the tool result gets the closing text. Every member
 * (coordinator plan, worker, synthesis) is then exactly two requests, whatever
 * the interleaving. The closing text parses as a one-item numbered plan, so each
 * thread is plan → one worker → synthesis with the production coordinator spec.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { runCli } from '../src/index'
import { loadPlan } from '../src/pilot'

const originalCwd = process.cwd()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  process.chdir(originalCwd)
  delete process.env['OPENSWARM_PILOT_PLAN']
  delete process.env['OPENSWARM_PILOT_ARM']
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function startRouter(command: string): Promise<{ baseURL: string; requests: () => number }> {
  const common = { apiKey: 'mock-key', repeatLast: true, chunkDelayMs: 0 }
  const tool = await startMockLlmServer({
    ...common,
    sequence: ['tool_call_success'],
    toolName: 'bash',
    toolArguments: JSON.stringify({ command }),
  })
  const done = await startMockLlmServer({ ...common, sequence: ['success'], successText: '1. implement the assignment' })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const last = JSON.parse(body.toString()).messages?.at(-1)
      const target = new URL(last?.role === 'tool' ? done.baseURL : tool.baseURL)
      const upstream = request(
        { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers)
          reply.pipe(res)
        },
      )
      upstream.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await tool.close()
    await done.close()
  })
  const { port } = server.address() as { port: number }
  process.env['OPENSWARM_LLM_BASE_URL'] = `http://127.0.0.1:${port}/v1`
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests: () => tool.requests.length + done.requests.length }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim()

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-pilot-e2e-'))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

/** t0 first; t1 and t2 both build on it. Extra fields belong to other tools. */
function writePlan(threads?: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'openswarm-plan-')), 'plan.json')
  writeFileSync(
    path,
    JSON.stringify({
      threads: threads ?? [
        { id: 't0', assignment: 'land the contracts', paths: ['src/api.ts'], default: true },
        { id: 't1', assignment: 'build on them', blockedBy: ['t0'] },
        { id: 't2', assignment: 'build on them too', blockedBy: ['t0'] },
      ],
    }),
  )
  return path
}

/** Each worker records what its worktree held when cut, in a file named by its branch. */
const LIST_TREE = 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); ls > "out-$b.txt"'

async function run(argv: string[]) {
  const lines: string[] = []
  const code = await runCli(
    ['--headless', '--output-format', 'json', '--model', 'mock-model', ...argv, 'ship the roadmap'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  const events = lines.map((l) => JSON.parse(l))
  const pilot = events.find((e) => e.type === 'pilot')
  const threads = Object.fromEntries((pilot?.threads ?? []).map((t: any) => [t.id, t]))
  return { code, events, pilot, threads, stop: events.at(-1) }
}

/** The one file a thread's work added, and its content on the thread's branch. */
function threadFile(repo: string, thread: { id: string; baseSha: string }): { name: string; content: string } {
  const name = git(repo, 'diff', '--name-only', thread.baseSha, `pilot/${thread.id}`)
  return { name, content: git(repo, 'show', `pilot/${thread.id}:${name}`) }
}

it('program arm: dependents cut from the post-landing HEAD and see landed work', async () => {
  const router = await startRouter(LIST_TREE)
  const repo = scratchRepo()
  const base = git(repo, 'rev-parse', 'HEAD')
  process.chdir(repo)
  // The env path, alongside the `--single` swarmkit always emits.
  process.env['OPENSWARM_PILOT_PLAN'] = writePlan()
  process.env['OPENSWARM_PILOT_ARM'] = 'program'

  const { code, events, pilot, threads, stop } = await run(['--single'])
  expect(code).toBe(0)
  expect(pilot.arm).toBe('program')
  expect(events.filter((e) => e.type === 'team_note').map((e) => e.thread).sort()).toEqual(['t0', 't1', 't2'])

  // (c) all three landed into the workspace checkout, which is left clean.
  for (const id of ['t0', 't1', 't2']) expect(threads[id].landed).toBe('merged')
  expect(git(repo, 'ls-files').split('\n').filter((f) => f.startsWith('out-'))).toHaveLength(3)
  expect(git(repo, 'status', '--porcelain')).toBe('')

  // (a) t1/t2 were cut from HEAD right after t0 landed, so t0's file is in their trees.
  const landT0 = git(repo, 'log', '--format=%H %s')
    .split('\n')
    .find((l) => l.endsWith('pilot: land t0'))!
    .split(' ')[0]
  expect(threads.t0.baseSha).toBe(base)
  expect(threads.t1.baseSha).toBe(landT0)
  expect(threads.t2.baseSha).toBe(landT0)
  expect(threads.t1.startMs).toBeGreaterThanOrEqual(threads.t0.endMs)
  const t0File = threadFile(repo, threads.t0).name
  expect(threadFile(repo, threads.t1).content).toContain(t0File)
  expect(threadFile(repo, threads.t2).content).toContain(t0File)

  // (e) every token is member-side (the lead never calls the model), counted
  // exactly once: the mock bills 3 input tokens per request.
  expect(stop.type).toBe('message_stop')
  expect(router.requests()).toBeGreaterThan(0)
  expect(stop.usage.inputTokens).toBe(3 * router.requests())
  expect(stop.usage.outputTokens).toBeGreaterThan(0)
}, 180_000)

it('sharded arm: every thread cut from the original base, all landed at the end', async () => {
  const router = await startRouter(LIST_TREE)
  const repo = scratchRepo()
  const base = git(repo, 'rev-parse', 'HEAD')
  process.chdir(repo)

  const { code, threads, stop } = await run(['--plan', writePlan(), '--arm', 'sharded'])
  expect(code).toBe(0)
  // (b) blockedBy does not delay a sharded cut: nobody saw anybody's work.
  for (const id of ['t0', 't1', 't2']) {
    expect(threads[id].baseSha).toBe(base)
    expect(threads[id].landed).toBe('merged')
  }
  expect(threadFile(repo, threads.t1).content).not.toContain(threadFile(repo, threads.t0).name)
  // Landed in plan order, after every thread finished.
  expect(git(repo, 'log', '--first-parent', '--format=%s', '-3').split('\n')).toEqual([
    'pilot: land t2',
    'pilot: land t1',
    'pilot: land t0',
  ])
  expect(Math.min(...Object.values(threads).map((t: any) => t.endMs))).toBeGreaterThanOrEqual(
    Math.max(...Object.values(threads).map((t: any) => t.startMs)),
  )
  expect(stop.type).toBe('message_stop')
  expect(stop.usage.inputTokens).toBe(3 * router.requests())
}, 180_000)

it('a conflicting landing is recorded, aborted, and the run still ends cleanly', async () => {
  // Branch-named content in one shared file: whichever thread lands second conflicts.
  const router = await startRouter('git rev-parse --abbrev-ref HEAD > shared.txt')
  const repo = scratchRepo()
  process.chdir(repo)

  const { code, threads, stop } = await run(['--plan', writePlan(), '--arm', 'sharded'])
  // (d) conflicts are data, not failures.
  expect(code).toBe(0)
  expect(threads.t0.landed).toBe('merged')
  expect(threads.t1.landed).toBe('conflict')
  expect(threads.t2.landed).toBe('conflict')
  expect(threads.t1.commits).toBeGreaterThan(0)
  expect(git(repo, 'status', '--porcelain')).toBe('')
  expect(stop.type).toBe('message_stop')
  expect(stop.usage.inputTokens).toBe(3 * router.requests())
}, 180_000)

it('--max-tokens sees member usage and still reports a result', async () => {
  await startRouter(LIST_TREE)
  const repo = scratchRepo()
  process.chdir(repo)

  const { code, events, pilot, stop } = await run(['--plan', writePlan(), '--arm', 'program', '--max-tokens', '1'])
  expect(code).toBe(3)
  expect(events.find((e) => e.type === 'budget_exceeded')?.limit).toMatch(/max-tokens/)
  expect(pilot).toBeDefined()
  expect(stop.type).toBe('message_stop')
  expect(stop.usage.inputTokens).toBeGreaterThan(1)
}, 180_000)

it('rejects bad plans and arms before booting anything', async () => {
  const bad = (threads: unknown[]) => () => loadPlan(writePlan(threads))
  expect(bad([{ id: 'a', assignment: 'x' }, { id: 'a', assignment: 'y' }])).toThrow(/duplicate/)
  expect(bad([{ id: 'a', assignment: 'x', blockedBy: ['nope'] }])).toThrow(/unknown thread "nope"/)
  expect(bad([{ id: 'a', assignment: 'x', blockedBy: ['b'] }, { id: 'b', assignment: 'y', blockedBy: ['a'] }])).toThrow(/cycle/)
  expect(loadPlan(writePlan()).threads.map((t) => t.blockedBy)).toEqual([[], ['t0'], ['t0']])

  const lines: string[] = []
  const code = await runCli(
    ['--output-format', 'json', '--model', 'mock-model', '--plan', writePlan(), '--arm', 'bogus', 'go'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(1)
  expect(lines.map((l) => JSON.parse(l)).find((e) => e.type === 'error')?.message).toMatch(/unknown arm "bogus"/)
  expect(
    await runCli(['--model', 'mock-model', '--plan', writePlan(), '--arm', 'program', '--team', 'go'], {
      out: () => {},
      err: () => {},
    }),
  ).toBe(1)
})
