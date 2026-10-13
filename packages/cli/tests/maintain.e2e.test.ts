/**
 * `openswarm maintain` (docs/05 C7b): the survey's reply parsed and
 * validated; then end to end, keyless — a survey in a disposable clone
 * proposes three tasks, a gated peer-team runs them in worktrees, the two that
 * pass land through the train, the one that cannot is abandoned (C7a), and the
 * summary says so.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

it("the survey's tasks: the last tasks object in its reply, through fences and prose, at most --tasks, each with a subject and a prompt", () => {
  const reply = [
    'I looked around. An earlier draft: {"tasks": []}',
    '```json',
    '{',
    '  "tasks": [',
    '    { "subject": " Doc the parser ", "prompt": "Add a doc comment to parse() in src/parse.ts.", "checks": ["grep -q Parse src/parse.ts"] },',
    '    { "subject": "Drop dead code", "prompt": "Remove unused helper in src/util.ts.", "checks": [] },',
    '    { "subject": "third", "prompt": "over the cap" }',
    '  ]',
    '}',
    '```',
    'That is all.',
  ].join('\n')
  expect(surveyTasks(reply, 2)).toEqual([
    { subject: 'Doc the parser', prompt: 'Add a doc comment to parse() in src/parse.ts.', checks: ['grep -q Parse src/parse.ts'] },
    { subject: 'Drop dead code', prompt: 'Remove unused helper in src/util.ts.' },
  ])
  expect(surveyTasks('nothing to do here {"tasks": []}', 5)).toEqual([])
  expect(() => surveyTasks('no object at all', 5)).toThrow(/without a \{"tasks"/)
  expect(() => surveyTasks('{"tasks": [{"subject": "x"}]}', 5)).toThrow(/needs a subject and a prompt/)
  expect(() => surveyTasks('{"tasks": [{"subject": "x", "prompt": "y", "checks": "npm test"}]}', 5)).toThrow(/checks must be a list/)
})

const SURVEY = JSON.stringify({
  tasks: [
    { subject: 'first fix', prompt: 'make the first fix' },
    { subject: 'second fix', prompt: 'make the second fix' },
    // Its own check never passes, so it is abandoned in its one round.
    { subject: 'impossible fix', prompt: 'make the impossible fix', checks: ['false'] },
  ],
})

it('a survey in a disposable clone proposes three tasks; the two that pass land through the train, the third is abandoned, and the summary says so', async () => {
  // Every member's first turn writes a file named by its branch; its closing text is the survey's reply.
  const router = await startMockRouter('b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"', SURVEY)
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

  const lines: string[] = []
  const code = await runCli(
    ['maintain', '--model', 'mock-model', '--principles', 'PRINCIPLES.md', '--check', 'true', '--members', '1', '--rounds', '1', '--summary', summary],
    { out: (l) => lines.push(l), err: () => {} },
  )
  const events = lines.map((l) => JSON.parse(l))
  // Abandoned work fails the run, though what passed landed.
  expect(code).toBe(1)
  expect(events.find((e) => e.type === 'survey').tasks.map((t: any) => t.subject)).toEqual(['first fix', 'second fix', 'impossible fix'])
  expect(events.find((e) => e.type === 'survey_note').usage.calls).toBeGreaterThan(0)
  const note = events.find((e) => e.type === 'team_note')
  expect(note).toMatchObject({ landed: ['task-0', 'task-1'], withheld: ['task-2'], workspace: 'fast-forwarded' })
  expect(Object.keys(note.abandoned)).toEqual(['task-2'])

  // The survey's own write went away with its clone; the landed tasks' files are in the checkout.
  expect(existsSync(join(repo, 'out-HEAD.txt'))).toBe(false)
  expect(git('ls-files').split('\n').filter((f) => f.startsWith('out-'))).toHaveLength(2)

  const md = readFileSync(summary, 'utf8')
  expect(md).toContain('# Maintenance: 2 task(s) landed')
  expect(md).toContain('first fix')
  expect(md).toContain('second fix')
  expect(md).toContain('## Abandoned')
  expect(md).toContain('- task-2: ')
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
})
