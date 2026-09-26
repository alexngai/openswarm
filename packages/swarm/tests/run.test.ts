/**
 * Durable runs (docs/05 A4): `start` returns a handle over a per-run journal
 * that records the run; `runs`, `view` and `attach` read that journal from
 * any process. Journals written directly stand in for a previous process.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SwarmBoard, SwarmJournal, type FanoutResult, type SwarmRunEvent, type TeamSpec } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

/** Statuses of every run record in a journal file, in order. */
const statuses = (path: string) =>
  SwarmJournal.read(path)
    .filter((e) => e.type === 'swarm/run')
    .map((e) => (e.data as SwarmRunEvent).run.status)

/** A pid that no longer exists: a child that has already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

/** A run journal as another process left it: a `running` record, then its board's writes. */
async function foreignRun(runsDir: string, id: string, writer: { pid: number; host: string }) {
  const journal = SwarmJournal.open(join(runsDir, id, 'journal.jsonl'))
  await journal.append('swarm/run', {
    version: 1,
    run: {
      id,
      status: 'running',
      topology: 'peer-team',
      parentSessionId: 'a-previous-lead',
      writer: { ...writer, incarnation: journal.incarnation },
      startedAt: Date.now() - 60_000,
    },
  } satisfies SwarmRunEvent)
  return { journal, board: new SwarmBoard(journal) }
}

const oneTask = (subject: string): TeamSpec => ({
  topology: 'peer-team',
  members: [{ name: 'm' }],
  tasks: [{ subject, prompt: `do ${subject}` }],
})

it("start's handle resolves to runTeam's result, recorded running → finished", async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'same answer' })
  const spec: TeamSpec = { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'go' }] }
  const run = await h.swarm.start(spec, { parent: h.lead.agent })
  expect(run.id).toMatch(/^run-[0-9a-f]{8}$/)
  expect(run.journal.path).toBe(join(h.runsDir, run.id, 'journal.jsonl'))
  const result = (await run.result) as FanoutResult
  const direct = (await h.swarm.runTeam(spec, { parent: h.lead.agent })) as FanoutResult

  // The same scripted outcome either way; only the member's subagent run id differs.
  const outcome = (r: FanoutResult) => r.results.map(({ runId: _runId, ...rest }) => rest)
  expect(outcome(result)).toEqual(outcome(direct))
  expect(statuses(run.journal.path)).toEqual(['running', 'finished'])
  const { run: record } = h.swarm.view(run.id)
  expect(record).toMatchObject({ id: run.id, topology: 'fanout', parentSessionId: h.lead.agent.session.id, spec })
  expect(record.result).toEqual(result)
})

it('a failing run is recorded failed with its error', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const run = await h.swarm.start({ topology: 'peer-team', members: [], tasks: [] }, { parent: h.lead.agent })
  await expect(run.result).rejects.toThrow('peer-team needs at least one member')
  expect(statuses(run.journal.path)).toEqual(['running', 'failed'])
  expect(h.swarm.view(run.id).run.error).toBe('peer-team needs at least one member')
})

it('two runs from one parent get separate journals and boards', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const first = await h.swarm.start(oneTask('one'), { parent: h.lead.agent })
  await first.result
  const second = await h.swarm.start(oneTask('two'), { parent: h.lead.agent })
  await second.result
  expect(second.journal.path).not.toBe(first.journal.path)
  expect(first.board().list().map((t) => t.subject)).toEqual(['one'])
  expect(second.board().list().map((t) => t.subject)).toEqual(['two'])
})

it("runs() lists a previous process's runs beside this one's", async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  await foreignRun(h.runsDir, 'run-0000dead', { pid: deadPid(), host: hostname() })
  // A directory whose journal holds no run record is not a run.
  await SwarmJournal.open(join(h.runsDir, 'not-a-run', 'journal.jsonl')).append('swarm/task', {})
  const live = await h.swarm.start(oneTask('one'), { parent: h.lead.agent })
  expect(h.swarm.runs().map((r) => [r.id, r.status])).toEqual([
    ['run-0000dead', 'running'],
    [live.id, 'running'],
  ])
  await live.result
  expect(h.swarm.runs().map((r) => r.status)).toEqual(['running', 'finished'])
})

it("attach takes over a dead writer's run: its claims are released, no task lost or duplicated", async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const { journal, board } = await foreignRun(h.runsDir, 'run-0000dead', { pid: deadPid(), host: hostname() })
  const a = await board.create({ subject: 'a', prompt: 'p' })
  const b = await board.create({ subject: 'b', prompt: 'p' })
  const c = await board.create({ subject: 'c', prompt: 'p' })
  await board.claim(a.id, 'alice', a.revision)
  const claimed = await board.claim(b.id, 'bob', b.revision)
  await board.complete(b.id, 'bob', claimed.revision, 'shipped')
  await board.claim(c.id, 'carol', c.revision)

  const attached = await h.swarm.attach('run-0000dead')
  expect(attached.released.map((t) => t.id).sort()).toEqual([a.id, c.id])
  expect(attached.run).toMatchObject({ status: 'interrupted', writer: { pid: process.pid, host: hostname() } })
  expect(attached.tasks).toHaveLength(3)
  expect(Object.fromEntries(attached.tasks.map((t) => [t.id, [t.status, t.owner]]))).toEqual({
    [a.id]: ['pending', undefined],
    [b.id]: ['completed', 'bob'],
    [c.id]: ['pending', undefined],
  })
  const recap = attached.recap.join('\n')
  expect(recap).toContain(`${a.id} released (was alice)`)
  expect(recap).toContain(`${c.id} released (was carol)`)
  expect(recap).toContain(`run interrupted; taken over by pid ${process.pid} on ${hostname()}`)
  // The dead writer's record stays in the history; the latest names this process.
  expect(statuses(journal.path)).toEqual(['running', 'interrupted'])

  // Settled now, so attaching again changes nothing.
  const bytes = readFileSync(journal.path)
  expect((await h.swarm.attach('run-0000dead')).released).toEqual([])
  expect(readFileSync(journal.path).equals(bytes)).toBe(true)
})

it('attach refuses a live writer, and view reads its board without touching the file', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const { journal, board } = await foreignRun(h.runsDir, 'run-00a11ve0', { pid: process.pid, host: hostname() })
  const task = await board.create({ subject: 's', prompt: 'p' })
  await board.claim(task.id, 'alice', task.revision)
  // A torn line, as a writer mid-append leaves one; opening the journal would cut it.
  appendFileSync(journal.path, '{"seq":3,"time":0,"ty')
  const bytes = readFileSync(journal.path)

  await expect(h.swarm.attach('run-00a11ve0')).rejects.toThrow(
    `run run-00a11ve0 is live in pid ${process.pid} on ${hostname()}; use view`,
  )
  const view = h.swarm.view('run-00a11ve0')
  expect(view.run.status).toBe('running')
  expect(view.tasks).toEqual(board.list())
  expect(readFileSync(journal.path).equals(bytes)).toBe(true)

  // A writer on another host is never judged dead from here, even with a dead pid.
  await foreignRun(h.runsDir, 'run-0e15e000', { pid: deadPid(), host: 'another-host' })
  await expect(h.swarm.attach('run-0e15e000')).rejects.toThrow(/is live in pid \d+ on another-host; use view/)
})

it('recap narrates the journal, and since skips what a reader has already seen', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const pid = deadPid()
  const { journal, board } = await foreignRun(h.runsDir, 'run-0000beef', { pid, host: 'elsewhere' })
  const task = await board.create({ subject: 'walls', prompt: 'p' })
  const claimed = await board.claim(task.id, 'alice', task.revision)
  await board.complete(task.id, 'alice', claimed.revision, 'raised\nand painted')
  const message = { id: 'msg-1', from: 'alice', to: 'bob', delivery: 'wakeup', text: 'hi' }
  await journal.append('swarm/message/queued', { version: 1, message })
  await journal.append('swarm/message/delivered', { version: 1, messageId: message.id })

  const all = h.swarm.view('run-0000beef').recap
  expect(all).toEqual([
    `#0 run started: peer-team (pid ${pid} on elsewhere)`,
    '#1 task-0 created: walls',
    '#2 task-0 claimed by alice',
    '#3 task-0 completed by alice: raised',
    '#4 message alice→bob queued (wakeup)',
    '#5 message alice→bob delivered',
  ])
  expect(h.swarm.view('run-0000beef', { since: 3 }).recap).toEqual(all.slice(4))
})

it('steer reaches an in-process messaging peer as its next turn, journaled', async () => {
  // Briefing, then a task turn slow enough to steer during, then the steer's turn.
  h = await bootHarness({
    sequence: ['success', 'slow_success', 'success'],
    repeatLast: true,
    successText: 'done',
    chunkSize: 1,
    chunkDelayMs: 150,
  })
  const run = await h.swarm.start(
    { topology: 'peer-team', messaging: true, members: [{ name: 'peer-a' }], tasks: [{ subject: 'one', prompt: 'do one' }] },
    { parent: h.lead.agent },
  )
  expect(h.swarm.live(run.id)).toBe(run)
  // Members are all spawned before the first claim, so a claim means peer-a is addressable.
  while (!run.board().list().some((t) => t.status === 'in_progress')) {
    await run.journal.waitForAppend(run.journal.events.length - 1, 1_000)
  }
  await expect(run.steer('nobody', 'hi')).rejects.toThrow(`run ${run.id} has no member "nobody"`)
  expect(await run.steer('peer-a', 'check the tests first')).toBe('enqueue')
  await run.result
  expect(h.swarm.live(run.id)).toBeUndefined()

  // The mailbox carried it as a waking message from the steerer, and the steer is on record.
  const data = (type: string) => run.journal.events.filter((e) => e.type === type).map((e) => e.data as any)
  expect(data('swarm/message/queued').map((d) => d.message)).toEqual([
    expect.objectContaining({ from: 'owner', to: 'peer-a', delivery: 'wakeup', text: 'check the tests first' }),
  ])
  expect(data('swarm/message/delivered')).toHaveLength(1)
  expect(data('swarm/steer')).toEqual([
    { version: 1, to: 'peer-a', text: 'check the tests first', delivery: 'enqueue', by: 'owner' },
  ])
  expect(h.swarm.view(run.id).recap).toContainEqual(expect.stringMatching(/^#\d+ steer owner→peer-a \(enqueue\): check the tests first$/))
  // peer-a's next turn opens on it.
  await vi.waitFor(() =>
    expect(h!.mock.requests.some((r) => JSON.stringify(r.body).includes('check the tests first'))).toBe(true),
  )
})

it('steer refuses a run with no addressable members', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })
  const run = await h.swarm.start(
    { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'go' }] },
    { parent: h.lead.agent },
  )
  await expect(run.steer('a', 'hi')).rejects.toThrow(`run ${run.id} (fanout) has no addressable members`)
  await run.result
  expect(run.journal.events.some((e) => e.type === 'swarm/steer')).toBe(false)
})
