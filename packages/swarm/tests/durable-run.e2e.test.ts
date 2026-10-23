/**
 * Durable runs across hosts (docs/05 D1, exit criterion 2), keyless over a
 * real bare remote: host A runs a two-task peer-team mirrored to the remote,
 * finishes the first task and blocks in the second; host B steals the run
 * from its own clone. A, released, is fenced at its next push and lands
 * nothing; B lands the first task from the branch A pushed and reruns the
 * second. On the remote's journal each task completed once.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

const FAKE_GH = fileURLToPath(new URL('./support/fake-gh.mjs', import.meta.url))
const harnesses: TestHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close()
})

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()

/** The run's journal on the remote, as `cwd` fetches it: its events. */
function remoteEvents(cwd: string, runId: string): { type: string; data: any }[] {
  try {
    sh(cwd, 'fetch', '-q', 'origin', `+refs/swarm/${runId}:refs/swarm/${runId}`)
  } catch {
    return []
  }
  return sh(cwd, 'show', `refs/swarm/${runId}:journal.jsonl`)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

const completions = (events: { type: string; data: any }[], id: string) => events.filter((e) => e.type === 'swarm/task' && e.data.task.id === id && e.data.task.status === 'completed').length

async function until(what: string, ok: () => boolean, ms = 60_000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function host(command: string, turns = 2) {
  const h = await bootHarness({
    // Each task's turn: the bash call, then done.
    sequence: Array.from({ length: turns }, () => ['tool_call_success', 'success'] as const).flat(),
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command }),
  })
  harnesses.push(h)
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  return { h, member: { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } } }
}

/** A bare remote with a base commit, and clones `a`, `b` and `c` of it: three hosts in all but the machine. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-durable-run-'))
  const remote = join(dir, 'remote.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  const seed = join(dir, 'seed')
  execFileSync('git', ['clone', '-q', remote, seed])
  writeFileSync(join(seed, 'README.md'), 'base\n')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-qm', 'base')
  sh(seed, 'push', '-q', 'origin', 'HEAD:main')
  const [a, b, c] = ['a', 'b', 'c'].map((name) => {
    const path = join(dir, name)
    execFileSync('git', ['clone', '-q', remote, path])
    return path
  }) as [string, string, string]
  return { dir, a, b, c }
}

const write = 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"'
const twoTasks = {
  topology: 'peer-team' as const,
  members: [{ name: 'solo' }],
  tasks: [
    { subject: 'first', prompt: 'do the first task' },
    { subject: 'second', prompt: 'do the second task' },
  ],
}
const durable = { remote: 'origin', heartbeatMs: 30_000 }

it('a run taken over from another clone: the old writer is fenced and lands nothing, the taker lands both tasks, each completed once', async () => {
  const { dir, a, b } = world()
  const marker = join(dir, 'release-a')

  // Host A blocks in task-1 until released.
  const A = await host(`${write}; case "$b" in *task-1) while [ ! -f '${marker}' ]; do sleep 0.2; done;; esac`)
  const runA = await A.h.swarm.start(twoTasks, { parent: A.h.lead.agent, worktrees: { repoRoot: a, member: A.member }, durable })
  const settledA = runA.result.then(
    () => undefined,
    (e: unknown) => e,
  )
  await until('task-0 completed on the remote, task-1 under way on A', () => completions(remoteEvents(b, runA.id), 'task-0') === 1 && runA.board().list().some((t) => t.id === 'task-1' && t.status === 'in_progress'))

  // Host B steals it and finishes it.
  const B = await host(write, 1)
  const runB = await B.h.swarm.resume(runA.id, { parent: B.h.lead.agent, worktrees: { repoRoot: b, member: B.member }, durable }, { steal: true })
  writeFileSync(marker, '')
  const errorA = await settledA
  const resultB = await runB.result

  // A: fenced, nothing landed on its checkout.
  expect(String(errorA)).toMatch(/took run .* over|taken over by another host/)
  expect(sh(a, 'branch', '--list', 'swarm/*/integration')).toBe('')
  // B: both tasks landed, task-0 from the branch A pushed (A's work, unrun here).
  expect(resultB.git?.merged.map((m) => m.taskKey).sort()).toEqual(['task-0', 'task-1'])
  expect(sh(b, 'ls-tree', '--name-only', resultB.git!.targetBranch).split('\n').filter((f) => f.startsWith('out-'))).toHaveLength(2)
  const ranB = JSON.parse(readFileSync(join(B.h.runsDir, runA.id, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).at(-1)!)
  expect(ranB).toMatchObject({ type: 'swarm/run', data: { run: { status: 'finished' } } })
  // The remote's journal: each task completed once, the run finished, written by B.
  const events = remoteEvents(b, runA.id)
  expect(completions(events, 'task-0')).toBe(1)
  expect(completions(events, 'task-1')).toBe(1)
  expect(events.filter((e) => e.type === 'swarm/run').at(-1)).toMatchObject({ data: { run: { status: 'finished' } } })
  expect(existsSync(join(B.h.runsDir, runA.id, 'journal.jsonl'))).toBe(true)
}, 180_000)

it('a completed task that committed nothing is not adopted; a finished run is not resumed again', async () => {
  const { dir, a, b, c } = world()
  const marker = join(dir, 'release-a')
  // On A, task-0 changes nothing; task-1 blocks until released.
  const A = await host(`b=$(git rev-parse --abbrev-ref HEAD | tr / -); case "$b" in *task-1) while [ ! -f '${marker}' ]; do sleep 0.2; done;; esac`)
  const runA = await A.h.swarm.start(twoTasks, { parent: A.h.lead.agent, worktrees: { repoRoot: a, member: A.member }, durable })
  const settledA = runA.result.then(() => undefined, (e: unknown) => e)
  await until('task-0 completed on the remote', () => completions(remoteEvents(b, runA.id), 'task-0') === 1 && runA.board().list().some((t) => t.id === 'task-1' && t.status === 'in_progress'))
  const B = await host(write, 1)
  const runB = await B.h.swarm.resume(runA.id, { parent: B.h.lead.agent, worktrees: { repoRoot: b, member: B.member }, durable }, { steal: true })
  writeFileSync(marker, '')
  await settledA
  const resultB = await runB.result
  expect(resultB.git?.merged.map((m) => m.taskKey)).toEqual(['task-1'])
  // Finished on the remote: a third host has nothing to take over.
  const C = await host(write, 1)
  await expect(C.h.swarm.resume(runA.id, { parent: C.h.lead.agent, worktrees: { repoRoot: c, member: C.member }, durable }, { steal: true })).rejects.toThrow(/already finished/)
}, 180_000)

it('a cancelled durable run pushes nothing more, so its in-flight task is not completed on the remote; it is not taken over while its writer lives on this host; another host resumes it', async () => {
  const { dir, a, b } = world()
  const marker = join(dir, 'never')
  const A = await host(`${write}; while [ ! -f '${marker}' ]; do sleep 0.2; done`)
  const one = { ...twoTasks, tasks: [twoTasks.tasks[0]!] }
  const runA = await A.h.swarm.start(one, { parent: A.h.lead.agent, worktrees: { repoRoot: a, member: A.member }, durable })
  const settledA = runA.result.then(() => undefined, (e: unknown) => e)
  await until('task-0 under way on A', () => runA.board().list().some((t) => t.id === 'task-0' && t.status === 'in_progress'))
  // The same runs directory, its writer alive: refused even stealing.
  await expect(A.h.swarm.resume(runA.id, { parent: A.h.lead.agent, worktrees: { repoRoot: b, member: A.member }, durable }, { steal: true })).rejects.toThrow(/is live in pid/)
  runA.cancel()
  expect(String(await settledA)).toMatch(/cancelled/)
  const events = remoteEvents(b, runA.id)
  expect(completions(events, 'task-0')).toBe(0)
  expect(events.filter((e) => e.type === 'swarm/run').at(-1)).toMatchObject({ data: { run: { status: 'running' } } })
  const B = await host(write, 1)
  const resultB = await (await B.h.swarm.resume(runA.id, { parent: B.h.lead.agent, worktrees: { repoRoot: b, member: B.member }, durable }, { steal: true })).result
  expect(resultB.git?.merged.map((m) => m.taskKey)).toEqual(['task-0'])
  writeFileSync(marker, '')
}, 180_000)

it('a run cut off from its remote at landing lands nothing and stays resumable: its landing marker never reaches the remote', async () => {
  const { dir, a, b } = world()
  const remote = join(dir, 'remote.git')
  const marker = join(dir, 'release-a')
  const ghDir = join(dir, 'gh')
  mkdirSync(ghDir)
  process.env['FAKE_GH_DIR'] = ghDir
  const forge = { kind: 'github' as const, command: FAKE_GH, waitMs: 0, pollMs: 10 }
  const one = { ...twoTasks, tasks: [twoTasks.tasks[0]!] }
  const A = await host(`${write}; while [ ! -f '${marker}' ]; do sleep 0.2; done`)
  const runA = await A.h.swarm.start(one, { parent: A.h.lead.agent, worktrees: { repoRoot: a, member: A.member, forge }, durable })
  const settledA = runA.result.then(() => undefined, (e: unknown) => e)
  await until('task-0 under way on A', () => runA.board().list().some((t) => t.id === 'task-0' && t.status === 'in_progress'))
  // The remote goes away while A works: A's landing push cannot confirm it still holds the run.
  renameSync(remote, `${remote}.away`)
  writeFileSync(marker, '')
  expect(String(await settledA)).toMatch(/could not reach its remote/)
  renameSync(`${remote}.away`, remote)
  // Back: the remote never got A's landing marker, so another host takes the run over and lands it.
  expect(remoteEvents(b, runA.id).some((e) => e.type === 'swarm/durable')).toBe(false)
  const B = await host(write, 1)
  const resultB = await (await B.h.swarm.resume(runA.id, { parent: B.h.lead.agent, worktrees: { repoRoot: b, member: B.member, forge }, durable }, { steal: true })).result
  expect(resultB.git?.withheld.map((w) => w.taskKey)).toEqual(['task-0'])
}, 180_000)

it('a durable run must be a one-shot peer-team in worktrees', async () => {
  const A = await host('true')
  await expect(A.h.swarm.start({ topology: 'peer-team', members: [{ name: 'solo' }], tasks: [{ subject: 's', prompt: 'p' }] }, { parent: A.h.lead.agent, durable: { remote: 'origin' } })).rejects.toThrow(/needs worktrees/)
  await expect(
    A.h.swarm.start({ topology: 'fanout', members: [{ name: 'solo' }], tasks: [{ member: 'solo', prompt: 'p' }] }, { parent: A.h.lead.agent, worktrees: { repoRoot: tmpdir() }, durable: { remote: 'origin' } }),
  ).rejects.toThrow(/one-shot peer-team/)
  // A remote it cannot push to: it fails before any member runs.
  const { a } = world()
  await expect(A.h.swarm.start(twoTasks, { parent: A.h.lead.agent, worktrees: { repoRoot: a, member: A.member }, durable: { remote: 'no-such-remote' } })).rejects.toThrow(/could not push to its remote/)
  expect(A.h.mock.requests).toHaveLength(0)
}, 60_000)
