import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
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
