/**
 * `openswarm tasks sync` (docs/05 B0, projection first): a run journal
 * mirrored into a real opentasks daemon, started in-process in a temp dir.
 * Asserted through the opentasks client: nodes, edges, statuses, attempts
 * and verdicts; a re-sync creates nothing, even after the map is lost; new
 * journal events transition only what changed; one syncer per run; a map
 * from another graph, a missing daemon and a dead lead stop it clearly.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDaemonWithStore } from 'opentasks'
import { createClient, type OpenTasksClient } from 'opentasks/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SwarmBoard, SwarmJournal, type PeerTeamSpec, type SwarmRunEvent, type SwarmRunRecord } from 'openswarm-swarm'
import { runControl } from '../src/index'
import { connectOpenTasks, repoHolding, resolveSocket, syncRun, type SyncMapping } from '../src/tasks'

type Daemon = Awaited<ReturnType<typeof createDaemonWithStore>>
const daemons: Daemon[] = []
let daemon: Daemon
let client: OpenTasksClient
/** A daemon in its own temp dir; os.tmpdir(), not a deeper scratch dir: macOS caps a socket path at 104 bytes. */
async function startDaemon(): Promise<Daemon> {
  const dir = mkdtempSync(join(tmpdir(), 'ot-'))
  const started = await createDaemonWithStore({ locationPath: dir, version: '0.2.0', registryPath: join(dir, 'registry.json') })
  await started.start()
  daemons.push(started)
  return started
}
const originalHome = process.env['OPENSWARM_HOME']
beforeEach(async () => {
  daemon = await startDaemon()
  client = createClient({ socketPath: daemon.socketPath })
})
afterEach(async () => {
  client.disconnect()
  for (const d of daemons.splice(0)) await d.stop()
  process.env['OPENSWARM_HOME'] = originalHome
})

const spec: PeerTeamSpec = {
  topology: 'peer-team',
  intent: { purpose: 'ship the widget API', endState: 'npm test passes' },
  members: [{ name: 'm1' }, { name: 'm2' }],
  tasks: [
    { subject: 'schema', prompt: 'write the schema' },
    { subject: 'api', prompt: 'build the api', blockedBy: [0] },
    { subject: 'docs', prompt: 'document it', checks: [] },
    { subject: 'flaky', prompt: 'fix the flake' },
  ],
  gate: { checks: ['npm test'] },
}

/**
 * A gated peer-team run as its lead journals it: schema passes its gate in
 * round 2, api is in progress, docs fails review and is accepted by a person,
 * flaky fails and is released. The writer is this process unless `pid` says.
 */
async function journalRun(runDir: string, pid = process.pid) {
  const journal = SwarmJournal.open(join(runDir, 'journal.jsonl'))
  const run: SwarmRunRecord = {
    id: 'run-sync',
    status: 'running',
    topology: 'peer-team',
    parentSessionId: 'lead',
    writer: { pid, host: hostname(), incarnation: journal.incarnation },
    startedAt: Date.now(),
    spec,
  }
  await journal.append('swarm/run', { version: 1, run } satisfies SwarmRunEvent)
  const board = new SwarmBoard(journal, { gated: true })
  const schema = await board.create({ subject: 'schema', prompt: 'write the schema' })
  const api = await board.create({ subject: 'api', prompt: 'build the api', blockedBy: [schema.id] })
  const docs = await board.create({ subject: 'docs', prompt: 'document it', checks: [] })
  const flaky = await board.create({ subject: 'flaky', prompt: 'fix the flake' })

  let s = await board.claim(schema.id, 'm1', schema.revision)
  const gate = { member: 'm1', changed: true, kind: 'commands' as const }
  await board.recordGate({ ...gate, taskId: schema.id, round: 1, passed: false, failedCommands: ['npm test'], snapshot: 'aaa1' })
  await board.recordGate({ ...gate, taskId: schema.id, round: 2, passed: true, snapshot: 'aaa2' })
  s = await board.complete(schema.id, 'm1', s.revision, 'done', { kind: 'commands', passed: true, round: 2, snapshot: 'aaa2' })

  let d = await board.claim(docs.id, 'm1', docs.revision)
  await board.recordGate({ taskId: docs.id, member: 'm1', round: 1, changed: true, kind: 'review', passed: false, score: 40, snapshot: 'ddd1' })
  d = await board.complete(docs.id, 'm1', d.revision, 'docs', { kind: 'human', passed: true, by: 'owner' })

  const f = await board.claim(flaky.id, 'm2', flaky.revision)
  await board.recordGate({ taskId: flaky.id, member: 'm2', round: 1, changed: true, kind: 'commands', passed: false, failedCommands: ['npm test'], snapshot: 'fff1' })
  await board.release(flaky.id, 'm2', f.revision)

  const a = await board.claim(api.id, 'm2', api.revision)
  return { journal, board, run, a }
}

/** What one sync of {@link journalRun} writes: run + 4 tasks + 4 attempts + 3 verifiers; 4 implements + 1 blocks + 4 verdicts + 1 waiver. */
const NODES = 12
const EDGES = 10

const node = (id: string) => client.getNode(id) as Promise<Record<string, any>>
const edges = async (filter: { from_id?: string; to_id?: string; type?: string }) =>
  (await client.query({ edges: filter as never, verbose: true, limit: 10_000 })).items as Record<string, any>[]
/** Every node and edge in the graph (graph.query: the query tool stops at 100 nodes). */
const counts = async () => ({
  nodes: (await client.call<unknown[]>('graph.query', { limit: 1_000_000 })).length,
  edges: (await client.query({ edges: {}, limit: 1_000_000 })).total,
})
const mapOf = (runDir: string): SyncMapping => JSON.parse(readFileSync(join(runDir, 'opentasks.json'), 'utf8'))

/** One control verb, its output captured (`out`/`err` filled as it runs). */
async function ctl(argv: string[], out: string[] = [], err: string[] = []) {
  const code = await runControl(argv, { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'openswarm-tasks-home-'))
  process.env['OPENSWARM_HOME'] = home
  return home
}

it('mirrors a run into opentasks: context, tasks, edges, statuses, attempts and verdicts; a re-sync creates nothing', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'openswarm-tasks-sync-'))
  const { journal } = await journalRun(runDir)

  const first = await syncRun(runDir, { client })
  expect(first).toMatchObject({ nodes: { created: NODES, adopted: 0 }, edges: { created: EDGES, adopted: 0 }, transitions: 5, errors: [], settled: false })
  const map = mapOf(runDir)
  expect(map.seq).toBe(journal.events.at(-1)!.seq)
  const id = (task: string) => map.tasks[task]!.node

  const run = await node(map.run!)
  expect(run).toMatchObject({ type: 'context', title: 'openswarm peer-team run-sync', tags: ['openswarm', 'run:run-sync'] })
  expect(run['content']).toContain('Purpose: ship the widget API')
  expect(run['content']).toContain('- flaky')

  expect(await node(id('task-0'))).toMatchObject({
    type: 'task',
    title: 'schema',
    content: 'write the schema',
    status: 'closed',
    assignee: 'm1',
    tags: ['openswarm', 'run:run-sync'],
    metadata: { openswarm: { runId: 'run-sync', taskId: 'task-0', key: 'task-0', checks: ['npm test'] } },
  })
  expect(await node(id('task-1'))).toMatchObject({ status: 'in_progress', assignee: 'm2' })
  expect(await node(id('task-2'))).toMatchObject({ status: 'closed', metadata: { openswarm: { checks: [] } } })
  const flaky = await node(id('task-3'))
  expect(flaky['status']).toBe('open') // released, and the run is still running
  expect(flaky['assignee']).toBeUndefined()

  expect((await edges({ to_id: map.run!, type: 'implements' })).map((e) => e['from_id']).sort()).toEqual(
    ['task-0', 'task-1', 'task-2', 'task-3'].map(id).sort(),
  )
  expect((await edges({ from_id: id('task-0'), type: 'blocks' })).map((e) => e['to_id'])).toEqual([id('task-1')])

  // One attempt per gate round, each verified (or not) by its gate's verifier node.
  const rounds = journal.events.filter((e) => e.type === 'swarm/gate')
  const attempts = await Promise.all(rounds.map((e) => node(map.attempts[e.seq]!)))
  expect(attempts.map((a) => [a['target_id'], a['assignee'], a['status'], a['metadata'].attempt.outcome, a['metadata'].attempt.evidence.hash])).toEqual([
    [id('task-0'), 'm1', 'closed', 'failure', 'aaa1'],
    [id('task-0'), 'm1', 'closed', 'success', 'aaa2'],
    [id('task-2'), 'm1', 'closed', 'failure', 'ddd1'],
    [id('task-3'), 'm2', 'closed', 'failure', 'fff1'],
  ])
  expect(attempts[0]!['metadata'].attempt.evidence).toMatchObject({ kind: 'command', ref: 'npm test' })
  const verdicts = await Promise.all(rounds.map(async (e) => (await edges({ to_id: map.attempts[e.seq]!, type: 'verifies' })).map((v) => v['metadata'])))
  expect(verdicts.map((vs) => vs.map((v) => [v.verdict, v.verifier]))).toEqual([
    [['fail', 'openswarm-gate:commands']],
    [['pass', 'openswarm-gate:commands']],
    // The review failed; a person waived the gate on that attempt.
    expect.arrayContaining([['fail', 'openswarm-gate:review'], ['pass', 'human:owner']]),
    [['fail', 'openswarm-gate:commands']],
  ])
  expect(verdicts[1]![0]).toMatchObject({ evidence: { hash: 'aaa2' }, verifiedAt: expect.any(String) })
  expect(await node(map.verifiers['human:owner']!)).toMatchObject({ type: 'context', title: 'human:owner (run-sync)' })

  // Re-sync: nothing new, so nothing written; an unrelated event changes nothing either.
  expect(await counts()).toEqual({ nodes: NODES, edges: EDGES })
  const nothing = { nodes: { created: 0, adopted: 0 }, edges: { created: 0, adopted: 0 }, transitions: 0, errors: [], settled: false }
  expect(await syncRun(runDir, { client })).toMatchObject(nothing)
  await journal.append('swarm/steer', { version: 1, to: 'm2', text: 'hurry', delivery: 'enqueue', by: 'owner' })
  expect(await syncRun(join(runDir, 'journal.jsonl'), { client })).toMatchObject(nothing)
  expect(await counts()).toEqual({ nodes: NODES, edges: EDGES })
})

it('a lost or corrupt map re-adopts the graph: node and edge counts stay unchanged', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'openswarm-tasks-sync-'))
  await journalRun(runDir)
  await syncRun(runDir, { client })
  const before = mapOf(runDir)

  rmSync(join(runDir, 'opentasks.json'))
  const readopt = { nodes: { created: 0, adopted: NODES }, edges: { created: 0, adopted: EDGES }, transitions: 0, errors: [] }
  expect(await syncRun(runDir, { client })).toMatchObject(readopt)
  expect(await counts()).toEqual({ nodes: NODES, edges: EDGES })
  expect(mapOf(runDir)).toEqual(before)

  writeFileSync(join(runDir, 'opentasks.json'), '{"version":1,"seq":')
  expect(await syncRun(runDir, { client })).toMatchObject(readopt)
  expect(await counts()).toEqual({ nodes: NODES, edges: EDGES })
  expect(mapOf(runDir)).toEqual(before)
})

it('a later sync transitions only what changed: a completion, and the tasks a failed run leaves abandoned', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'openswarm-tasks-sync-'))
  const { journal, board, run, a } = await journalRun(runDir)
  await syncRun(runDir, { client })

  await board.recordGate({ taskId: a.id, member: 'm2', round: 1, changed: true, kind: 'commands', passed: true, snapshot: 'bbb1' })
  await board.complete(a.id, 'm2', a.revision, 'api done', { kind: 'commands', passed: true, round: 1, snapshot: 'bbb1' })
  await journal.append('swarm/run', { version: 1, run: { ...run, status: 'failed', error: 'swarm board abandoned 1 task(s)', endedAt: Date.now() } } satisfies SwarmRunEvent)

  // api: in_progress → complete; flaky: open → abandon. One new attempt and its verdict; the verifier exists.
  expect(await syncRun(runDir, { client })).toMatchObject({
    nodes: { created: 1, adopted: 0 },
    edges: { created: 1, adopted: 0 },
    transitions: 2,
    errors: [],
    settled: true,
  })
  const map = mapOf(runDir)
  expect(await node(map.tasks['task-1']!.node)).toMatchObject({ status: 'closed', assignee: 'm2' })
  expect(await node(map.tasks['task-3']!.node)).toMatchObject({ status: 'abandoned' })
  expect(await node(map.tasks['task-0']!.node)).toMatchObject({ status: 'closed' })
  expect(map.tasks['task-3']).toMatchObject({ status: 'abandoned' })
})

it('`openswarm tasks sync` prints the graph it syncs to; a missing daemon names how to start one', async () => {
  const home = freshHome()
  await journalRun(join(home, 'runs', 'run-sync'))
  expect(await ctl(['tasks', 'sync', 'run-sync', '--socket', daemon.socketPath])).toEqual({
    code: 0,
    out: `run-sync → ${daemon.socketPath}: ${NODES} node(s) created, 0 adopted; ${EDGES} edge(s) created, 0 adopted; 5 transition(s)`,
    err: '',
  })
  const missing = await ctl(['tasks', 'sync', 'run-sync', '--socket', join(home, 'nope.sock')])
  expect(missing.code).toBe(1)
  expect(missing.err).toMatch(/no opentasks daemon reachable at .*nope\.sock/)
  expect(missing.err).toContain('npx opentasks daemon start')
  expect((await ctl(['tasks', 'sync'])).code).toBe(2)
  await expect(connectOpenTasks(join(tmpdir(), 'no-such-opentasks.sock'))).rejects.toThrow(/OPENTASKS_PROJECT_DIR/)
})

it('one syncer per run: a second is refused while the first holds the lock, and a dead syncer’s lock is taken over', async () => {
  const home = freshHome()
  await journalRun(join(home, 'runs', 'run-sync'))
  const sync = () => ctl(['tasks', 'sync', 'run-sync', '--socket', daemon.socketPath])
  const [one, two] = await Promise.all([sync(), sync()])
  expect([one.code, two.code].sort()).toEqual([0, 1])
  expect((one.code === 1 ? one : two).err).toMatch(/another `openswarm tasks sync` \(pid \d+\) is syncing this run/)
  expect(await counts()).toEqual({ nodes: NODES, edges: EDGES })
  expect(existsSync(join(home, 'runs', 'run-sync', 'opentasks.lock'))).toBe(false)

  writeFileSync(join(home, 'runs', 'run-sync', 'opentasks.lock'), `${spawnSync(process.execPath, ['-e', '']).pid}\n`)
  expect((await sync()).code).toBe(0)
})

it('a map from another graph stops the sync before it writes anything', async () => {
  const home = freshHome()
  await journalRun(join(home, 'runs', 'run-sync'))
  expect((await ctl(['tasks', 'sync', 'run-sync', '--socket', daemon.socketPath])).code).toBe(0)
  const other = await startDaemon()
  const stale = await ctl(['tasks', 'sync', 'run-sync', '--socket', other.socketPath])
  expect(stale.code).toBe(1)
  expect(stale.err).toContain('run run-sync was synced to a different graph')
  expect(stale.err).toContain('opentasks.json to re-project it')
  const fresh = createClient({ socketPath: other.socketPath })
  expect(await fresh.call<unknown[]>('graph.query', { limit: 1_000 })).toEqual([])
  fresh.disconnect()
})

it('--watch follows a live run until it settles, and stops when its writer dies', async () => {
  const home = freshHome()
  const { journal, run } = await journalRun(join(home, 'runs', 'run-sync'))
  const out: string[] = []
  const watching = ctl(['tasks', 'sync', 'run-sync', '--watch', '--socket', daemon.socketPath], out)
  while (out.length === 0) await sleep(20)
  await journal.append('swarm/run', { version: 1, run: { ...run, status: 'finished', endedAt: Date.now() } } satisfies SwarmRunEvent)
  const settled = await watching
  expect(settled.code).toBe(0)
  // A finished run leaves its uncompleted tasks abandoned: api (in progress) and flaky (released).
  expect(settled.out.split('\n').at(-1)).toMatch(/: 0 node\(s\) created, 0 adopted; 0 edge\(s\) created, 0 adopted; 2 transition\(s\)$/)

  const dead = freshHome()
  await journalRun(join(dead, 'runs', 'run-sync'), spawnSync(process.execPath, ['-e', '']).pid!)
  const orphaned = await ctl(['tasks', 'sync', 'run-sync', '--watch', '--socket', (await startDaemon()).socketPath])
  expect(orphaned.code).toBe(1)
  expect(orphaned.err).toMatch(/writer pid \d+ is gone.*openswarm attach run-sync/)
})

it('warns about a graph inside the repository, and discovery leaves no global store behind', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'openswarm-tasks-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  expect(repoHolding(join(repo, '.opentasks', 'daemon.sock'), repo)).toBeDefined()
  expect(repoHolding(join(repo, '.git', 'opentasks', 'daemon.sock'), repo)).toBeDefined()
  expect(repoHolding(join(tmpdir(), 'elsewhere', 'daemon.sock'), repo)).toBeUndefined()
  expect(repoHolding(join(repo, 'x.sock'), tmpdir())).toBeUndefined()

  const home = process.env['OPENTASKS_HOME']
  const global = join(mkdtempSync(join(tmpdir(), 'openswarm-ot-home-')), 'store')
  process.env['OPENTASKS_HOME'] = global
  try {
    await resolveSocket().catch(() => undefined)
    expect(existsSync(global)).toBe(false)
    expect(process.env['OPENTASKS_HOME']).toBe(global)
  } finally {
    if (home === undefined) delete process.env['OPENTASKS_HOME']
    else process.env['OPENTASKS_HOME'] = home
  }
})
