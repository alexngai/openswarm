/**
 * The train (docs/05 B2) and integrate-and-repair (B3) on real git repos,
 * with scripted members: speculative batches verified once, a failure
 * bisected to its culprit, repairs by the owning member, conflicts to the
 * resolver, dependencies, and exit criterion 1 against today's queue.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SwarmGit } from 'openswarm-git'
import {
  SwarmJournal,
  TrainStoppedError,
  hiddenSuite,
  landTrain,
  openVerifier,
  runGateCommand,
  tarDirectory,
  trainJournalPath,
  trainVerify,
  verifierHelperSource,
  type AskQuestion,
  type MemberRunResult,
  type MemberSpec,
  type RunMember,
  type SwarmQuestionRequest,
  type TrainConfig,
  type TrainDeps,
  type TrainVerify,
} from '../src/index'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `openswarm-train-${prefix}-`))

function repo(files: Record<string, string> = { 'README.md': 'base\n' }): string {
  const root = tmp('repo')
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
  git('add', '.')
  git('commit', '-qm', 'init')
  return root
}

const sh = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim()
const show = (root: string, ref: string, file: string) => sh(root, 'show', `${ref}:${file}`)
const has = (root: string, ref: string, file: string) => spawnSync('git', ['cat-file', '-e', `${ref}:${file}`], { cwd: root }).status === 0

/** One task worktree per key, its files written and committed, in this order. */
async function branches(git: SwarmGit, work: Record<string, Record<string, string>>): Promise<void> {
  for (const [key, files] of Object.entries(work)) {
    const worktree = await git.worktree(key)
    for (const [path, text] of Object.entries(files)) writeFileSync(join(worktree.path, path), text)
    await git.autoCommit(worktree, `work ${key}`)
  }
}

const reply = (member: string, text: string): MemberRunResult => ({ member, runId: 'r', text, output: [{ type: 'text', text }], stopReason: 'completed' })

/** A scripted member: `edit` changes the worktree of the key it runs for; every run is kept. */
function scripted(git: SwarmGit, edit: (cwd: string, prompt: string) => void = () => {}) {
  const runs: { member: string; key: string; prompt: string }[] = []
  const run: RunMember = async (member, prompt, key) => {
    runs.push({ member: member.name, key: key!, prompt })
    edit((await git.worktree(key!)).path, prompt)
    return reply(member.name, 'done')
  }
  return { run, runs }
}

/** Each key owned by `owner-<key>`, first given `task <key>`. */
const owners = (keys: string[]) => new Map(keys.map((key) => [key, { member: { name: `owner-${key}` } as MemberSpec, prompt: `task ${key}` }]))

/** Land `git`'s branches with the train, answering every question with its default unless `answer` says otherwise. */
async function land(
  git: SwarmGit,
  config: TrainConfig,
  deps: Pick<TrainDeps, 'run'> & Partial<TrainDeps> & { answer?: (q: SwarmQuestionRequest) => string; verify?: TrainVerify },
) {
  const journal = SwarmJournal.open(join(tmp('journal'), 'train.jsonl'))
  const questions: SwarmQuestionRequest[] = []
  const ask: AskQuestion = async (q) => {
    questions.push(q)
    return deps.answer?.(q) ?? q.default
  }
  const outcome = await landTrain(git, config, {
    journal,
    owners: owners(git.list().map((w) => w.taskKey)),
    ask,
    ...deps,
    verify: deps.verify ?? trainVerify(config),
  })
  await git.dispose()
  const events = (type: string) => journal.events.filter((e) => e.type === type).map((e) => e.data as any)
  return { outcome, journal, questions, events }
}

const keys = (list: { taskKey: string }[] | undefined) => (list ?? []).map((e) => e.taskKey)

const BAD = 'test ! -f bad.txt || (echo bad.txt is planted; false)'
/** Passes on a tree without shared.txt too, so the baseline (the target alone) passes. */
const NO_MARKERS = "! grep -qs '^<<<<<<<' shared.txt"

it('exit criterion 1: a planted bad commit is bisected out of its batch of 4, its 3 batch-mates land, and its repair lands it next wave', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'ec1' })
  await branches(git, { t0: { 'a.txt': 'a\n' }, t1: { 'b.txt': 'b\n' }, t2: { 'bad.txt': 'x\n', 'c.txt': 'c\n' }, t3: { 'd.txt': 'd\n' } })
  const member = scripted(git, (cwd) => rmSync(join(cwd, 'bad.txt')))
  const { outcome, journal, events, questions } = await land(git, { checks: [BAD] }, { run: member.run })

  // Batch 1 failed once, bisected to t2; t3 landed without waiting for it.
  expect(events('train/batch').map((b) => [b.batch, b.parent ?? null, b.entries.map((e: any) => e.key)])).toEqual([
    [1, null, ['t0', 't1', 't2', 't3']],
    [2, 1, ['t0', 't1']],
    [3, 1, ['t2', 't3']],
    [4, 3, ['t2']],
    [5, 3, ['t3']],
    [6, null, ['t2']],
  ])
  expect(events('train/verified').map((v) => [v.batch, v.level, v.passed])).toEqual([
    [1, 2, false],
    [2, 2, true],
    [3, 2, false],
    [4, 2, false],
    [5, 2, true],
    [6, 2, true],
  ])
  // Its batch-mates landed before the culprit's repair began.
  const order = journal.events.filter((e) => e.type === 'train/landed' || e.type === 'train/repair').map((e) => `${e.type.slice(6)} ${(e.data as any).key}`)
  expect(order).toEqual(['landed t0', 'landed t1', 'landed t3', 'repair t2', 'landed t2'])
  // The repair went to the task's owner, with the task and the failing check.
  expect(member.runs).toHaveLength(1)
  expect(member.runs[0]).toMatchObject({ member: 'owner-t2', key: 't2' })
  expect(member.runs[0]!.prompt).toContain('task t2')
  expect(member.runs[0]!.prompt).toContain('The landing check failed on the integrated tree')
  expect(member.runs[0]!.prompt).toContain('bad.txt is planted')
  expect(keys(outcome.landed)).toEqual(['t0', 't1', 't3', 't2'])
  expect(outcome.merged).toEqual(outcome.landed)
  expect(outcome.repaired).toEqual([{ taskKey: 't2', branch: 'swarm/ec1/t2', repairs: 1 }])
  expect(outcome.ejected).toEqual([])
  expect(questions).toEqual([])
  // The target holds every task's work and not the planted file; the user's checkout is untouched.
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) expect(has(root, outcome.targetBranch, file)).toBe(true)
  expect(has(root, outcome.targetBranch, 'bad.txt')).toBe(false)
  expect(sh(root, 'status', '--porcelain')).toBe('')
  expect(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  expect(git.list()).toEqual([])
})

it('a culprit whose repair does not fix it is ejected after maxRepairs, branch kept, on a verifier-failure question that defaults to eject', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'ej' })
  await branches(git, { t0: { 'a.txt': 'a\n' }, t1: { 'b.txt': 'b\n' }, t2: { 'bad.txt': 'x\n' }, t3: { 'd.txt': 'd\n' } })
  const member = scripted(git, (cwd) => writeFileSync(join(cwd, 'notes.txt'), 'tried\n'))
  const { outcome, events, questions } = await land(git, { checks: [BAD], maxRepairs: 1 }, { run: member.run })

  expect(keys(outcome.landed)).toEqual(['t0', 't1', 't3'])
  expect(outcome.ejected).toEqual([{ taskKey: 't2', branch: 'swarm/ej/t2', reason: expect.stringContaining('after 1 repair(s): L2 check failed') }])
  expect(outcome.repaired).toEqual([{ taskKey: 't2', branch: 'swarm/ej/t2', repairs: 1 }])
  expect(member.runs).toHaveLength(1)
  expect(questions).toEqual([expect.objectContaining({ trigger: 'verifier-failure', options: ['eject', 'retry'], default: 'eject' })])
  expect(events('train/repair').map((r) => [r.key, r.attempt, r.outcome])).toEqual([['t2', 1, 'committed']])
  // Kept: the branch, with the planted file and the repair's attempt.
  expect(has(root, 'swarm/ej/t2', 'bad.txt')).toBe(true)
  expect(show(root, 'swarm/ej/t2', 'notes.txt')).toBe('tried')
  expect(has(root, outcome.targetBranch, 'bad.txt')).toBe(false)
})

it('a pair that passes alone but fails together: the first lands, the second goes to repair', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'pair' })
  await branches(git, { pa: { 'a.txt': 'a\n' }, pb: { 'b.txt': 'b\n' } })
  const member = scripted(git, (cwd) => {
    rmSync(join(cwd, 'b.txt'))
    writeFileSync(join(cwd, 'b2.txt'), 'b\n')
  })
  const { outcome, events } = await land(git, { checks: ['! (test -f a.txt && test -f b.txt)'] }, { run: member.run })

  expect(events('train/verified').map((v) => [v.entries, v.passed])).toEqual([
    [['pa', 'pb'], false],
    [['pa'], true],
    [['pb'], false],
    [['pb'], true],
  ])
  expect(member.runs.map((r) => r.key)).toEqual(['pb'])
  expect(keys(outcome.landed)).toEqual(['pa', 'pb'])
  expect(has(root, outcome.targetBranch, 'b2.txt')).toBe(true)
})

it('a conflict goes to the resolver; resolved, it is verified like any entry and lands', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'res' })
  await branches(git, { x: { 'shared.txt': 'from x\n' }, y: { 'shared.txt': 'from y\n' } })
  const member = scripted(git, (cwd) => writeFileSync(join(cwd, 'shared.txt'), 'from x\nfrom y\n'))
  const { outcome, events, questions } = await land(git, { checks: [NO_MARKERS] }, { run: member.run })

  expect(events('train/batch').map((b) => [b.entries.map((e: any) => e.key), b.conflicted])).toEqual([
    [['x', 'y'], ['y']],
    [['y'], []],
  ])
  expect(member.runs).toHaveLength(1)
  expect(member.runs[0]).toMatchObject({ member: 'owner-y', key: 'y' })
  expect(member.runs[0]!.prompt).toContain('these files hold conflicts: shared.txt')
  expect(events('train/resolve').map((r) => [r.key, r.files, r.outcome])).toEqual([['y', ['shared.txt'], 'resolved']])
  expect(keys(outcome.landed)).toEqual(['x', 'y'])
  expect(keys(outcome.resolved)).toEqual(['y'])
  expect(outcome.conflicts).toEqual([])
  expect(questions).toEqual([])
  expect(show(root, outcome.targetBranch, 'shared.txt')).toBe('from x\nfrom y')
})

it('a resolver that leaves conflict markers: the merge is undone, the branch kept, and a conflict question ejects it by default', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'gave' })
  await branches(git, { x: { 'shared.txt': 'from x\n' }, y: { 'shared.txt': 'from y\n' } })
  const before = sh(root, 'rev-parse', 'swarm/gave/y')
  const member = scripted(git)
  const { outcome, events, questions } = await land(git, { checks: [NO_MARKERS] }, { run: member.run })

  expect(member.runs.map((r) => r.key)).toEqual(['y'])
  expect(events('train/resolve').map((r) => [r.key, r.outcome, r.error])).toEqual([['y', 'gave-up', 'conflict markers remain in shared.txt']])
  expect(questions).toEqual([
    expect.objectContaining({ trigger: 'conflict', prompt: expect.stringContaining('landing y conflicts with swarm/gave/integration; resolver gave up'), options: ['eject', 'retry'], default: 'eject' }),
  ])
  expect(keys(outcome.landed)).toEqual(['x'])
  expect(keys(outcome.conflicts)).toEqual(['y'])
  expect(keys(outcome.ejected)).toEqual(['y'])
  // The branch is as the member left it, and its worktree has no merge in progress.
  expect(sh(root, 'rev-parse', 'swarm/gave/y')).toBe(before)
  const y = git.list().find((w) => w.taskKey === 'y')!
  expect(sh(y.path, 'status', '--porcelain')).toBe('')
  expect(existsSync(join(root, '.git', 'worktrees', 'y', 'MERGE_HEAD'))).toBe(false)
})

it('dependencies: a dependent waits for its blocker, whatever order its branch was made in', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'deps' })
  await branches(git, { 'task-1': { 'b.txt': 'b\n' }, 'task-0': { 'a.txt': 'a\n' } })
  const tasks = [
    { id: 'task-0', blockedBy: [] },
    { id: 'task-1', blockedBy: ['task-0'] },
  ]
  const { outcome, events } = await land(git, { checks: ['true'] }, { run: scripted(git).run, tasks })

  expect(events('train/batch').map((b) => b.entries.map((e: any) => e.key))).toEqual([['task-0'], ['task-1']])
  expect(keys(outcome.landed)).toEqual(['task-0', 'task-1'])
})

it('dependencies: an ejected blocker ejects its dependent; an unrelated entry still lands', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'deps2' })
  await branches(git, { 'task-0': { 'bad.txt': 'x\n' }, 'task-1': { 'b.txt': 'b\n' }, 'task-2': { 'c.txt': 'c\n' } })
  const tasks = [
    { id: 'task-0', blockedBy: [] },
    { id: 'task-1', blockedBy: ['task-0'] },
    { id: 'task-2', blockedBy: [] },
  ]
  const member = scripted(git)
  const { outcome, questions } = await land(git, { checks: [BAD], maxRepairs: 0 }, { run: member.run, tasks })

  expect(member.runs).toEqual([])
  expect(questions.map((q) => q.trigger)).toEqual(['verifier-failure'])
  expect(keys(outcome.landed)).toEqual(['task-2'])
  expect(outcome.ejected!.map((e) => [e.taskKey, e.reason])).toEqual([
    ['task-0', expect.stringContaining('after 0 repair(s)')],
    ['task-1', 'blocked by ejected task-0'],
  ])
})

/** Whether `command` passes on `ref`'s tree. */
async function passes(root: string, ref: string, command: string): Promise<boolean> {
  const path = join(tmp('check'), 'tree')
  sh(root, 'worktree', 'add', '-q', '--detach', path, ref)
  try {
    return (await runGateCommand(command, path)).ok
  } finally {
    sh(root, 'worktree', 'remove', '--force', path)
  }
}

it('exit criterion 1: on one fixed set (a bad commit, a conflict), the train lands and cleanly merges at least as much as the sequential queue', async () => {
  const set = {
    c0: { 'a.txt': 'a\n' },
    c1: { 'b.txt': 'b\n' },
    c2: { 'bad.txt': 'x\n', 'c.txt': 'c\n' },
    c3: { 'shared.txt': 'one\n' },
    c4: { 'shared.txt': 'two\n' },
    c5: { 'e.txt': 'e\n' },
  }
  const check = BAD
  const rates = async (root: string, landed: number, target: string) => {
    const clean = (await passes(root, target, check)) ? landed : 0
    return { landing: landed / 6, clean: clean / 6 }
  }

  const queueRoot = repo()
  const queueGit = new SwarmGit({ repoRoot: queueRoot, teamId: 'set' })
  await branches(queueGit, set)
  const queued = await queueGit.mergeAll()
  await queueGit.dispose()
  const queue = await rates(queueRoot, queued.merged.length, queued.targetBranch)

  const trainRoot = repo()
  const trainGit = new SwarmGit({ repoRoot: trainRoot, teamId: 'set' })
  await branches(trainGit, set)
  const member = scripted(trainGit, (cwd, prompt) => {
    if (prompt.includes('## Integrate')) writeFileSync(join(cwd, 'shared.txt'), 'one\ntwo\n')
    else rmSync(join(cwd, 'bad.txt'))
  })
  const { outcome } = await land(trainGit, { checks: [check] }, { run: member.run })
  const train = await rates(trainRoot, outcome.landed!.length, outcome.targetBranch)

  // Today: the bad commit merges and breaks the tree; the conflict is retained.
  expect(queue).toEqual({ landing: 5 / 6, clean: 0 })
  expect(train).toEqual({ landing: 1, clean: 1 })
  expect(train.landing).toBeGreaterThanOrEqual(queue.landing)
  expect(train.clean).toBeGreaterThanOrEqual(queue.clean)
  expect(keys(outcome.repaired)).toEqual(['c2'])
  expect(keys(outcome.resolved)).toEqual(['c4'])
})

const asRoot = process.getuid?.() === 0
const ADD = 'export const add = (a, b) => a + b\n'
const SUBTRACT = 'export const add = (a, b) => a - b\n'

/** A helper as setup installs it, owned by the test's user, holding one suite `add` (as verifier.test.ts does), and its session. */
async function l3() {
  const dir = tmp('libexec')
  const store = join(tmp('store'), 'store')
  mkdirSync(store, { mode: 0o700 })
  const helper = join(dir, 'helper.mjs')
  copyFileSync(verifierHelperSource(), helper)
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ store }))
  const suite = tmp('suite')
  writeFileSync(join(suite, 'check.mjs'), "import { add } from '../work/lib.mjs'\nconsole.log('SECRET TEST NAME')\nif (add(1, 2) !== 3) process.exit(1)\n")
  writeFileSync(join(suite, 'openswarm-suite.json'), JSON.stringify({ command: 'cd {work}/.. && node suite/check.mjs' }))
  expect(spawnSync(process.execPath, [helper, 'add-suite', 'add'], { input: tarDirectory(suite) }).status).toBe(0)
  return { helper, session: await openVerifier({ command: [process.execPath, helper], user: '_openswarmverifier' }, ['add']) }
}

it.skipIf(asRoot)('L3: with a suite the hidden suite verifies each batch, and a repair is told counts only', async () => {
  const { session } = await l3()
  const root = repo({ 'lib.mjs': ADD })
  const git = new SwarmGit({ repoRoot: root, teamId: 'l3' })
  await branches(git, { good: { 'other.txt': 'x\n' }, bad: { 'lib.mjs': SUBTRACT } })
  const member = scripted(git, (cwd) => writeFileSync(join(cwd, 'lib.mjs'), ADD))
  const config = { suite: 'add' }
  const { outcome, events } = await land(git, config, { run: member.run, verify: trainVerify(config, { session, envRoot: root }) })

  expect(events('train/baseline').map((b) => [b.level, b.passed])).toEqual([[3, true]])
  expect(events('train/verified').map((v) => [v.entries, v.level, v.passed, v.total, v.failed])).toEqual([
    [['good', 'bad'], 3, false, 1, 1],
    [['good'], 3, true, 1, 0],
    [['bad'], 3, false, 1, 1],
    [['bad'], 3, true, 1, 0],
  ])
  expect(member.runs[0]!.prompt).toContain('a hidden acceptance suite, which you cannot see, has 1 of 1 failing')
  expect(member.runs[0]!.prompt).not.toContain('SECRET')
  expect(keys(outcome.landed)).toEqual(['good', 'bad'])
})

it.skipIf(asRoot)('L3: a repair that calls the verifier is a tamper incident: journaled, asked (default eject), ejected, and nothing of it committed', async () => {
  const { helper, session } = await l3()
  const root = repo({ 'lib.mjs': ADD })
  const git = new SwarmGit({ repoRoot: root, teamId: 'tamper' })
  await branches(git, { bad: { 'lib.mjs': SUBTRACT } })
  const head = sh(root, 'rev-parse', 'swarm/tamper/bad')
  const member = scripted(git, (cwd) => {
    // What a member's shell would do, as the same user here: list the verifier's suites.
    execFileSync(process.execPath, [helper, 'list'])
    writeFileSync(join(cwd, 'lib.mjs'), ADD)
  })
  const config = { suite: 'add' }
  const scan: TrainDeps['scan'] = (key, step) =>
    hiddenSuite(session, { suite: 'add', cwd: async () => (await git.worktree(key)).path, envRoot: root }).scan(step)
  const { outcome, events, questions } = await land(git, config, { run: member.run, verify: trainVerify(config, { session, envRoot: root }), scan })

  expect(events('train/tamper')).toEqual([
    expect.objectContaining({ key: 'bad', member: 'owner-bad', step: 'repair', severity: 'incident', signals: [expect.objectContaining({ signal: 'helper-log', severity: 'incident' })] }),
  ])
  expect(questions).toEqual([expect.objectContaining({ trigger: 'tamper', tier: 'high', options: ['eject', 'continue'], default: 'eject' })])
  expect(outcome.ejected).toEqual([{ taskKey: 'bad', branch: 'swarm/tamper/bad', reason: 'tamper incident in repair 1' }])
  expect(events('train/repair')).toEqual([])
  expect(sh(root, 'rev-parse', 'swarm/tamper/bad')).toBe(head)
  expect(outcome.landed).toEqual([])
})

it('dependencies: the dependent of a repaired culprit lands in a later wave, after it', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'deps3' })
  await branches(git, { 'task-0': { 'bad.txt': 'x\n', 'a.txt': 'a\n' }, 'task-1': { 'b.txt': 'b\n' } })
  const tasks = [
    { id: 'task-0', blockedBy: [] },
    { id: 'task-1', blockedBy: ['task-0'] },
  ]
  const member = scripted(git, (cwd) => rmSync(join(cwd, 'bad.txt')))
  const { outcome, events } = await land(git, { checks: [BAD] }, { run: member.run, tasks })

  expect(events('train/batch').map((b) => b.entries.map((e: any) => e.key))).toEqual([['task-0'], ['task-0'], ['task-1']])
  expect(keys(outcome.landed)).toEqual(['task-0', 'task-1'])
  expect(keys(outcome.repaired)).toEqual(['task-0'])
})

it('a repair whose tip merge conflicts goes through the resolver first, then the repair, and lands', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'rc' })
  await branches(git, { y: { 'bad.txt': 'x\n', 'shared.txt': 'from y\n' }, z: { 'shared.txt': 'from z\n' } })
  const member = scripted(git, (cwd, prompt) => {
    if (prompt.includes('## Integrate')) writeFileSync(join(cwd, 'shared.txt'), 'from y\nfrom z\n')
    else rmSync(join(cwd, 'bad.txt'))
  })
  // One at a time, so z lands between y failing and y's repair.
  const { outcome, events } = await land(git, { checks: [BAD, NO_MARKERS], batchSize: 1 }, { run: member.run })

  expect(events('train/batch').map((b) => b.entries.map((e: any) => e.key))).toEqual([['y'], ['z'], ['y']])
  expect(member.runs.map((r) => [r.key, r.prompt.includes('## Integrate') ? 'resolve' : 'repair'])).toEqual([
    ['y', 'resolve'],
    ['y', 'repair'],
  ])
  expect(keys(outcome.landed)).toEqual(['z', 'y'])
  expect(keys(outcome.resolved)).toEqual(['y'])
  expect(outcome.repaired).toEqual([{ taskKey: 'y', branch: 'swarm/rc/y', repairs: 1 }])
  expect(show(root, outcome.targetBranch, 'shared.txt')).toBe('from y\nfrom z')
})

it('a target that already fails is not blamed on its entries: by default the train stops, branches kept; answered merge, the queue merges them unverified', async () => {
  const failing = { 'README.md': 'base\n', 'bad.txt': 'already\n' }
  const root = repo(failing)
  const git = new SwarmGit({ repoRoot: root, teamId: 'base' })
  await branches(git, { a: { 'a.txt': 'a\n' }, b: { 'b.txt': 'b\n' } })
  const member = scripted(git)
  const stopped = await land(git, { checks: [BAD] }, { run: member.run })

  expect(stopped.questions).toEqual([expect.objectContaining({ trigger: 'verifier-failure', options: ['stop', 'merge'], default: 'stop' })])
  expect(stopped.events('train/baseline').map((b) => b.passed)).toEqual([false])
  expect(stopped.events('train/batch')).toEqual([])
  expect(stopped.outcome.stopped).toBe('baseline failing: L2 check failed: ' + BAD)
  expect(stopped.outcome.landed).toEqual([])
  expect(keys(stopped.outcome.withheld)).toEqual(['a', 'b'])
  expect(member.runs).toEqual([])
  expect(git.list()).toEqual([])
  expect(has(root, 'swarm/base/a', 'a.txt')).toBe(true)

  const root2 = repo(failing)
  const git2 = new SwarmGit({ repoRoot: root2, teamId: 'base' })
  await branches(git2, { a: { 'a.txt': 'a\n' }, b: { 'b.txt': 'b\n' } })
  const merged = await land(git2, { checks: [BAD] }, { run: member.run, answer: () => 'merge' })
  expect(keys(merged.outcome.merged)).toEqual(['a', 'b'])
  expect(merged.outcome.stopped).toMatch(/merged unverified through the sequential queue$/)
  expect(has(root2, merged.outcome.targetBranch, 'b.txt')).toBe(true)
})

it('an abort during a repair stops the train: what landed stays, the rest is withheld with its branch, no task worktree is left, and the partial repair is not committed', async () => {
  const root = repo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'abort' })
  await branches(git, { t0: { 'a.txt': 'a\n' }, t1: { 'bad.txt': 'x\n' }, t2: { 'c.txt': 'c\n' } })
  const controller = new AbortController()
  const member = scripted(git, (cwd) => {
    writeFileSync(join(cwd, 'half.txt'), 'partial\n')
    controller.abort(new Error('run cancelled'))
  })
  const journal = SwarmJournal.open(join(tmp('journal'), 'train.jsonl'))
  const config = { checks: [BAD] }
  const error = await landTrain(git, config, {
    journal,
    owners: owners(['t0', 't1', 't2']),
    run: member.run,
    verify: trainVerify(config),
    signal: controller.signal,
  }).catch((e: unknown) => e)
  await git.dispose()

  expect(error).toBeInstanceOf(TrainStoppedError)
  expect((error as Error).message).toBe('run cancelled')
  const outcome = (error as TrainStoppedError).outcome
  expect(keys(outcome.landed)).toEqual(['t0', 't2'])
  expect(keys(outcome.withheld)).toEqual(['t1'])
  expect(outcome.ejected).toEqual([])
  expect(outcome.stopped).toBe('aborted')
  expect(git.list()).toEqual([])
  expect(sh(root, 'worktree', 'list')).not.toContain('.swarm')
  expect(has(root, 'swarm/abort/t1', 'bad.txt')).toBe(true)
  expect(has(root, 'swarm/abort/t1', 'half.txt')).toBe(false)
  expect(journal.events.map((e) => e.type)).not.toContain('train/ejected')
  expect(journal.events.map((e) => e.type)).not.toContain('train/repair')
  expect(journal.events.at(-1)).toMatchObject({ type: 'train/stopped', data: { reason: 'aborted', landed: ['t0', 't2'], withheld: ['t1'] } })
})

it('the verifier: one failure to run is retried; two stop the train, the batch unverified and every branch kept, returned not thrown; an unconfined L3 run throws', async () => {
  const fresh = async (teamId: string) => {
    const root = repo()
    const git = new SwarmGit({ repoRoot: root, teamId })
    await branches(git, { a: { 'a.txt': 'a\n' }, b: { 'b.txt': 'b\n' } })
    return { root, git }
  }
  const config = { checks: ['true'] }

  const once = await fresh('once')
  let calls = 0
  const flaky: TrainVerify = async (cwd, commit) => {
    if (++calls === 2) throw new Error('verifier busy')
    return trainVerify(config)(cwd, commit)
  }
  const retried = await land(once.git, config, { run: scripted(once.git).run, verify: flaky })
  expect(calls).toBe(3)
  expect(keys(retried.outcome.landed)).toEqual(['a', 'b'])
  expect(retried.outcome.stopped).toBeUndefined()

  const twice = await fresh('twice')
  let made = 0
  const down: TrainVerify = async () => {
    if (++made > 1) throw new Error('verifier down')
    return { level: 2, passed: true }
  }
  const unverified = await land(twice.git, config, { run: scripted(twice.git).run, verify: down })
  expect(unverified.events('train/unverified')).toEqual([expect.objectContaining({ batch: 1, entries: ['a', 'b'], error: 'verifier down' })])
  expect(unverified.outcome.stopped).toBe('verifier unavailable: verifier down')
  expect(unverified.outcome.landed).toEqual([])
  expect(keys(unverified.outcome.withheld)).toEqual(['a', 'b'])
  expect(twice.git.list()).toEqual([])
  expect(has(twice.root, 'swarm/twice/b', 'b.txt')).toBe(true)

  const confined = await fresh('confined')
  const unconfined: TrainVerify = async () => {
    throw Object.assign(new Error('could not confine'), { unconfined: true })
  }
  const journal = SwarmJournal.open(join(tmp('journal'), 'train.jsonl'))
  const error = await landTrain(confined.git, config, { journal, owners: new Map(), run: scripted(confined.git).run, verify: unconfined }).catch((e: unknown) => e)
  await confined.git.dispose()
  expect(error).toBeInstanceOf(TrainStoppedError)
  expect((error as TrainStoppedError).outcome).toMatchObject({ stopped: 'could not confine', landed: [] })
  expect(keys((error as TrainStoppedError).outcome.withheld)).toEqual(['a', 'b'])
})

it('through a run: worktree members land through the train, journaled beside the run and shown in its recap; a train that cannot verify is refused before any spend', async () => {
  const root = repo()
  h = await bootHarness({
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"' }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const member = { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } }
  const spec = {
    topology: 'peer-team' as const,
    members: [{ name: 'solo' }],
    tasks: [
      { subject: 'first', prompt: 'do the first task' },
      { subject: 'second', prompt: 'do the second task', blockedBy: [0] },
    ],
  }

  await expect(h.swarm.runTeam(spec, { parent: h.lead.agent, worktrees: { repoRoot: root, member, train: {} } })).rejects.toThrow(
    /needs checks \(L2\) or a hidden suite \(L3\)/,
  )
  await expect(
    h.swarm.runTeam(spec, { parent: h.lead.agent, worktrees: { repoRoot: root, member, autoCommit: false, train: { checks: ['true'] } } }),
  ).rejects.toThrow(/train needs autoCommit/)
  expect(h.mock.requests).toHaveLength(0)

  const run = await h.swarm.start(spec, { parent: h.lead.agent, worktrees: { repoRoot: root, member, train: { checks: ['test -f README.md'] } } })
  const result = await run.result
  const git = result.git!
  expect(keys(git.landed)).toEqual(['task-0', 'task-1'])
  expect(git.ejected).toEqual([])
  for (const landed of git.landed!) {
    const flat = landed.branch.replace(/\//g, '-')
    expect(show(root, git.targetBranch, `out-${flat}.txt`)).toBe(flat)
  }
  const train = SwarmJournal.read(trainJournalPath(h.runsDir, run.id))
  expect(train.filter((e) => e.type === 'train/landed').map((e: any) => e.data.key)).toEqual(['task-0', 'task-1'])
  const recap = h.swarm.view(run.id).recap
  expect(recap.some((line) => /^#t\d+ train: task-1 landed/.test(line))).toBe(true)
  expect(readFileSync(trainJournalPath(h.runsDir, run.id), 'utf8')).not.toBe('')
  expect(sh(root, 'status', '--porcelain')).toBe('')
}, 120_000)

it('a culprit is repaired by the member that wrote its task: under critic-loop, the worker, not the critic that ran after it', async () => {
  const root = repo({ 'README.md': 'base\n', '.gitignore': '.round\n' })
  h = await bootHarness({
    // The worker's turn (bash, done), the critic's (APPROVED), then the repair's (bash, done).
    sequence: ['tool_call_success', 'success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'APPROVED',
    toolName: 'bash',
    // The first turn writes work.txt; the next (the repair) adds fixed.txt.
    toolArguments: JSON.stringify({
      command: 'n=$(( $(cat .round 2>/dev/null || echo 0) + 1 )); echo $n > .round; echo work > work.txt; [ $n -lt 2 ] || touch fixed.txt',
    }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const result = await h.swarm.runTeam(
    {
      topology: 'critic-loop',
      worker: { name: 'writer', persona: 'PERSONA-WRITER' },
      critic: { name: 'critic', persona: 'PERSONA-CRITIC' },
      task: 'write work.txt',
    },
    {
      parent: h.lead.agent,
      worktrees: {
        repoRoot: root,
        member: { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } },
        train: { checks: ['test ! -f work.txt || test -f fixed.txt'] },
      },
    },
  )

  const git = result.git!
  expect(git.repaired).toEqual([{ taskKey: 'task', branch: expect.stringMatching(/\/task$/), repairs: 1 }])
  expect(keys(git.landed)).toEqual(['task'])
  const repairs = h.mock.requests.map((r) => JSON.stringify(r)).filter((r) => r.includes('## Landing'))
  expect(repairs.length).toBeGreaterThan(0)
  for (const request of repairs) {
    expect(request).toContain('PERSONA-WRITER')
    expect(request).not.toContain('PERSONA-CRITIC')
  }
  expect(has(root, git.targetBranch, 'fixed.txt')).toBe(true)
}, 120_000)
