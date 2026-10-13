/**
 * Budgets (docs/05 C5, exit criterion 2). The guard over a journal with
 * scripted usage: a scope out of budget asks once while its starts wait,
 * `stop` refuses every later start, `extend` grows the limit, a dollar limit
 * over unpriced usage asks at once, and a task's budget is its own. Then two
 * keyless team runs: a run budget stops new member runs and what passed
 * still lands through the train; a task budget abandons only its task.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  AbandonedTasksError,
  BudgetGuard,
  BudgetStopError,
  SwarmJournal,
  emptyUsage,
  type Budget,
  type SwarmBudgetEvent,
  type SwarmQuestionRequest,
  type SwarmUsageEvent,
} from '../src/index'
import { bootHarness, type TestHarness } from './boot'

const journal = () => SwarmJournal.open(join(mkdtempSync(join(tmpdir(), 'openswarm-budget-')), 'journal.jsonl'))

function spend(j: SwarmJournal, tokens: number, extra: Partial<SwarmUsageEvent> = {}) {
  return j.append('swarm/usage', {
    version: 1,
    member: 'm',
    role: 'task',
    runtime: 'dsh:sdk',
    model: 'model-a',
    runId: 'r',
    usage: { ...emptyUsage(), inputTokens: tokens, calls: 1 },
    startedAt: 0,
    ...extra,
  } satisfies SwarmUsageEvent)
}

function guard(j: SwarmJournal, answers: string[], budgets: { run?: Budget; tasks?: Record<string, Budget> }, priced = true) {
  const asked: SwarmQuestionRequest[] = []
  const g = new BudgetGuard({
    journal: j,
    ask: async (q) => {
      asked.push(q)
      return answers.shift() ?? q.default
    },
    ...(priced ? { pricing: { 'model-a': { input: 1_000_000, output: 0 } } } : {}), // $1 a token
    ...(budgets.run === undefined ? {} : { run: budgets.run }),
    task: (key) => budgets.tasks?.[key],
  })
  return { g, asked, events: () => j.events.filter((e) => e.type === 'swarm/budget').map((e) => e.data as SwarmBudgetEvent) }
}

it('under its limit a run starts; at it, one question, and its default stops every later start', async () => {
  const j = journal()
  const { g, asked, events } = guard(j, [], { run: { tokens: 10 } })
  await g.admit('task-0')
  await spend(j, 10)
  await expect(g.admit('task-1')).rejects.toBeInstanceOf(BudgetStopError)
  await expect(g.admit()).rejects.toThrow('the run stopped on its budget: spent 10 of 10 tokens')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ trigger: 'budget', kind: 'approval', tier: 'high', options: ['stop', 'extend'], default: 'stop' })
  expect(events()).toEqual([{ version: 1, scope: 'run', reason: 'spent 10 of 10 tokens', spent: { usd: 10, tokens: 10 }, outcome: 'stopped', limit: { tokens: 10 } }])
})

it('extend grows the limit by its first amount, and asks again once that is spent too', async () => {
  const j = journal()
  const { g, asked, events } = guard(j, ['extend', 'extend'], { run: { usd: 5 } })
  await spend(j, 6)
  // $6 of $5: extended to $10, which admits.
  await g.admit()
  await spend(j, 5)
  // $11 of $10: extended to $15.
  await g.admit()
  await spend(j, 4)
  // $15 of $15: the default stops it.
  await expect(g.admit()).rejects.toBeInstanceOf(BudgetStopError)
  expect(asked).toHaveLength(3)
  expect(events().map((e) => [e.outcome, e.limit.usd])).toEqual([
    ['extended', 10],
    ['extended', 15],
    ['stopped', 15],
  ])
})

it('concurrent starts in one scope wait on one question', async () => {
  const j = journal()
  let release!: (answer: string) => void
  let asks = 0
  const g = new BudgetGuard({
    journal: j,
    ask: () => {
      asks++
      return new Promise((resolve) => (release = resolve))
    },
    run: { tokens: 1 },
    task: () => undefined,
  })
  await spend(j, 1)
  const starts = [g.admit('a'), g.admit('b'), g.admit()].map((p) => p.then(() => 'ok', (e: Error) => e.name))
  await new Promise((r) => setTimeout(r, 20))
  expect(asks).toBe(1)
  release('stop')
  expect(await Promise.all(starts)).toEqual(['BudgetStopError', 'BudgetStopError', 'BudgetStopError'])
  expect(asks).toBe(1)
})

it("a task's budget is its own: it stops that task's starts, not its siblings' or the run's", async () => {
  const j = journal()
  const { g, asked } = guard(j, [], { tasks: { 'task-0': { tokens: 5 } } })
  await spend(j, 5, { taskKey: 'task-0' })
  await spend(j, 50, { taskKey: 'task-1' })
  await expect(g.admit('task-0')).rejects.toMatchObject({ scope: 'task', taskId: 'task-0' })
  await g.admit('task-1')
  await g.admit()
  expect(asked.map((q) => q.taskId)).toEqual(['task-0'])
})

it('a dollar limit over usage it cannot price asks at once; extend there drops the dollar limit, and runtime-reported dollars need no price', async () => {
  const j = journal()
  const { g, asked } = guard(j, ['extend'], { run: { usd: 100, tokens: 1000 } }, false)
  // Claude Code reports its own dollars: priced without a table.
  await spend(j, 10, { runtime: 'claude-code', costUsd: 0.5 })
  await g.admit()
  expect(asked).toHaveLength(0)
  await spend(j, 10, { model: 'unknown-model' })
  await g.admit()
  expect(asked[0]!.prompt).toContain('cannot be checked')
  expect(asked[0]!.prompt).toContain('continue without the dollar limit')
  // The token limit still holds.
  await spend(j, 1000)
  await expect(g.admit()).rejects.toThrow('tokens')
})

// The keyless team runs.

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function team(
  spec: { budget?: Budget; tasks: { subject: string; prompt: string; checks?: string[]; budget?: Budget; blockedBy?: number[] }[]; rounds?: number; members?: number },
  train: boolean | { checks: string[] },
  maxConcurrent?: number,
) {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-budget-team-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  h = await bootHarness({
    // Each member run: a bash call writing a file of its own, then done.
    sequence: Array.from({ length: 8 }, () => ['tool_call_success', 'success'] as const).flat(),
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$RANDOM" >> "out-$b.txt"' }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const member = { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } }
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: Array.from({ length: spec.members ?? 1 }, (_, i) => ({ name: `m${i}` })),
      maxTaskAttempts: 1,
      gate: { rounds: spec.rounds ?? 1, checks: ['true'] },
      tasks: spec.tasks,
      ...(spec.budget === undefined ? {} : { budget: spec.budget }),
    },
    {
      parent: h.lead.agent,
      worktrees: {
        repoRoot: root,
        member,
        ...(train === false ? {} : { train: train === true ? { checks: ['true'] } : train }),
        ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
      },
    },
  )
  const settled = await run.result.then(
    (result) => ({ result, error: undefined }),
    (e: unknown) => ({ result: undefined, error: e }),
  )
  const events = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl'))
  return { result: settled.result, error: settled.error as AbandonedTasksError, events }
}

it('a run budget: no member run starts once it is spent, the run overshoots by the one in flight, and the train lands what passed', async () => {
  const tasks = ['first', 'second', 'third'].map((subject) => ({ subject, prompt: `do the ${subject} task` }))
  // One token: the first run spends past it, so the second never starts.
  const { error, events } = await team({ budget: { tokens: 1 }, tasks }, true)
  expect(error).toBeInstanceOf(AbandonedTasksError)
  expect([...error.abandoned.keys()]).toEqual(['task-1', 'task-2'])
  expect(error.outcome!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  const usage = events.filter((e) => e.type === 'swarm/usage').map((e) => (e.data as SwarmUsageEvent).taskKey)
  expect(usage).toEqual(['task-0'])
  expect(events.filter((e) => e.type === 'swarm/budget').map((e) => (e.data as SwarmBudgetEvent).outcome)).toEqual(['stopped'])
  expect(events.some((e) => e.type === 'swarm/question' && (e.data as any).question.trigger === 'budget')).toBe(true)
}, 120_000)

it("a task budget abandons only its task and its dependents: its second gate round is refused, its siblings land", async () => {
  const { error, events } = await team(
    {
      rounds: 3,
      tasks: [
        { subject: 'first', prompt: 'do the first task' },
        // Fails its checks, so it would take three rounds; its budget allows one.
        { subject: 'second', prompt: 'do the second task', checks: ['false'], budget: { tokens: 1 } },
        { subject: 'third', prompt: 'do the third task' },
        { subject: 'fourth', prompt: 'build on the second', blockedBy: [1] },
      ],
    },
    false,
  )
  expect([...error.abandoned.keys()]).toEqual(['task-1', 'task-3'])
  expect(error.abandoned.get('task-3')).toBe('blocked by abandoned task task-1')
  expect(error.abandoned.get('task-1')).toContain('task task-1 stopped on its budget')
  expect(error.outcome!.merged.map((m) => m.taskKey)).toEqual(['task-0', 'task-2'])
  expect(error.outcome!.withheld.map((w) => w.taskKey)).toEqual(['task-1'])
  const runs = events.filter((e) => e.type === 'swarm/usage').map((e) => (e.data as SwarmUsageEvent).taskKey)
  expect(runs.filter((k) => k === 'task-1')).toHaveLength(1)
}, 120_000)

it('runs queued behind a busy slot are checked again once they hold one: three members, one slot, and only the first run spends', async () => {
  const tasks = ['first', 'second', 'third'].map((subject) => ({ subject, prompt: `do the ${subject} task` }))
  // All three pass the first check at nothing spent; the second, in the slot, stops the two that waited.
  const { error, events } = await team({ budget: { tokens: 1 }, tasks, members: 3 }, false, 1)
  expect(events.filter((e) => e.type === 'swarm/usage')).toHaveLength(1)
  expect([...error.abandoned.keys()].sort()).toHaveLength(2)
  expect(error.outcome!.merged).toHaveLength(1)
}, 120_000)

it("a train repair its task's budget refuses ejects the entry, branch kept, and its batch-mates land", async () => {
  const tasks = ['first', 'second', 'third'].map((subject, i) => ({ subject, prompt: `do the ${subject} task`, ...(i === 1 ? { budget: { tokens: 1 } } : {}) }))
  // The second task's file fails the train's check, so it is bisected out and sent to repair; its budget is spent.
  const { result, events } = await team({ tasks }, { checks: ['! ls out-*-task-1.txt >/dev/null 2>&1'] })
  expect(result!.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0', 'task-2'])
  expect(result!.git!.ejected).toEqual([expect.objectContaining({ taskKey: 'task-1', reason: expect.stringContaining('task task-1 stopped on its budget') })])
  // The repair never started: the second task's only run is its gate round.
  expect(events.filter((e) => e.type === 'swarm/usage' && (e.data as SwarmUsageEvent).taskKey === 'task-1')).toHaveLength(1)
}, 120_000)
