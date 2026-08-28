import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmGit } from '../src/index'

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-git-test-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

function show(root: string, ref: string, file: string): string {
  return execFileSync('git', ['show', `${ref}:${file}`], { cwd: root }).toString()
}

it('per-task worktrees: create, auto-commit, clean merges into the integration branch', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'team1' })

  const a = await git.worktree('task-a')
  const b = await git.worktree('task-b')
  expect(a.branch).toBe('swarm/team1/task-a')
  expect(await git.worktree('task-a')).toBe(a) // memoized per task

  writeFileSync(join(a.path, 'a.txt'), 'from-a\n')
  writeFileSync(join(b.path, 'b.txt'), 'from-b\n')
  expect(await git.autoCommit(a, 'swarm: task-a')).toBe(true)
  expect(await git.autoCommit(a, 'noop')).toBe(false) // clean second pass
  expect(await git.autoCommit(b, 'swarm: task-b')).toBe(true)

  const outcome = await git.mergeAll()
  expect(outcome.targetBranch).toBe('swarm/team1/integration')
  expect(outcome.merged.map((m) => m.taskKey).sort()).toEqual(['task-a', 'task-b'])
  expect(outcome.conflicts).toEqual([])
  expect(show(root, 'swarm/team1/integration', 'a.txt')).toBe('from-a\n')
  expect(show(root, 'swarm/team1/integration', 'b.txt')).toBe('from-b\n')
  // Merged worktrees are removed; branches survive.
  expect(existsSync(a.path)).toBe(false)
  await git.dispose()
})

it('a conflicted merge is aborted and the task branch retained', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'team2' })
  const a = await git.worktree('writes-a')
  const b = await git.worktree('writes-b')
  writeFileSync(join(a.path, 'shared.txt'), 'version A\n')
  writeFileSync(join(b.path, 'shared.txt'), 'version B\n')
  await git.autoCommit(a, 'a')
  await git.autoCommit(b, 'b')

  const outcome = await git.mergeAll()
  expect(outcome.merged).toHaveLength(1)
  expect(outcome.conflicts).toHaveLength(1)
  const kept = outcome.conflicts[0]!
  // The conflicted branch and its worktree survive for inspection.
  expect(execFileSync('git', ['branch', '--list', kept.branch], { cwd: root }).toString()).toContain(
    kept.branch.split('/').pop()!,
  )
  // The target holds the winner's version only.
  expect(show(root, 'swarm/team2/integration', 'shared.txt')).toMatch(/version [AB]\n/)
  await git.dispose()
})

it('an empty task branch merges as nothing and is reported', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'team3' })
  await git.worktree('idle')
  const outcome = await git.mergeAll()
  expect(outcome.empty.map((e) => e.taskKey)).toEqual(['idle'])
  expect(outcome.merged).toEqual([])
  await git.dispose()
})

it('a configured target branch is used and updated in place', async () => {
  const root = scratchRepo()
  execFileSync('git', ['branch', 'integration'], { cwd: root })
  const git = new SwarmGit({ repoRoot: root, teamId: 'team4', targetBranch: 'integration' })
  const a = await git.worktree('t')
  writeFileSync(join(a.path, 'x.txt'), 'x\n')
  await git.autoCommit(a, 'x')
  const outcome = await git.mergeAll()
  expect(outcome.targetBranch).toBe('integration')
  expect(show(root, 'integration', 'x.txt')).toBe('x\n')
  await git.dispose()
})

it('a target branch checked out in the main tree fails loud', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'team5', targetBranch: 'main' })
  const a = await git.worktree('t')
  writeFileSync(join(a.path, 'x.txt'), 'x\n')
  await git.autoCommit(a, 'x')
  await expect(git.mergeAll()).rejects.toThrow(/already used by worktree|already checked out/)
})

it('scratch worktree is detached, excluded from merge, and removed on dispose', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'scratch1' })
  const scratch = await git.scratch()
  expect(await git.scratch()).toBe(scratch) // memoized

  // It's a real git worktree (tools work) but detached — no branch.
  writeFileSync(join(scratch, 'junk.txt'), 'ephemeral\n')
  const head = execFileSync('git', ['-C', scratch, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim()
  expect(head).toBe('HEAD') // detached

  // A task worktree alongside it still merges; scratch contributes nothing.
  const a = await git.worktree('t')
  writeFileSync(join(a.path, 'a.txt'), 'x\n')
  await git.autoCommit(a, 'x')
  const outcome = await git.mergeAll()
  expect(outcome.merged).toHaveLength(1)
  expect(outcome.merged[0]!.taskKey).toBe('t')
  // Nothing scratch-related in any merge bucket.
  const all = [...outcome.merged, ...outcome.conflicts, ...outcome.empty]
  expect(all.some((x) => x.taskKey === '.scratch' || x.branch.includes('.scratch'))).toBe(false)

  await git.dispose()
  expect(existsSync(scratch)).toBe(false)
})

it('worktree() memoizes per key and disambiguates colliding sanitized names', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'wt1' })
  // Concurrent same-key calls share one creation (no double `git worktree add`).
  const [a1, a2] = await Promise.all([git.worktree('task-a'), git.worktree('task-a')])
  expect(a1).toBe(a2)

  // Two distinct keys that sanitize to the same name get distinct branches.
  const x = await git.worktree('feat/x')
  const y = await git.worktree('feat-x')
  expect(x.branch).not.toBe(y.branch)
  await git.dispose()
})

it('sweepOrphans clears worktrees a crashed team left behind, and spares live ones', async () => {
  const root = scratchRepo()
  const live = new SwarmGit({ repoRoot: root, teamId: 'live' })
  const liveTree = await live.worktree('task-a')

  // A team that died before finalizing: its worktree exists on disk and in
  // git's records, exactly as a SIGKILLed run would leave it.
  const dead = new SwarmGit({ repoRoot: root, teamId: 'dead' })
  const deadTree = await dead.worktree('task-b')
  expect(existsSync(deadTree.path)).toBe(true)

  // Also the reverse leak: a directory git no longer lists at all.
  const strayTeam = join(root, '.swarm', 'worktrees', 'stray')
  mkdirSync(strayTeam, { recursive: true })
  writeFileSync(join(strayTeam, 'leftover.txt'), 'x\n')

  // Simulate the crash: git's record for the dead team is gone, the dir is not.
  execFileSync('git', ['worktree', 'remove', '--force', deadTree.path], { cwd: root })
  mkdirSync(deadTree.path, { recursive: true })
  writeFileSync(join(deadTree.path, 'leftover.txt'), 'x\n')

  // Age both orphans past the sweep's "still starting" grace window, which
  // exists so a peer mid-`worktree add` is never pulled out from under.
  // The sweep ages TEAM directories, so backdate those, not the worktrees
  // nested inside them.
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(join(root, '.swarm', 'worktrees', 'dead'), old, old)
  utimesSync(strayTeam, old, old)

  const removed = await SwarmGit.sweepOrphans(root)

  expect(existsSync(deadTree.path)).toBe(false)
  expect(existsSync(strayTeam)).toBe(false)
  expect(removed.some((p) => p.endsWith('dead'))).toBe(true)
  // The live team is untouched: git still lists it, so the sweep skips it.
  expect(existsSync(liveTree.path)).toBe(true)
  // ...and it still works afterwards.
  writeFileSync(join(liveTree.path, 'a.txt'), 'from-a\n')
  expect(await live.autoCommit(liveTree, 'swarm: task-a')).toBe(true)
})

it('sweepOrphans is a no-op in a repo that has never run a swarm', async () => {
  expect(await SwarmGit.sweepOrphans(scratchRepo())).toEqual([])
})

it('removeAll drops every worktree without merging, and keeps the branches', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'aborted' })
  const a = await git.worktree('task-a')
  const b = await git.worktree('task-b')
  writeFileSync(join(a.path, 'a.txt'), 'from-a\n')
  await git.autoCommit(a, 'swarm: task-a')
  await git.scratch()

  await git.removeAll()

  // Checkouts gone...
  expect(existsSync(a.path)).toBe(false)
  expect(existsSync(b.path)).toBe(false)
  // ...but committed member work is still reachable by branch, which is what
  // makes dropping a crashed run's worktrees safe.
  expect(show(root, a.branch, 'a.txt')).toBe('from-a\n')
  const branches = execFileSync('git', ['branch', '--list', 'swarm/aborted/*'], { cwd: root }).toString()
  expect(branches).toContain('swarm/aborted/task-a')
})

it('sweepOrphans leaves a just-created team dir alone (a peer may be mid-creation)', async () => {
  const root = scratchRepo()
  const starting = join(root, '.swarm', 'worktrees', 'starting-now')
  mkdirSync(starting, { recursive: true })

  expect(await SwarmGit.sweepOrphans(root)).toEqual([])
  expect(existsSync(starting)).toBe(true)
})

it('the first worktree teaches the repo to ignore .swarm/', async () => {
  const root = scratchRepo()
  const git = new SwarmGit({ repoRoot: root, teamId: 'ignore-me' })
  const exclude = join(root, '.git', 'info', 'exclude')
  expect(readFileSync(exclude, 'utf8')).not.toContain('.swarm')

  await git.worktree('task-a')

  expect(readFileSync(exclude, 'utf8')).toContain('.swarm/')
  // The worktree dir is genuinely ignored now, not merely mentioned.
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString()
  expect(status).not.toContain('.swarm')

  // Idempotent: a second team does not append a duplicate line.
  const second = new SwarmGit({ repoRoot: root, teamId: 'ignore-me-too' })
  await second.worktree('task-b')
  const lines = readFileSync(exclude, 'utf8').split('\n').filter((l) => l.trim() === '.swarm/')
  expect(lines).toHaveLength(1)
})
