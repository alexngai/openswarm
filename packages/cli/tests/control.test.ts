/**
 * The control verbs (docs/05 §6.1, A8), in-process through `runControl`: the
 * journal-only verbs over journals written directly into a temp
 * OPENSWARM_HOME, the direction verbs against a real app-server on the swarm
 * test boot, and exit criterion 2 (§7.3) as a real process kill: a lead in a
 * child process is SIGKILLed mid-task and `attach` takes its run over.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server'
import {
  SwarmBoard,
  SwarmJournal,
  coordinatorSpec,
  foldBoard,
  viewRun,
  type SwarmQuestion,
  type SwarmQuestionEvent,
  type SwarmRunEvent,
  type SwarmRunRecord,
  type SwarmTaskSnapshot,
  type TeamSpec,
} from 'openswarm-swarm'
import AppServer from '../../app-server/src/index'
import { bootHarness, type TestHarness } from '../../swarm/tests/boot'
import { runControl } from '../src/index'

const originalHome = process.env['OPENSWARM_HOME']
let h: TestHarness | undefined
let lead: ChildProcess | undefined
afterEach(async () => {
  lead?.kill('SIGKILL')
  lead = undefined
  await h?.ctx.swarmAppServer?.close()
  await h?.close()
  h = undefined
  process.env['OPENSWARM_HOME'] = originalHome
})

/** One control verb, its output captured. */
async function ctl(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runControl(argv, { out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** A fresh OPENSWARM_HOME for this test. */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'openswarm-control-'))
  process.env['OPENSWARM_HOME'] = home
  return home
}

/** A pid that no longer exists: a child that has already exited. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

/** A run journal as some process left it: its `running` record, by `pid` on this host. */
async function journalRun(id: string, pid: number, startedAt: number) {
  const journal = SwarmJournal.open(join(process.env['OPENSWARM_HOME']!, 'runs', id, 'journal.jsonl'))
  const run: SwarmRunRecord = {
    id,
    status: 'running',
    topology: 'peer-team',
    parentSessionId: 'a-previous-lead',
    writer: { pid, host: hostname(), incarnation: journal.incarnation },
    startedAt,
  }
  await journal.append('swarm/run', { version: 1, run } satisfies SwarmRunEvent)
  return { journal, board: new SwarmBoard(journal), run }
}

it('ps, board and questions read run journals directly, as text and as --json', async () => {
  freshHome()
  expect(await ctl('ps')).toEqual({ code: 0, out: 'no runs', err: '' })

  const minutes = (n: number) => Date.now() - n * 60_000
  const live = await journalRun('run-0000a11e', process.pid, minutes(1.5))
  const walls = await live.board.create({ subject: 'walls', prompt: 'p' })
  const roof = await live.board.create({ subject: 'roof', prompt: 'p' })
  await live.board.create({ subject: 'paint', prompt: 'p' })
  await live.board.complete(walls.id, 'alice', (await live.board.claim(walls.id, 'alice', walls.revision)).revision, 'up')
  await live.board.claim(roof.id, 'bob', roof.revision)
  const asked = {
    trigger: 'stall',
    kind: 'escalation',
    tier: 'low',
    prompt: 'bob is silent: restart or wait?',
    options: ['restart', 'wait'],
    default: 'restart',
    raisedAt: 0,
  } satisfies Partial<SwarmQuestion>
  const question = (q: Pick<SwarmQuestion, 'id' | 'status' | 'answer' | 'by'>) =>
    live.journal.append('swarm/question', { version: 1, question: { ...asked, ...q } } satisfies SwarmQuestionEvent)
  await question({ id: 'q-0', status: 'open' })
  await question({ id: 'q-1', status: 'answered', answer: 'wait', by: 'owner' })
  const done = await journalRun('run-00000d0e', process.pid, minutes(120))
  const spec: TeamSpec = { topology: 'fanout', members: [], tasks: [] }
  await done.journal.append('swarm/run', {
    version: 1,
    run: { ...done.run, status: 'finished', endedAt: Date.now(), spec, result: { topology: 'fanout', results: [] } },
  } satisfies SwarmRunEvent)
  const dead = deadPid()
  await journalRun('run-0000dead', dead, minutes(5))

  // Oldest first; a running run whose writer died is flagged.
  expect(await ctl('ps')).toEqual({
    code: 0,
    out: [
      'RUN           STATUS    TOPOLOGY   AGE  WRITER',
      `run-00000d0e  finished  peer-team  2h   pid ${process.pid}`,
      `run-0000dead  running   peer-team  5m   pid ${dead} (dead)`,
      `run-0000a11e  running   peer-team  1m   pid ${process.pid}`,
    ].join('\n'),
    err: '',
  })
  // The records, minus their bulky spec and result.
  const records = JSON.parse((await ctl('ps', '--json')).out)
  expect(records.map((r: SwarmRunRecord) => [r.id, r.status, r.writer.pid])).toEqual([
    ['run-00000d0e', 'finished', process.pid],
    ['run-0000dead', 'running', dead],
    ['run-0000a11e', 'running', process.pid],
  ])
  expect(records[0]).not.toHaveProperty('spec')
  expect(records[0]).not.toHaveProperty('result')

  expect((await ctl('board', 'run-0000a11e')).out.split('\n')).toEqual([
    'run-0000a11e  running  peer-team',
    'TASK    STATUS       OWNER  SUBJECT',
    'task-0  completed    alice  walls',
    'task-1  in_progress  bob    roof',
    'task-2  pending      -      paint',
    '1 open question(s)',
  ])
  expect(JSON.parse((await ctl('board', 'run-0000a11e', '--json')).out)).toEqual({
    run: 'run-0000a11e',
    status: 'running',
    tasks: live.board.list(),
    openQuestions: 1,
  })

  // Open questions of running runs; the answered one is gone.
  expect(await ctl('questions')).toEqual({
    code: 0,
    out: 'run-0000a11e q-0 (stall): bob is silent: restart or wait?\n  answer with one of: restart, wait (default restart)',
    err: '',
  })
  expect(JSON.parse((await ctl('questions', '--json')).out)).toEqual([
    { runId: 'run-0000a11e', ...asked, id: 'q-0', status: 'open' },
  ])
  expect(await ctl('questions', '--run', 'run-00000d0e')).toEqual({ code: 0, out: 'no open questions', err: '' })

  expect(await ctl('board', 'run-nope')).toEqual({ code: 1, out: '', err: 'unknown run "run-nope"' })
  expect(await ctl('board', '../runs')).toEqual({ code: 1, out: '', err: 'invalid run id "../runs"' })
  expect((await ctl('board')).code).toBe(2)
  expect((await ctl('ps', '--all')).err).toMatch(/^unknown option, or one missing its value: --all\nusage: /)
})

it('attach on a settled run prints its board and recap, and writes nothing', async () => {
  freshHome()
  const pid = deadPid()
  const { journal, board, run } = await journalRun('run-00000d0e', pid, Date.now())
  const task = await board.create({ subject: 'walls', prompt: 'p' })
  await board.complete(task.id, 'alice', (await board.claim(task.id, 'alice', task.revision)).revision, 'up')
  await journal.append('swarm/run', { version: 1, run: { ...run, status: 'finished', endedAt: Date.now() } } satisfies SwarmRunEvent)
  const bytes = readFileSync(journal.path)

  expect(await ctl('attach', 'run-00000d0e')).toEqual({
    code: 0,
    out: [
      'run-00000d0e  finished  peer-team',
      'TASK    STATUS     OWNER  SUBJECT',
      'task-0  completed  alice  walls',
      '0 open question(s)',
      `#0 run started: peer-team (pid ${pid} on ${hostname()})`,
      '#1 task-0 created: walls',
      '#2 task-0 claimed by alice',
      '#3 task-0 completed by alice: up',
      '#4 run finished',
    ].join('\n'),
    err: '',
  })
  expect(readFileSync(journal.path).equals(bytes)).toBe(true)
})

it("board prints the run's intent, a task's own end state, what a task closed on, and a finished run's result", async () => {
  freshHome()
  const { journal, board, run } = await journalRun('run-000001e7', deadPid(), Date.now())
  const walls = await board.create({ subject: 'walls', prompt: 'p', intent: { purpose: 'shelter', endState: 'walls stand' } })
  const roof = await board.create({ subject: 'roof', prompt: 'p', intent: { purpose: 'shelter', endState: 'the house is dry' } })
  await board.complete(walls.id, 'alice', (await board.claim(walls.id, 'alice', walls.revision)).revision, 'up')
  await board.complete(roof.id, 'alice', (await board.claim(roof.id, 'alice', roof.revision)).revision, 'on', {
    kind: 'review',
    passed: true,
    round: 2,
  })
  const spec: TeamSpec = { topology: 'peer-team', members: [{ name: 'alice' }], tasks: [], intent: { purpose: 'build a house', endState: 'the house is dry' } }
  const result = { topology: 'peer-team' as const, tasks: board.list(), runs: {} }
  await journal.append('swarm/run', { version: 1, run: { ...run, status: 'finished', endedAt: Date.now(), spec, result } } satisfies SwarmRunEvent)

  // roof's end state is the run's, so only walls' is printed.
  expect((await ctl('board', 'run-000001e7')).out.split('\n')).toEqual([
    'run-000001e7  finished  peer-team',
    'purpose: build a house',
    'end state: the house is dry',
    'TASK    STATUS     OWNER  SUBJECT',
    'task-0  completed  alice  walls',
    'task-1  completed  alice  roof',
    'task-0 end state: walls stand',
    'task-1 evidence: review, round 2',
    '0 open question(s)',
    'result:',
    '--- task-0 walls ---',
    'up',
    '',
    '--- task-1 roof ---',
    'on',
  ])
})

/** The mock's model on the test boot's DeepSeek route. */
const route = ['--provider', 'deepseek-official', '--model', 'mock-model']

/** A swarm test boot serving the app-server, with OPENSWARM_HOME on its runs directory as the CLI reads it. */
async function serve(mock: MockLlmServerOptions): Promise<TestHarness> {
  h = await bootHarness(mock)
  process.env['OPENSWARM_HOME'] = dirname(h.runsDir)
  h.ctx.plugin(AppServer, {})
  await new Promise<void>((resolve) => h!.ctx.inject(['swarmAppServer'], () => resolve()))
  await h.ctx.swarmAppServer.ready
  return h
}

/** `spec` as a JSON file for `openswarm start`. */
function specFile(spec: object): string {
  const path = join(mkdtempSync(join(tmpdir(), 'openswarm-spec-')), 'team.json')
  writeFileSync(path, JSON.stringify(spec))
  return path
}

it("start runs /swarm's team for a task over the socket; ps shows it, kill fails it", async () => {
  // Every model turn hangs, so the run stays live until killed.
  const { runsDir } = await serve({ sequence: ['stall'], repeatLast: true })
  const started = await ctl('start', 'fix the flaky test', '--workers', '2', ...route)
  expect(started.err).toBe('')
  const runId = started.out
  expect(runId).toMatch(/^run-[0-9a-f]{8}$/)
  expect(viewRun(runsDir, runId).run.spec).toEqual(coordinatorSpec('fix the flaky test', 2))
  expect((await ctl('ps')).out).toMatch(new RegExp(`^${runId}  running  coordinator  \\d+s +pid ${process.pid}$`, 'm'))

  expect(await ctl('kill', runId)).toEqual({ code: 0, out: `cancelled ${runId}`, err: '' })
  // (Its error is what the coordinator made of the abort, not the cancellation.)
  await vi.waitFor(async () =>
    expect(JSON.parse((await ctl('ps', '--json')).out)).toEqual([expect.objectContaining({ id: runId, status: 'failed' })]),
  )
  expect((await ctl('board', runId)).out.split('\n')[0]).toBe(`${runId}  failed  coordinator`)
  // The server's refusal, verbatim: a settled run is no longer live.
  expect(await ctl('kill', runId)).toEqual({ code: 1, out: '', err: `NOT_FOUND: run "${runId}" is not live in this process` })
})

it('steer over the socket reaches a messaging peer-team member as its next turn', async () => {
  // Briefing, then a task turn slow enough to steer during, then the steer's turn.
  const { runsDir } = await serve({
    sequence: ['success', 'slow_success', 'success'],
    repeatLast: true,
    successText: 'done',
    chunkSize: 1,
    chunkDelayMs: 150,
  })
  const spec = specFile({ topology: 'peer-team', messaging: true, members: [{ name: 'peer-a' }], tasks: [{ subject: 'one', prompt: 'do one' }] })
  const runId = (await ctl('start', spec, ...route)).out
  // Members are all spawned before the first claim, so a claim means peer-a is addressable.
  await vi.waitFor(() => expect(viewRun(runsDir, runId).tasks[0]?.status).toBe('in_progress'), { timeout: 10_000 })
  expect(await ctl('steer', runId, '--to', 'peer-a', 'check the tests first')).toEqual({ code: 0, out: 'enqueue', err: '' })
  expect(await ctl('steer', runId, '--to', 'nobody', 'hi')).toEqual({ code: 1, out: '', err: `run ${runId} has no member "nobody"` })
  await vi.waitFor(() => expect(viewRun(runsDir, runId).run.status).toBe('finished'), { timeout: 20_000 })
  expect(viewRun(runsDir, runId).recap).toContainEqual(
    expect.stringMatching(/^#\d+ steer owner→peer-a \(enqueue\): check the tests first$/),
  )
})

it('answer over the socket closes a question that waits; attach follows the live run to its end', async () => {
  await serve({ sequence: ['success'], repeatLast: true, successText: 'done' })
  // One tier whose command gate always fails, so the cascade asks: stop, or retry?
  const spec = specFile({ topology: 'cascade', tiers: [{ name: 't' }], task: 'hold', confidence: { commands: ['false'], tau: 1 } })
  const runId = (await ctl('start', spec, '--question-timeout', '60000', ...route)).out
  // Its writer is this process, alive: attach prints the recap, then follows.
  const following = ctl('attach', runId)
  await vi.waitFor(
    async () =>
      expect(JSON.parse((await ctl('questions', '--json')).out)).toEqual([
        expect.objectContaining({ runId, id: 'q-0', trigger: 'verifier-failure', options: ['stop', 'retry'], default: 'stop' }),
      ]),
    { timeout: 10_000 },
  )
  expect(await ctl('answer', runId, 'q-0', 'maybe')).toEqual({
    code: 1,
    out: '',
    err: 'INVALID_PARAMS: swarm/answer: answer must be one of stop, retry',
  })
  expect(await ctl('answer', runId, 'q-0', 'stop')).toEqual({ code: 0, out: 'answered q-0: stop', err: '' })
  const followed = await following
  expect(followed.code).toBe(0)
  expect(followed.out).toMatch(/^#\d+ q-0 raised \(verifier-failure\): /m)
  expect(followed.out).toMatch(/^#\d+ q-0 answered by owner: stop$/m)
  expect(followed.out.split('\n').at(-1)).toMatch(/^#\d+ run finished$/)
})

it('the direction verbs need a running app-server', async () => {
  const home = freshHome()
  const none = { code: 1, out: '', err: 'no app-server running; start one with `openswarm serve`' }
  expect(await ctl('kill', 'run-00000000')).toEqual(none)
  // The file a server that died left behind.
  writeFileSync(join(home, 'app-server.json'), JSON.stringify({ url: '127.0.0.1:9', token: 'stale', pid: deadPid() }))
  expect(await ctl('start', 'a task')).toEqual(none)
})

/** The child's first stdout line; rejects with its stderr if it exits first. */
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stderr!.on('data', (chunk) => (err += chunk))
    child.stdout!.on('data', (chunk) => {
      out += chunk
      if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n')))
    })
    child.once('exit', (code, signal) => reject(new Error(`the lead exited (${code ?? signal}) first: ${err}`)))
  })
}

// The lead child runs the swarm from its built dist.
const built = existsSync(fileURLToPath(new URL('../../swarm/dist/index.js', import.meta.url)))

it.skipIf(!built)(
  'a lead killed mid-task: attach from another process shows its board and a recap, releases its claims, and loses or duplicates no task',
  async () => {
    const home = freshHome()
    const subjects = ['one', 'two', 'three', 'four']
    const spec = {
      topology: 'peer-team',
      members: [{ name: 'a' }, { name: 'b' }],
      tasks: subjects.map((subject) => ({ subject, prompt: `do ${subject}` })),
    }
    const script = fileURLToPath(new URL('./support/lead.mjs', import.meta.url))
    lead = spawn(process.execPath, [script, JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const runId = await firstLine(lead)
    const journal = join(home, 'runs', runId, 'journal.jsonl')
    const board = () => [...foldBoard(SwarmJournal.read(journal)).values()]
    const count = (status: SwarmTaskSnapshot['status']) => board().filter((t) => t.status === status).length
    // Mid-task: one task done, and each member holding a claim on a turn that never ends.
    await vi.waitFor(() => expect([count('completed'), count('in_progress')]).toEqual([1, 2]), { timeout: 20_000, interval: 50 })
    const pid = lead.pid!
    lead.kill('SIGKILL')
    await once(lead, 'exit')
    const before = board()
    const claimed = before.filter((t) => t.status === 'in_progress')

    const { code, out, err } = await ctl('attach', runId, '--no-follow')
    expect(err).toBe('')
    expect(code).toBe(0)
    const after = viewRun(join(home, 'runs'), runId)
    expect(after.run).toMatchObject({ status: 'interrupted', writer: { pid: process.pid, host: hostname() } })
    // The same board with the dead lead's claims back to pending: every task once, none lost.
    expect(after.tasks.map((t) => t.subject).sort()).toEqual([...subjects].sort())
    const shape = (tasks: SwarmTaskSnapshot[]) => Object.fromEntries(tasks.map((t) => [t.id, [t.subject, t.status, t.owner]]))
    expect(shape(after.tasks)).toEqual(
      shape(before.map((t) => (t.status === 'in_progress' ? { ...t, status: 'pending', owner: undefined } : t))),
    )
    // Shown: the board, the released claims, and a recap through the takeover.
    expect(out).toContain(`${runId}  interrupted  peer-team\nTASK    STATUS     OWNER  SUBJECT\n`)
    expect(out).toContain(`released 2 claim(s) of dead writer pid ${pid}: ${claimed.map((t) => t.id).join(', ')}`)
    for (const task of claimed) expect(out).toMatch(new RegExp(`^#\\d+ ${task.id} released \\(was ${task.owner}\\)$`, 'm'))
    expect(out.split('\n').at(-1)).toMatch(new RegExp(`^#\\d+ run interrupted; taken over by pid ${process.pid} on `))
  },
)
