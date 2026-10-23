/**
 * A headless team spec end to end (`--spec`, docs/05 B2 exit criterion 1):
 * real `runCli`, real dsh subprocess members in real worktrees of a scratch
 * repo, real landings — keyless.
 *
 * Members run concurrently across subprocesses, so the dsh mock's single FIFO
 * script would hand a tool call to whichever member asked first. A small router
 * picks the reply from the conversation instead: a member's first turn gets a
 * bash call, the turn after the tool result gets the closing text, so every
 * member is exactly two requests, whatever the interleaving.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { startMockRouter } from './support/router'
import { checkoutState, fastForward, runCli } from '../src/index'

const originalCwd = process.cwd()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  process.chdir(originalCwd)
  delete process.env['OPENSWARM_PILOT_PLAN']
  delete process.env['OPENSWARM_PILOT_ARM']
  delete process.env['OPENSWARM_TEAM_SPEC']
  delete process.env['OPENSWARM_CLAUDE_BIN']
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function startRouter(command: string): Promise<{ baseURL: string; requests: () => number }> {
  const router = await startMockRouter(command)
  cleanups.push(router.close)
  return router
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd }).toString().trim()

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-pilot-e2e-'))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', '.')
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  // Hooks that fail everything: auto-commit, the merge queue, and `land` are
  // harness bookkeeping and must never run them.
  for (const hook of ['pre-commit', 'pre-merge-commit', 'commit-msg']) {
    writeFileSync(join(root, '.git', 'hooks', hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  }
  return root
}

/** Each worker records what its worktree held when cut, in a file named by its branch. */
const LIST_TREE = 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); ls > "out-$b.txt"'

async function run(argv: string[]) {
  const lines: string[] = []
  const code = await runCli(
    ['--headless', '--output-format', 'json', '--model', 'mock-model', ...argv, 'ship the roadmap'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  const events = lines.map((l) => JSON.parse(l))
  return { code, events, stop: events.at(-1) }
}

function writeSpec(spec: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'openswarm-spec-')), 'spec.json')
  writeFileSync(path, JSON.stringify(spec))
  return path
}

/** Each task writes a file named by its branch, and task-1 also plants bad.txt; a run that finds bad.txt (the repair) removes it. */
const PLANT = 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); if [ -f bad.txt ]; then rm bad.txt; else echo "$b" > "out-$b.txt"; case "$b" in *-task-1) echo planted > bad.txt;; esac; fi'

it('team spec: a peer-team lands through the train, its planted bad commit bisected out without blocking its batch-mate and repaired, every run billed, the workspace fast-forwarded', async () => {
  const router = await startRouter(PLANT)
  const repo = scratchRepo()
  process.chdir(repo)
  // The env path, alongside the `--single` swarmkit always emits.
  process.env['OPENSWARM_TEAM_SPEC'] = writeSpec({
    topology: 'peer-team',
    members: [{ name: 'm0' }, { name: 'm1' }],
    tasks: [
      { subject: 't0', prompt: '## Your thread: t0' },
      { subject: 't1', prompt: '## Your thread: t1', blockedBy: [0] },
      { subject: 't2', prompt: '## Your thread: t2', blockedBy: [0] },
    ],
    worktrees: { train: { checks: ['test ! -f bad.txt'], batchSize: 4, maxRepairs: 1 } },
  })

  const { code, events, stop } = await run(['--single'])
  expect(code).toBe(0)
  const note = events.find((e) => e.type === 'team_note')
  expect(note).toMatchObject({ topology: 'peer-team', landed: ['task-0', 'task-2', 'task-1'], ejected: [], withheld: [], workspace: 'fast-forwarded' })
  expect(note.metrics.landing).toMatchObject({ entries: 3, landed: 3, bisects: 1 })

  // task-1 and task-2 were batched; the failure was bisected to task-1, task-2 landed before its repair, and the repair landed it.
  const train = readFileSync(join(process.env['OPENSWARM_HOME']!, 'runs', note.runId, 'train.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
  // Within a batch, entries go by priority, which follows the board's last update (whichever task finished last), so compare them sorted.
  const batches = train.filter((e) => e.type === 'train/batch').map((e) => [e.data.parent ?? null, e.data.entries.map((x: any) => x.key).sort()])
  expect(batches).toHaveLength(5)
  expect(batches[0]).toEqual([null, ['task-0']])
  expect(batches[1]).toEqual([null, ['task-1', 'task-2']])
  expect(batches.slice(2, 4).sort()).toEqual([[2, ['task-1']], [2, ['task-2']]])
  expect(batches[4]).toEqual([null, ['task-1']])
  const order = train.filter((e) => e.type === 'train/landed' || e.type === 'train/repair').map((e) => `${e.type.slice(6)} ${e.data.key}`)
  expect(order).toEqual(['landed task-0', 'landed task-2', 'repair task-1', 'landed task-1'])

  // The workspace holds the landed result: every task's work, not the planted file, nothing left over.
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', note.targetBranch))
  expect(git(repo, 'ls-files').split('\n').filter((f) => f.startsWith('out-'))).toHaveLength(3)
  expect(git(repo, 'ls-files', 'bad.txt')).toBe('')
  expect(git(repo, 'status', '--porcelain')).toBe('')

  // Three tasks and the repair, two requests each, all counted once.
  expect(router.requests()).toBe(8)
  expect(stop.type).toBe('message_stop')
  expect(stop.usage.inputTokens).toBe(3 * router.requests())
}, 180_000)

it('team spec: a fanout lands through the queue; a workspace that is not clean is left as is, the result on the target branch', async () => {
  const router = await startRouter(LIST_TREE)
  const repo = scratchRepo()
  writeFileSync(join(repo, 'mine.txt'), 'uncommitted\n')
  const head = git(repo, 'rev-parse', 'HEAD')
  process.chdir(repo)

  const { code, events, stop } = await run(['--spec', writeSpec({ topology: 'fanout', members: [{ name: 'solo' }], tasks: [{ member: 'solo', prompt: 'list the tree' }] })])
  expect(code).toBe(0)
  const note = events.find((e) => e.type === 'team_note')
  expect(note.landed).toEqual(['task-0'])
  expect(note.workspace).toMatch(/^refused to fast-forward: the workspace is not clean/)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
  expect(readFileSync(join(repo, 'mine.txt'), 'utf8')).toBe('uncommitted\n')
  expect(git(repo, 'ls-tree', '--name-only', note.targetBranch)).toMatch(/^out-/m)
  expect(stop.usage.inputTokens).toBe(3 * router.requests())
}, 180_000)

it('team spec: refused before booting when it conflicts or is not a peer-team or fanout', async () => {
  const fails = async (argv: string[]) => {
    const lines: string[] = []
    const code = await runCli(['--output-format', 'json', '--model', 'mock-model', ...argv, 'go'], { out: (l) => lines.push(l), err: () => {} })
    expect(code).toBe(1)
    return lines.map((l) => JSON.parse(l)).find((e) => e.type === 'error')?.message
  }
  const peer = writeSpec({ topology: 'peer-team', members: [{ name: 'm' }], tasks: [{ subject: 's', prompt: 'p' }] })
  expect(await fails(['--spec', peer, '--team'])).toMatch(/--spec cannot be combined with --team or --single/)
  expect(await fails(['--spec', peer, '--gate'])).toMatch(/cannot be combined with a team spec/)
  expect(await fails(['--spec', writeSpec({ topology: 'coordinator' })])).toMatch(/topology must be peer-team or fanout/)
  // A gated task without checks is accepted by review alone, which the run says up front (docs/07 §7.10).
  const errs: string[] = []
  const reviewed = writeSpec({ topology: 'peer-team', members: [{ name: 'm' }], gate: {}, tasks: [{ subject: 's', prompt: 'p' }, { subject: 't', prompt: 'q', checks: ['true'] }] })
  await runCli(['--output-format', 'json', '--model', 'mock-model', '--spec', reviewed, '--gate', 'go'], { out: () => {}, err: (l) => errs.push(l) })
  expect(errs).toContainEqual(expect.stringMatching(/^openswarm: 1 of 2 gated task\(s\) have no checks, so a reviewer alone accepts/))
})

it('team spec: claude-code members alone need no dsh route; their usage, cache writes and dollars reach message_stop', async () => {
  const fake = fileURLToPath(new URL('../../swarm/tests/support/fake-claude.mjs', import.meta.url))
  chmodSync(fake, 0o755)
  process.env['OPENSWARM_CLAUDE_BIN'] = fake
  const repo = scratchRepo()
  process.chdir(repo)
  // A Claude model id is no OpenAI-compatible route, which a dsh member would need.
  const spec = writeSpec({ topology: 'fanout', members: [{ name: 'cc', runtime: 'claude-code' }], tasks: [{ member: 'cc', prompt: 'write it' }] })
  const lines: string[] = []
  const code = await runCli(['--output-format', 'json', '--model', 'claude-fake-1', '--spec', spec, 'ship it'], { out: (l) => lines.push(l), err: () => {} })
  const events = lines.map((l) => JSON.parse(l))
  expect(events.find((e) => e.type === 'error')).toBeUndefined()
  expect(code).toBe(0)
  expect(events.find((e) => e.type === 'team_note')).toMatchObject({ landed: ['task-0'], workspace: 'fast-forwarded' })
  expect(git(repo, 'show', 'HEAD:claude-out.txt')).toBe('broken')
  // The fake reports 12 in, 34 out, 500 cache reads, 200 cache writes and $0.0421 per run.
  expect(events.at(-1)).toEqual({
    type: 'message_stop',
    usage: { inputTokens: 12, outputTokens: 34, cacheReadInputTokens: 500, cacheWriteInputTokens: 200, claudeCodeCostUsd: 0.0421 },
  })
}, 60_000)

it('the fast-forward moves only the branch the run started on, at the commit it started from, over a clean checkout, never onto an ignored file', () => {
  /** A repo whose `landed` branch adds a file under the ignored build/, or out.txt; the checkout on main at its base. */
  const setup = (path: string) => {
    const repo = scratchRepo()
    writeFileSync(join(repo, '.gitignore'), 'build/\n')
    git(repo, 'add', '.gitignore')
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', 'ignore build')
    git(repo, 'branch', 'landed')
    const wt = join(mkdtempSync(join(tmpdir(), 'openswarm-ff-')), 'wt')
    git(repo, 'worktree', 'add', '-q', wt, 'landed')
    mkdirSync(join(wt, 'build'), { recursive: true })
    writeFileSync(join(wt, path), 'landed\n')
    git(wt, 'add', '-f', path)
    git(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', 'land')
    git(repo, 'worktree', 'remove', '--force', wt)
    return { repo, start: checkoutState(repo) }
  }
  let { repo, start } = setup('out.txt')
  expect(fastForward(repo, 'landed', start)).toBe('fast-forwarded')
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'landed'))
  expect(fastForward(repo, 'nope', start)).toBe('nothing landed')

  // An ignored build/ in the checkout, which the landed branch writes into: git would overwrite it silently.
  ;({ repo, start } = setup('build/out.txt'))
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'build', 'out.txt'), 'mine\n')
  expect(fastForward(repo, 'landed', start)).toMatch(/would overwrite build\/out\.txt, which is ignored/)
  expect(readFileSync(join(repo, 'build', 'out.txt'), 'utf8')).toBe('mine\n')

  // A dirty checkout; a branch that moved; another branch checked out; a detached HEAD: each refused, HEAD untouched.
  ;({ repo, start } = setup('out.txt'))
  writeFileSync(join(repo, 'scratch.txt'), 'x\n')
  expect(fastForward(repo, 'landed', start)).toMatch(/^refused to fast-forward: the workspace is not clean/)
  ;({ repo, start } = setup('out.txt'))
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'moved')
  expect(fastForward(repo, 'landed', start)).toMatch(/refs\/heads\/main moved during the run/)
  ;({ repo, start } = setup('out.txt'))
  git(repo, 'checkout', '-q', '-b', 'other')
  expect(fastForward(repo, 'landed', start)).toMatch(/refs\/heads\/main is no longer checked out/)
  ;({ repo } = setup('out.txt'))
  git(repo, 'checkout', '-q', '--detach')
  const detached = checkoutState(repo)
  expect(fastForward(repo, 'landed', detached)).toMatch(/^refused to fast-forward: the workspace was on a detached HEAD/)
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(detached.head)
})
