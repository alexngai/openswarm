/**
 * Partial landing (docs/05 C7a, exit criterion 1): a board run with an
 * abandoned task still lands its completed ones, through the queue and
 * through the train, then fails naming the abandoned task; the abandoned
 * task's branch is kept, withheld from the landing.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { MergeOutcome } from 'openswarm-git'
import { AbandonedTasksError, SwarmJournal } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function runFour(train: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-partial-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  h = await bootHarness({
    // Each task's turn: a bash call writing a file of its own, then done.
    sequence: Array.from({ length: 4 }, () => ['tool_call_success', 'success'] as const).flat(),
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"' }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const member = { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } }
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: [{ name: 'solo' }],
      maxTaskAttempts: 1,
      gate: { rounds: 1, checks: ['true'] },
      tasks: [
        { subject: 'first', prompt: 'do the first task' },
        { subject: 'second', prompt: 'do the second task' },
        // Never passes: abandoned by the verifier-failure question's default.
        { subject: 'third', prompt: 'do the third task', checks: ['false'] },
        { subject: 'fourth', prompt: 'do the fourth task' },
      ],
    },
    { parent: h.lead.agent, worktrees: { repoRoot: root, member, ...(train ? { train: { checks: ['true'] } } : {}) } },
  )
  const error = await run.result.then(
    () => undefined,
    (e: unknown) => e,
  )
  return { git, run, error }
}

function expectPartial(error: unknown, outcome: (git: MergeOutcome) => string[]) {
  expect(error).toBeInstanceOf(AbandonedTasksError)
  const abandoned = error as AbandonedTasksError
  expect([...abandoned.abandoned.keys()]).toEqual(['task-2'])
  expect(abandoned.message).toContain('task-2')
  expect(outcome(abandoned.outcome!)).toEqual(['task-0', 'task-1', 'task-3'])
  expect(abandoned.outcome!.withheld.map((w) => w.taskKey)).toEqual(['task-2'])
  return abandoned.outcome!
}

it('through the queue: the three that passed land, the abandoned one is withheld with its branch kept, and the run fails naming it', async () => {
  const { git, run, error } = await runFour(false)
  const outcome = expectPartial(error, (o) => o.merged.map((m) => m.taskKey))
  const files = git('ls-tree', '--name-only', outcome.targetBranch).split('\n').filter((f) => f.startsWith('out-'))
  expect(files).toHaveLength(3)
  // The abandoned task's work is on its kept branch, not the target.
  const branch = outcome.withheld[0]!.branch
  expect(git('ls-tree', '--name-only', branch)).toContain(`out-${branch.replace(/\//g, '-')}.txt`)
  expect(files).not.toContain(`out-${branch.replace(/\//g, '-')}.txt`)
  const last = SwarmJournal.read(join(h!.runsDir, run.id, 'journal.jsonl')).at(-1)!
  expect(last).toMatchObject({ type: 'swarm/run', data: { run: { status: 'failed', error: expect.stringContaining('task-2'), git: { withheld: [{ taskKey: 'task-2' }] } } } })
}, 120_000)

it('through the train: the three that passed land verified, the abandoned one never enters it', async () => {
  const { run, error } = await runFour(true)
  expectPartial(error, (o) => (o.landed ?? []).map((l) => l.taskKey))
  const train = SwarmJournal.read(join(h!.runsDir, run.id, 'train.jsonl'))
  const enqueued = train.filter((e) => e.type === 'train/enqueued').map((e) => (e.data as { key: string }).key)
  expect(enqueued).toEqual(['task-0', 'task-1', 'task-3'])
}, 120_000)
