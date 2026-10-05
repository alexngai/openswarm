import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withSnapshotClone } from 'openswarm-git'
import { runGate, type GateDeps, type GateRound } from '../src/gate'
import type { RunMember } from '../src/topologies'
import type { MemberRunResult } from '../src/types'

/**
 * The prototype's prompts, read from eval/pilot/gate.mjs: the product must send
 * the reviewer and the next round what was measured (docs/07 §7.1, arm b).
 */
const prototype = readFileSync(new URL('../../../eval/pilot/gate.mjs', import.meta.url), 'utf8')
const REVIEW = /const REVIEW = `([\s\S]*?)`;/.exec(prototype)![1]!
const prototypeContinuation = new Function(
  'prompt',
  'base',
  'rv',
  `return \`${/const continuation = \(prompt, base, rv\) => `([\s\S]*?)`;/.exec(prototype)![1]}\``,
) as (prompt: string, base: string, rv: object) => string

function repo(): { root: string; git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-gate-test-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).toString()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return { root, git }
}

const reply = (member: string, text: string, n: number): MemberRunResult => ({
  member,
  runId: `run-${n}`,
  text,
  output: [{ type: 'text', text }],
  stopReason: 'completed',
})

/** Scripted agent rounds; records each round's prompt. */
function fakeRun(steps: (() => string)[]) {
  const prompts: string[] = []
  const run: RunMember = async (member, prompt) => {
    prompts.push(prompt)
    const step = steps.shift()
    if (step === undefined) throw new Error('no scripted round left')
    return reply(member.name, step(), prompts.length)
  }
  return { run, prompts }
}

/** Scripted reviews (a step may throw); records what each was asked to measure. */
function fakeReview(steps: ((cwd: string) => string)[], root?: string) {
  const calls: { prompt: string; commit: string }[] = []
  const review: NonNullable<GateDeps['review']> = async (prompt, commit) => {
    calls.push({ prompt, commit })
    const step = steps.shift()
    if (step === undefined) throw new Error('no scripted review left')
    // With a repo, the review runs in a real disposable clone of the snapshot.
    const text = root === undefined ? step('') : await withSnapshotClone(root, commit, async (cwd) => step(cwd))
    return reply('reviewer', text, calls.length)
  }
  return { review, calls }
}

const verdict = (status: string, score: number, regressions: unknown = 'none') =>
  `checked it\n${JSON.stringify({ targets: [{ target: 1, status, notes: status === 'done' ? 'works' : 'half of it' }], regressions, score })}`

const member = { name: 'agent' }

it('review mode: partial then done is accepted in 2 rounds; the reviewer measures a snapshot elsewhere', async () => {
  const { root, git } = repo()
  // A staged change of the user's: the gate must leave it, HEAD and the index as found.
  writeFileSync(join(root, 'a.txt'), 'staged\n')
  git('add', 'a.txt')
  const head = git('rev-parse', 'HEAD').trim()
  const index = readFileSync(join(root, '.git', 'index'))
  const file = (name: string) => readFileSync(join(root, name), 'utf8')

  const { run, prompts } = fakeRun([
    () => (writeFileSync(join(root, 'impl.txt'), 'v1\n'), 'did half'),
    () => {
      expect(file('impl.txt')).toBe('v1\n')
      writeFileSync(join(root, 'impl.txt'), 'v2\n')
      return 'did the rest'
    },
  ])
  const { review, calls } = fakeReview(
    [
      (cwd) => {
        expect(readFileSync(join(cwd, 'impl.txt'), 'utf8')).toBe('v1\n')
        // Everything a reviewer told "do not fix anything" does anyway.
        writeFileSync(join(cwd, 'impl.txt'), 'reviewer fixed it\n')
        writeFileSync(join(cwd, 'scratch.py'), 'assert True\n')
        return verdict('partial', 40, ['test_impl fails'])
      },
      () => verdict('done', 100),
    ],
    root,
  )
  const recorded: GateRound[] = []
  const result = await runGate({ task: 'build impl', member }, { run, review, cwd: root, record: (r) => recorded.push(r) })

  expect(result.accepted).toBe(true)
  expect(result.rounds.map((r) => [r.round, r.changed, r.evidence.kind, r.evidence.passed, r.evidence.score])).toEqual([
    [1, true, 'review', false, 40],
    [2, true, 'review', true, 100],
  ])
  expect(recorded).toEqual(result.rounds)
  expect(result.lastPassing).toBe(result.rounds[1]!.snapshot)
  expect(result.final.text).toBe('did the rest')
  // Each review measured its round's snapshot, with the prototype's prompt.
  expect(calls.map((c) => c.commit)).toEqual(result.rounds.map((r) => r.snapshot))
  expect(calls[0]!.prompt).toBe(`${REVIEW}build impl`)
  expect(git('show', `${result.rounds[0]!.snapshot}:impl.txt`)).toBe('v1\n')
  // The prototype's continuation with ONE departure: the diff names both ends,
  // because base holds untracked files the real index never sees, so the
  // prototype's `git diff <base>` (commit against working tree) would misreport.
  // The reviewer's regressions list is passed on as given.
  expect(prompts[1]).toBe(
    prototypeContinuation('build impl', result.base, {
      targets: [{ target: 1, status: 'partial', notes: 'half of it' }],
      regressions: ['test_impl fails'],
      score: 40,
    }).replace(`git diff ${result.base}`, `git diff ${result.base} ${result.rounds[0]!.snapshot}`),
  )
  // The base is the pre-round tree, staged change included, on top of HEAD.
  expect(git('show', `${result.base}:a.txt`)).toBe('staged\n')
  expect(git('rev-parse', `${result.base}^`).trim()).toBe(head)
  // The reviewer's edits never reached the user's tree; the agent's work stands;
  // nothing was committed or moved.
  expect(file('impl.txt')).toBe('v2\n')
  expect(existsSync(join(root, 'scratch.py'))).toBe(false)
  expect(git('symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main')
  expect(git('rev-parse', 'main').trim()).toBe(head)
  expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true)
})

it('a review that fails is recorded as a failed check, and the gate goes on', async () => {
  const { root } = repo()
  const { run, prompts } = fakeRun([
    () => (writeFileSync(join(root, 'impl.txt'), 'v1\n'), 'one'),
    () => (writeFileSync(join(root, 'impl.txt'), 'v2\n'), 'two'),
  ])
  const { review } = fakeReview([
    () => {
      throw new Error('clone failed')
    },
    () => verdict('done', 100),
  ])
  const result = await runGate({ task: 't', member }, { run, review, cwd: root })

  expect(result.accepted).toBe(true)
  expect(result.rounds[0]!.evidence).toEqual({ kind: 'review', passed: false, score: null, error: 'clone failed' })
  // As after the prototype's failed review: a report with nothing in it.
  expect(prompts[1]).toContain('"targets": null')
})

it('an aborted run still ends the gate from inside a review', async () => {
  const { root } = repo()
  const controller = new AbortController()
  const { run } = fakeRun([() => (writeFileSync(join(root, 'impl.txt'), 'v1\n'), 'one')])
  const { review } = fakeReview([
    () => {
      controller.abort()
      throw new Error('reviewer killed')
    },
  ])
  await expect(runGate({ task: 't', member }, { run, review, cwd: root, signal: controller.signal })).rejects.toThrow(
    'reviewer killed',
  )
})

it('review mode needs a reviewer', async () => {
  const { root } = repo()
  await expect(runGate({ task: 't', member }, { run: fakeRun([]).run, cwd: root })).rejects.toThrow(/deps\.review/)
})

it('commands mode: a failing check sends the work back with the command and its output', async () => {
  const { root } = repo()
  const { run, prompts } = fakeRun([
    () => (writeFileSync(join(root, 'wrong.txt'), 'x\n'), 'done, I think'),
    () => (writeFileSync(join(root, 'done.txt'), 'x\n'), 'now done'),
  ])
  const result = await runGate(
    { task: 'make done.txt', member, commands: ['test -f done.txt || (echo missing done.txt; false)'] },
    { run, cwd: root },
  )

  expect(result.accepted).toBe(true)
  expect(result.rounds.map((r) => [r.evidence.kind, r.evidence.passed])).toEqual([
    ['commands', false],
    ['commands', true],
  ])
  expect(result.rounds[0]!.evidence.output).toContain('missing done.txt')
  expect(prompts[1]).toContain('test -f done.txt')
  expect(prompts[1]).toContain('missing done.txt')
  expect(prompts[1]).toContain(`git diff ${result.base} ${result.rounds[0]!.snapshot}`)
})

/** Round 1 makes one.txt; round 2 deletes it (breaking the first check) and strays; round 3 makes two.txt. */
const regressingRounds = (root: string, round3: () => void) =>
  fakeRun([
    () => (writeFileSync(join(root, 'one.txt'), '1\n'), 'one'),
    () => (rmSync(join(root, 'one.txt')), writeFileSync(join(root, 'stray.txt'), 's\n'), 'broke one'),
    () => (round3(), writeFileSync(join(root, 'two.txt'), '2\n'), 'two'),
  ])
const ONE_AND_TWO = { task: 'make one and two', member, commands: ['test -f one.txt', 'test -f two.txt'] }

it('without a rollback (the user\'s checkout) a regression is left in the tree and named to the next round', async () => {
  const { root } = repo()
  const { run, prompts } = regressingRounds(root, () => {
    // Nothing was restored: round 2's tree is what round 3 starts from.
    expect(existsSync(join(root, 'one.txt'))).toBe(false)
    expect(existsSync(join(root, 'stray.txt'))).toBe(true)
  })
  const result = await runGate({ ...ONE_AND_TWO, maxRounds: 3 }, { run, cwd: root })

  expect(result.accepted).toBe(false) // round 3 still misses one.txt
  expect(result.lastPassing).toBeUndefined()
  expect(result.rounds.map((r) => [r.evidence.passed, r.rolledBack ?? false])).toEqual([
    [false, false],
    [false, false],
    [false, false],
  ])
  expect(prompts[2]).toContain('Round 2 broke test -f one.txt, which passed in round 1.')
  expect(prompts[2]).toContain(`git diff ${result.base} ${result.rounds[1]!.snapshot}`)
})

it('with a rollback (a tree the gate owns) a round that breaks a passing check is undone', async () => {
  const { root, git } = repo()
  const rollbacks: string[] = []
  // A B6b-style rollback inside a gate worktree.
  const rollback = async (commit: string) => {
    rollbacks.push(commit)
    git('reset', '-q', '--hard', commit)
    git('clean', '-fdq')
  }
  const { run, prompts } = regressingRounds(root, () => {
    expect(existsSync(join(root, 'one.txt'))).toBe(true)
    expect(existsSync(join(root, 'stray.txt'))).toBe(false)
  })
  const result = await runGate(ONE_AND_TWO, { run, cwd: root, rollback })

  expect(result.accepted).toBe(true)
  expect(result.rounds.map((r) => [r.evidence.passed, r.rolledBack ?? false])).toEqual([
    [false, false],
    [false, true],
    [true, false],
  ])
  expect(rollbacks).toEqual([result.rounds[0]!.snapshot])
  expect(result.rounds[1]!.evidence.failedCommand).toBe('test -f one.txt')
  expect(prompts[2]).toMatch(/rolled back[\s\S]*test -f one\.txt[\s\S]*still fails[\s\S]*test -f two\.txt/)
  // Back at round 1's tree, so the diff ends there.
  expect(prompts[2]).toContain(`git diff ${result.base} ${result.rounds[0]!.snapshot}`)
})

it('the cap ends the gate unaccepted, with evidence for the last round too', async () => {
  const { root } = repo()
  const { run } = fakeRun([1, 2].map((n) => () => (writeFileSync(join(root, 'impl.txt'), `v${n}\n`), `round ${n}`)))
  const { review, calls } = fakeReview([() => verdict('partial', 30), () => verdict('broken', 10)])
  const result = await runGate({ task: 't', member, maxRounds: 2 }, { run, review, cwd: root })

  expect(result.accepted).toBe(false)
  expect(result.rounds).toHaveLength(2)
  expect(result.rounds[1]!.evidence).toMatchObject({ kind: 'review', passed: false, score: 10 })
  expect(calls).toHaveLength(2)
})

it('a later round that changes nothing stops the gate, carrying the evidence before it', async () => {
  const { root } = repo()
  const { run } = fakeRun([() => (writeFileSync(join(root, 'impl.txt'), 'v1\n'), 'some'), () => 'nothing more to do'])
  const { review, calls } = fakeReview([() => 'no verdict line at all'])
  const result = await runGate({ task: 't', member }, { run, review, cwd: root })

  expect(result.accepted).toBe(false)
  expect(result.rounds.map((r) => r.changed)).toEqual([true, false])
  expect(result.rounds[0]!.evidence).toEqual({ kind: 'review', passed: false, score: null })
  expect(result.rounds[1]!.evidence).toBe(result.rounds[0]!.evidence)
  expect(calls).toHaveLength(1)
})
