/**
 * `openswarm maintain` (docs/05 C7b): the survey's reply parsed and
 * validated; then end to end, keyless — a survey in a disposable clone
 * proposes three tasks, a gated peer-team runs them in worktrees, the two that
 * pass land through the train, the one that cannot is abandoned (C7a), and the
 * summary says so.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runCli } from '../src/index'
import { surveyTasks } from '../src/maintain'
import { startMockRouter } from './support/router'

const originalCwd = process.cwd()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  process.chdir(originalCwd)
  delete process.env['OPENSWARM_HOME']
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

it("the survey's tasks: only the last tasks object in its reply, through fences and prose, at most --tasks; an invalid task is dropped, not fatal", () => {
  const reply = [
    'I looked around. An earlier draft: {"tasks": [{"subject": "draft", "prompt": "never used"}]}',
    '```json',
    '{',
    '  "tasks": [',
    '    { "subject": " Doc the parser ", "prompt": "Add a doc comment to parse() in src/parse.ts.", "verify": ["grep -q Parse src/parse.ts"] },',
    '    { "subject": "no prompt" },',
    '    { "subject": "Drop dead code", "prompt": "Remove unused helper in src/util.ts.", "verify": [] },',
    '    { "subject": "fourth", "prompt": "over the cap" }',
    '  ]',
    '}',
    '```',
    'That is all.',
  ].join('\n')
  expect(surveyTasks(reply, 3)).toEqual({
    tasks: [
      { subject: 'Doc the parser', prompt: 'Add a doc comment to parse() in src/parse.ts.', verify: ['grep -q Parse src/parse.ts'] },
      { subject: 'Drop dead code', prompt: 'Remove unused helper in src/util.ts.' },
    ],
    dropped: ['task 1: needs a subject and a prompt'],
  })
  expect(surveyTasks('nothing to do here {"tasks": []}', 5)).toEqual({ tasks: [], dropped: [] })
  expect(() => surveyTasks('no object at all', 5)).toThrow(/without a \{"tasks"/)
  // A malformed final object is an error, never an earlier draft standing in for it.
  expect(() => surveyTasks('{"tasks": [{"subject": "a", "prompt": "b"}]} then {"tasks": [oops', 5)).toThrow(/not valid JSON/)
})

const SURVEY = JSON.stringify({
  tasks: [
    { subject: 'first fix', prompt: 'make the first fix' },
    { subject: 'second fix', prompt: 'make the second fix' },
    // A suggestion only: it reaches the member's prompt, never anything the harness runs.
    { subject: 'impossible fix', prompt: 'make the impossible fix', verify: ['false'] },
  ],
})

/** Every member's first turn writes a file named by its branch; every closing text is the survey's reply, then a sign-off verdict. */
async function maintainRun(accept: boolean, extra: string[] = []) {
  const router = await startMockRouter('b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"', `${SURVEY}\n${JSON.stringify({ accept, reasons: accept ? 'stays inside its task' : 'it rewrites a file the task never named' })}`)
  cleanups.push(router.close)
  const repo = mkdtempSync(join(tmpdir(), 'openswarm-maintain-e2e-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  writeFileSync(join(repo, 'PRINCIPLES.md'), '- Every fix is made.\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  process.chdir(repo)
  process.env['OPENSWARM_HOME'] = mkdtempSync(join(tmpdir(), 'openswarm-maintain-home-'))
  const summary = join(mkdtempSync(join(tmpdir(), 'openswarm-maintain-out-')), 'summary.md')

  // A stale summary from an earlier run is replaced.
  writeFileSync(summary, 'stale')
  const lines: string[] = []
  // The third task's own file fails the operator's check in its worktree, so its gate never passes.
  const check = '! ls out-*-task-2.txt >/dev/null 2>&1'
  const code = await runCli(
    ['maintain', '--model', 'mock-model', '--principles', 'PRINCIPLES.md', '--check', check, '--members', '1', '--rounds', '1', '--summary', summary, ...extra],
    { out: (l) => lines.push(l), err: () => {} },
  )
  const events = lines.map((l) => JSON.parse(l))
  return { code, events, repo, git, summary }
}

it('a survey in a disposable clone proposes three tasks; the two that pass their checks and the sign-off land through the train, the third is abandoned, and the summary says so', async () => {
  const { code, events, repo, git, summary } = await maintainRun(true)
  // Abandoned work fails the run, though what passed landed.
  expect(code).toBe(1)
  expect(events.find((e) => e.type === 'survey').tasks.map((t: any) => t.subject)).toEqual(['first fix', 'second fix', 'impossible fix'])
  expect(events.find((e) => e.type === 'survey_note').usage.calls).toBeGreaterThan(0)
  const note = events.find((e) => e.type === 'team_note')
  expect(note).toMatchObject({ landed: ['task-0', 'task-1'], withheld: ['task-2'], workspace: 'fast-forwarded' })
  expect(Object.keys(note.abandoned)).toEqual(['task-2'])

  // The survey's own write went away with its clone: the checkout is clean, and its only out- files are the two landed.
  expect(git('status', '--porcelain')).toBe('')
  const tracked = git('ls-files').split('\n').filter((f) => f.startsWith('out-'))
  expect(tracked).toHaveLength(2)
  expect(readdirSync(repo).filter((f) => f.startsWith('out-')).sort()).toEqual(tracked.sort())

  // The survey's suggestion is in the task's prompt; the task's gate ran the operator's check alone.
  const journal = readFileSync(join(process.env['OPENSWARM_HOME']!, 'runs', note.runId, 'journal.jsonl'), 'utf8')
  const tasks = journal.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'swarm/task').map((e) => e.data.task)
  const third = tasks.filter((t) => t.id === 'task-2').at(-1)
  expect(third.prompt).toContain('The survey suggests confirming it with: false')
  expect(third.checks).toBeUndefined()
  // The two that landed were signed off by a reviewer after their checks passed.
  const gates = journal.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'swarm/gate').map((e) => e.data)
  expect(gates.filter((g) => g.signoff?.accepted === true).map((g) => g.taskId).sort()).toEqual(['task-0', 'task-1'])

  const md = readFileSync(summary, 'utf8')
  expect(md).toContain('# Maintenance: 2 task(s) landed')
  expect(md).toContain('first fix')
  expect(md).toContain('second fix')
  expect(md).toContain('## Abandoned')
  expect(md).toContain('- task-2: ')
  expect(md).toContain('Checkout: fast-forwarded.')
  expect(md).toMatch(/the survey \d+ tokens/)
}, 180_000)

it('a reviewer that will not sign off keeps a task from landing, though its checks pass', async () => {
  const { code, events } = await maintainRun(false)
  expect(code).toBe(1)
  const note = events.find((e) => e.type === 'team_note')
  expect(note.landed).toEqual([])
  expect(Object.keys(note.abandoned).sort()).toEqual(['task-0', 'task-1', 'task-2'])
}, 180_000)

it('--no-review lands what passes its checks without a sign-off', async () => {
  const { events } = await maintainRun(false, ['--no-review'])
  expect(events.find((e) => e.type === 'team_note').landed).toEqual(['task-0', 'task-1'])
}, 180_000)

it('refused before any spend: no --check, or a dollar budget it could not price', async () => {
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-maintain-refuse-')))
  writeFileSync('P.md', '- x\n')
  const fails = async (argv: string[]) => {
    const lines: string[] = []
    expect(await runCli(['maintain', '--model', 'mock-model', '--principles', 'P.md', ...argv], { out: (l) => lines.push(l), err: () => {} })).toBe(1)
    return lines.join('\n')
  }
  expect(await fails([])).toMatch(/needs at least one --check/)
  expect(await fails(['--check', 'true', '--budget-usd', '5'])).toMatch(/need --pricing <file> with a price for mock-model/)
  expect(await fails(['--check', 'true', '--max-cost-usd', '5'])).toMatch(/need --pricing <file> with a price for mock-model/)
  expect(await fails(['--check', 'true', '--max-tokens', 'lots'])).toMatch(/--max-tokens must be a positive integer/)
  expect(await fails(['--check', 'true', '--sandbox', 'read-only'])).toMatch(/--sandbox must be workspace-write or danger-full-access/)
})
