/**
 * The shared train across swarms (docs/05 D2, D3; exit criteria 1 and 3),
 * keyless. One process hosts a standalone train behind the socket carrier;
 * two swarms, each its own context, clone, journal and model mock, land
 * through it with the tokens the owner invited them with. Their tasks
 * conflict: the second to arrive is ejected, repaired by its own member's
 * resolver against the remote target, and lands on its second enqueue. The
 * target passes the train's check after every landing. A client reaches
 * nothing but the train: every other protocol method, and dsh's SDK
 * pass-through, is refused, and a revoked token cannot authenticate.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { SwarmJournal, dispatch, methodNames } from 'openswarm-swarm'
import AppServer from '../src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'

const harnesses: TestHarness[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const h of harnesses.splice(0)) {
    await (h as any).ctx?.swarmAppServer?.close()
    await h.close()
  }
})

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

/** Every member turn writes shared.txt: its branch's name, or a resolution over conflict markers. */
const WRITE = `if grep -q '^<<<<<<<' shared.txt 2>/dev/null; then printf 'resolved\\n' > shared.txt; else b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > shared.txt; fi`

async function swarm(): Promise<TestHarness> {
  const h = await bootHarness({
    sequence: Array.from({ length: 6 }, () => ['tool_call_success', 'success'] as const).flat(),
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: WRITE }),
  })
  harnesses.push(h)
  return h
}

async function client(url: string): Promise<{ request: (method: string, params?: object) => Promise<any> }> {
  const colon = url.lastIndexOf(':')
  const socket = connect({ host: url.slice(0, colon), port: Number(url.slice(colon + 1)) })
  sockets.push(socket)
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  return { request: (method, params = {}) => transport.request(method, params) }
}

it('two swarms in their own clones land through one train with their own tokens; a conflict is repaired by its swarm and lands; a client reaches only the train', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-train-mesh-'))
  const remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const seed = join(dir, 'seed')
  execFileSync('git', ['clone', '-q', remote, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-qm', 'base')
  sh(seed, 'push', '-q', 'origin', 'HEAD:main')
  const clone = (name: string) => {
    const path = join(dir, name)
    execFileSync('git', ['clone', '-q', remote, path])
    return path
  }
  const trainRoot = clone('train')
  sh(trainRoot, 'checkout', '-q', '--detach')

  // The train's host: a socket carrier and the train, which also hosts swarm A's run.
  const host = await swarm()
  const ctx = (host as any).ctx
  ctx.plugin(AppServer, {})
  await new Promise<void>((resolve) => ctx.inject(['swarmAppServer'], () => resolve()))
  await ctx.swarmAppServer.ready
  const train = await host.swarm.startTrain({ repoRoot: trainRoot, target: 'main', remote: 'origin', checks: ['test -f README.md'] })
  const url = ctx.swarmAppServer.url
  const owner = { role: 'owner' } as const
  const laptop = (await dispatch(ctx, owner, 'swarm/train/invite', { name: 'laptop' })) as { token: string }
  const ci = (await dispatch(ctx, owner, 'swarm/train/invite', { name: 'ci' })) as { token: string }

  const land = async (h: TestHarness, repoRoot: string, token: string) => {
    const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
    const run = await h.swarm.start(
      { topology: 'peer-team', members: [{ name: 'm' }], tasks: [{ subject: 'write shared.txt', prompt: 'write shared.txt' }] },
      { parent: h.lead.agent, worktrees: { repoRoot, member: { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } }, train: { url, token } } },
    )
    return { run, result: await run.result }
  }
  // Both swarms clone before either lands, so their work meets only on the target.
  const laptopRoot = clone('laptop')
  const ciRoot = clone('ci')
  const a = await land(host, laptopRoot, laptop.token)
  const other = await swarm()
  const b = await land(other, ciRoot, ci.token)

  expect(a.result.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  // Swarm B's work conflicted with A's on the target; its own member resolved it and it landed.
  expect(b.result.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  expect(b.result.git!.resolved!.map((r) => r.taskKey)).toEqual(['task-0'])
  sh(seed, 'pull', '-q', 'origin', 'main')
  expect(execFileSync('cat', [join(seed, 'shared.txt')], { encoding: 'utf8' })).toBe('resolved\n')

  // The train's journal: both principals' entries, B's first ejected as a conflict, then landed.
  const events = train.journal.events.filter((e) => e.type === 'shared/landed' || e.type === 'shared/ejected').map((e) => [e.type, (e.data as any).id.split('/')[0], (e.data as any).kind])
  expect(events).toEqual([
    ['shared/landed', 'laptop', undefined],
    ['shared/ejected', 'ci', 'conflict'],
    ['shared/landed', 'ci', undefined],
  ])
  // Every verified batch passed the check before it landed; the only remote is the bare one.
  expect(train.journal.events.filter((e) => e.type === 'shared/verified').every((e) => (e.data as any).passed)).toBe(true)
  expect(sh(trainRoot, 'remote')).toBe('origin')
  // Each swarm's own train journal carries its landing's evidence.
  for (const { run, h } of [{ run: a.run, h: host }, { run: b.run, h: other }]) {
    const own = SwarmJournal.read(join(h.runsDir, run.id, 'train.jsonl'))
    expect(own.some((e) => e.type === 'train/evidence' && (e.data as any).outcome === 'landed')).toBe(true)
  }

  // A client in a process that hosts runs reaches nothing but the train.
  const asClient = { role: 'client', client: 'laptop' } as const
  for (const [method, group] of methodNames()) {
    if (group === 'train') continue
    await expect(dispatch(ctx, asClient, method, { runId: a.run.id }), method).rejects.toThrow(`FORBIDDEN: client may not call ${method}`)
  }
  const socket = await client(url)
  await socket.request('swarm/auth', { token: laptop.token })
  await expect(socket.request('initialize', {})).rejects.toThrow(/FORBIDDEN/)
  expect((await socket.request('swarm/train/card')).target).toBe('main')
  // Revoked: the token no longer authenticates.
  await dispatch(ctx, owner, 'swarm/train/revoke', { name: 'ci' })
  const revoked = await client(url)
  await expect(revoked.request('swarm/auth', { token: ci.token })).rejects.toThrow(/unknown token/)
}, 240_000)
