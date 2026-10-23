/**
 * Harness-raised questions (docs/05 §6.1, A6): one queue per run, in its
 * journal. A question resolves on the first of an answer (the handle, the
 * protocol, or dsh's ctx.userQuestions) and its timeout's default, and is
 * capped past `maxOpen` open questions.
 */
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import UserQuestionService, {
  type AskUserQuestionAnswerItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import SwarmService, {
  SwarmJournal,
  dispatch,
  foldQuestions,
  type Principal,
  type RunHandle,
  type RunTeamOptions,
  type SwarmQuestionEvent,
  type SwarmQuestionRequest,
  type SwarmRunEvent,
} from '../src/index'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.close()
  h = undefined
})

const boot = () => bootHarness({ sequence: ['success'], repeatLast: true, successText: 'done' })

/** A run held live until `release()`: a one-tier cascade whose command gate waits on it. */
async function heldRun(questions?: RunTeamOptions['questions']) {
  let pass!: (score: number) => void
  const gate = new Promise<number>((resolve) => (pass = resolve))
  const run = await h!.swarm.start(
    { topology: 'cascade', tiers: [{ name: 't' }], task: 'hold', confidence: { commands: ['true'], tau: 1 } },
    { parent: h!.lead.agent, confidenceRunner: () => gate, ...(questions === undefined ? {} : { questions }) },
  )
  return { run, release: () => (pass(1), run.result) }
}

const which = (extra: Partial<SwarmQuestionRequest> = {}): SwarmQuestionRequest => ({
  trigger: 'stall',
  prompt: 'a or b?',
  options: ['a', 'b'],
  default: 'a',
  ...extra,
})

/** The run's questions as its journal folds them. */
const questions = (run: RunHandle) => [...foldQuestions(run.journal.events).values()]

/** Resolves once the journal shows `n` open questions. */
const opened = (run: RunHandle, n = 1) =>
  vi.waitFor(() => expect(questions(run).filter((q) => q.status === 'open')).toHaveLength(n))

it('a question takes the first of an answer and its timeout; with no timeout, its default at once', async () => {
  h = await boot()
  const { run, release } = await heldRun({ timeoutMs: 60_000 })
  const answered = run.ask(which())
  await opened(run)
  run.answer('q-0', 'b', 'owner')
  expect(await answered).toBe('b')
  expect(questions(run)).toEqual([
    expect.objectContaining({ id: 'q-0', trigger: 'stall', kind: 'escalation', tier: 'low', status: 'answered', answer: 'b', by: 'owner' }),
  ])
  expect(h.swarm.view(run.id).recap).toContainEqual(expect.stringMatching(/^#\d+ q-0 answered by owner: b$/))

  const timed = await heldRun({ timeoutMs: 50 })
  expect(await timed.run.ask(which())).toBe('a')
  // The default: a run started without `questions` never waits.
  const unattended = await heldRun()
  const t0 = Date.now()
  expect(await unattended.run.ask(which())).toBe('a')
  expect(Date.now() - t0).toBeLessThan(500)
  for (const { run } of [timed, unattended]) {
    expect(questions(run).map((q) => [q.status, q.answer, q.by])).toEqual([['defaulted', 'a', undefined]])
    const snapshots = run.journal.events.filter((e) => e.type === 'swarm/question')
    expect(snapshots.map((e) => (e.data as SwarmQuestionEvent).question.status)).toEqual(['open', 'defaulted'])
  }
  await Promise.all([release(), timed.release(), unattended.release()])
})

it('past maxOpen a question is capped at its default; the run ending defaults the rest', async () => {
  h = await boot()
  const { run, release } = await heldRun({ timeoutMs: 60_000 })
  const pending = [run.ask(which()), run.ask(which()), run.ask(which())]
  expect(await run.ask(which({ trigger: 'task-attempts' }))).toBe('a')
  await opened(run, 3)
  await release()
  expect(await Promise.all(pending)).toEqual(['a', 'a', 'a'])

  const view = h.swarm.view(run.id)
  expect(view.questions.map((q) => [q.id, q.status, q.answer])).toEqual([
    ['q-0', 'defaulted', 'a'],
    ['q-1', 'defaulted', 'a'],
    ['q-2', 'defaulted', 'a'],
    ['q-3', 'capped', 'a'],
  ])
  const recap = view.recap.map((line) => line.replace(/^#\d+ /, ''))
  expect(recap).toContain('q-0 raised (stall): a or b?')
  expect(recap).toContain('q-3 capped (task-attempts): defaulted to a')
  // Closed ahead of the run's own record.
  expect(recap.slice(-2)).toEqual(['q-2 defaulted to a', 'run finished'])
})

it('answer refuses an option the question lacks, and a question that is unknown or closed', async () => {
  h = await boot()
  const { run, release } = await heldRun({ timeoutMs: 60_000 })
  const asked = run.ask(which())
  expect(() => run.answer('q-0', 'c', 'owner')).toThrow('question q-0 takes a or b, not "c"')
  expect(() => run.answer('q-9', 'a', 'owner')).toThrow(`run ${run.id} has no open question "q-9"`)
  run.answer('q-0', 'a', 'owner')
  expect(() => run.answer('q-0', 'b', 'owner')).toThrow(`run ${run.id} has no open question "q-0"`)
  expect(await asked).toBe('a')
  await release()
})

it("a cancelled run's questions take their defaults at once", async () => {
  h = await boot()
  const { run, release } = await heldRun({ timeoutMs: 60_000 })
  // Cancelled before its tier finishes, the run may fail without the gate.
  const failed = run.result.catch((error: Error) => error.message)
  const asked = run.ask(which())
  run.cancel()
  expect(await asked).toBe('a')
  expect(await run.ask(which())).toBe('a')
  void release()
  expect(await failed).toBe(`run ${run.id} cancelled`)
})

it("dsh's ctx.userQuestions may answer first, as userQuestions, and is withdrawn when it does not", async () => {
  h = await boot()
  h.ctx.plugin(UserQuestionService)
  await new Promise<void>((resolve) => h!.ctx.inject(['userQuestions'], () => resolve()))
  const requests: AskUserQuestionRequest[] = []
  const replies: Record<string, Omit<AskUserQuestionAnswerItem, 'id'>> = {
    'reply b': { selected: ['b'] },
    'reply B typed': { selected: [], custom: ' B ' },
    'reply junk': { selected: [], custom: 'maybe' },
  }
  // Like dsh's web provider, which shows a question in the asking agent's session.
  h.ctx.userQuestions.registerProvider({
    ask: (request) => {
      requests.push(request)
      if (request.agent === undefined) return Promise.reject(new Error('web user interaction requires an agent-owned session'))
      const [item] = request.questions
      const reply = replies[item!.question]
      return reply === undefined ? new Promise(() => {}) : Promise.resolve({ answers: [{ id: item!.id, ...reply }] })
    },
  })
  const { run, release } = await heldRun({ timeoutMs: 60_000 })
  expect(await run.ask(which({ prompt: 'reply b' }))).toBe('b')
  const { agent, ...request } = requests[0]!
  expect(agent).toBe(h.lead.agent)
  expect(request).toEqual({
    questions: [
      {
        id: 'q-0',
        header: `swarm ${run.id}`,
        question: 'reply b',
        detail: 'Defaults to a in 60s.',
        options: [{ label: 'a' }, { label: 'b' }],
      },
    ],
    signal: expect.any(AbortSignal),
  })
  expect(await run.ask(which({ prompt: 'reply B typed' }))).toBe('b')

  // A reply naming no option is no answer, and one still pending is withdrawn
  // once another answer closes its question.
  const junk = run.ask(which({ prompt: 'reply junk' }))
  const silent = run.ask(which({ prompt: 'no reply' }))
  await opened(run, 2)
  run.answer('q-2', 'a', 'owner')
  run.answer('q-3', 'b', 'owner')
  expect([await junk, await silent]).toEqual(['a', 'b'])
  expect(requests[3]!.signal!.aborted).toBe(true)
  expect(questions(run).map((q) => [q.id, q.answer, q.by])).toEqual([
    ['q-0', 'b', 'userQuestions'],
    ['q-1', 'b', 'userQuestions'],
    ['q-2', 'a', 'owner'],
    ['q-3', 'b', 'owner'],
  ])

  // An unattended run asks nobody.
  const unattended = await heldRun()
  await unattended.run.ask(which())
  expect(requests).toHaveLength(4)
  await Promise.all([release(), unattended.release()])
})

it('swarm/answer: the owner answers any question, a driver only low-tier escalations, a viewer or member none', async () => {
  h = await boot()
  const { run, release } = await heldRun({ timeoutMs: 60_000 })
  const low = run.ask(which())
  const high = run.ask(which({ tier: 'high' }))
  const consent = run.ask(which({ kind: 'consent' }))
  await opened(run, 3)
  const answer = (principal: Principal, questionId: string, choice = 'b') =>
    dispatch(h!.ctx, principal, 'swarm/answer', { runId: run.id, questionId, answer: choice }).then(
      (result) => result,
      (error: Error) => error.message,
    )
  const driver: Principal = { role: 'driver' }

  expect(await answer({ role: 'viewer' }, 'q-0')).toBe('FORBIDDEN: viewer may not call swarm/answer')
  expect(await answer({ role: 'member', runId: run.id, member: 't' }, 'q-0')).toBe(
    'FORBIDDEN: member may not call swarm/answer',
  )
  expect(await answer(driver, 'q-1')).toBe('FORBIDDEN: driver may not answer high-tier escalation q-1')
  expect(await answer(driver, 'q-2')).toBe('FORBIDDEN: driver may not answer low-tier consent q-2')
  expect(await answer(driver, 'q-0', 'c')).toBe('INVALID_PARAMS: swarm/answer: answer must be one of a, b')
  expect(await answer(driver, 'q-0')).toEqual({ answered: true })
  expect(await low).toBe('b')
  expect(await answer(driver, 'q-0')).toBe(`NOT_FOUND: run ${run.id} has no open question "q-0"`)
  expect(await answer({ role: 'owner' }, 'q-1', 'a')).toEqual({ answered: true })
  expect(await answer({ role: 'owner' }, 'q-2')).toEqual({ answered: true })
  expect([await high, await consent]).toEqual(['a', 'b'])
  expect(questions(run).map((q) => [q.id, q.by])).toEqual([
    ['q-0', 'driver'],
    ['q-1', 'owner'],
    ['q-2', 'owner'],
  ])
  await release()
  expect(await answer({ role: 'owner' }, 'q-0')).toBe(`NOT_FOUND: run "${run.id}" is not live in this process`)
})

it('swarm/questions lists open questions of live runs; a bound principal sees only its run', async () => {
  h = await boot()
  const a = await heldRun({ timeoutMs: 60_000 })
  const b = await heldRun({ timeoutMs: 60_000 })
  void a.run.ask(which())
  void b.run.ask(which())
  void b.run.ask(which({ prompt: 'another' }))
  await opened(a.run, 1)
  await opened(b.run, 2)
  const owner: Principal = { role: 'owner' }
  const list = async (principal: Principal, params: object = {}) => {
    const { questions } = (await dispatch(h!.ctx, principal, 'swarm/questions', params)) as {
      questions: { runId: string; id: string }[]
    }
    return questions.map((q) => `${q.runId === a.run.id ? 'a' : q.runId === b.run.id ? 'b' : q.runId}/${q.id}`)
  }

  expect(await list(owner)).toEqual(['a/q-0', 'b/q-0', 'b/q-1'])
  expect(await list(owner, { runId: b.run.id })).toEqual(['b/q-0', 'b/q-1'])
  const bound: Principal[] = [
    { role: 'viewer', runId: a.run.id },
    { role: 'member', runId: a.run.id, member: 't' },
  ]
  for (const principal of bound) {
    expect(await list(principal)).toEqual(['a/q-0'])
    expect(await list(principal, { runId: a.run.id })).toEqual(['a/q-0'])
    await expect(dispatch(h.ctx, principal, 'swarm/questions', { runId: b.run.id })).rejects.toThrow(
      `FORBIDDEN: swarm/questions: this principal is bound to run ${a.run.id}`,
    )
  }

  // Settled runs closed theirs; a run not live here is folded from its journal.
  await Promise.all([a.release(), b.release()])
  expect(await list(owner)).toEqual([])
  expect(await list(owner, { runId: a.run.id })).toEqual([])
  const journal = SwarmJournal.open(join(h.runsDir, 'run-0000dead', 'journal.jsonl'))
  await journal.append('swarm/run', {
    version: 1,
    run: {
      id: 'run-0000dead',
      status: 'running',
      topology: 'peer-team',
      parentSessionId: 'a-previous-lead',
      writer: { pid: 1, host: 'elsewhere', incarnation: journal.incarnation },
      startedAt: 0,
    },
  } satisfies SwarmRunEvent)
  await journal.append('swarm/question', {
    version: 1,
    question: { ...which(), id: 'q-0', kind: 'escalation', tier: 'low', status: 'open', raisedAt: 0 },
  } satisfies SwarmQuestionEvent)
  expect(await list(owner, { runId: 'run-0000dead' })).toEqual(['run-0000dead/q-0'])
})

it('swarm/start gives a run questions that wait for a person, 5 minutes unless told otherwise', async () => {
  h = await boot()
  const start = vi.spyOn(SwarmService.prototype, 'start')
  const spec = { topology: 'fanout', members: [{ name: 'a' }], tasks: [{ member: 'a', prompt: 'go' }] }
  const route = { provider: 'deepseek-official', model: 'mock-model' }
  const started = [
    await dispatch(h.ctx, { role: 'owner' }, 'swarm/start', { spec, ...route }),
    await dispatch(h.ctx, { role: 'owner' }, 'swarm/start', { spec, ...route, questionTimeoutMs: 0 }),
  ] as { runId: string }[]
  expect(start.mock.calls.map(([, options]) => options.questions)).toEqual([{ timeoutMs: 300_000 }, { timeoutMs: 0 }])
  await Promise.all(started.map(({ runId }) => h!.swarm.live(runId)?.result))
})
