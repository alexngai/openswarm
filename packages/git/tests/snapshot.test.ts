import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmGit, snapshotTree, withSnapshotClone } from '../src/index'

type Git = (...args: string[]) => string

const gitAt =
  (cwd: string): Git =>
  (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString()

function repo(): { root: string; git: Git } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-snapshot-test-'))
  const git = gitAt(root)
  git('init', '-q', '-b', 'main')
  return { root, git }
}

/** Every file outside `.git` with its bytes, and the git state a reviewer might disturb. */
function state(root: string, git: Git) {
  const files = (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((f) => f.split('/')[0] !== '.git')
    .sort()
    .map((f) => {
      try {
        return `${f}=${readFileSync(join(root, f), 'utf8')}`
      } catch {
        return `${f}/` // a directory
      }
    })
  // Through git, so a linked worktree's (whose `.git` is a file) resolve too.
  const gitFile = (name: string) => readFileSync(resolve(root, git('rev-parse', '--git-path', name).trim()))
  return {
    files,
    index: gitFile('index').toString('base64'),
    head: gitFile('HEAD').toString(),
    config: gitFile('config').toString(),
    refs: git('for-each-ref'),
    stash: git('stash', 'list'),
    worktrees: git('worktree', 'list', '--porcelain'),
  }
}

/**
 * A user's checkout mid-work: a stash, a second branch, a staged change, an
 * untracked file, an ignored node_modules and an ignored file of their own.
 */
function userCheckout() {
  const { root, git } = repo()
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nlocal.py\n')
  writeFileSync(join(root, 'tracked.txt'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  git('branch', 'feature')
  writeFileSync(join(root, 'tracked.txt'), 'stashed\n')
  git('stash', '-q')
  writeFileSync(join(root, 'tracked.txt'), 'staged\n')
  git('add', 'tracked.txt')
  writeFileSync(join(root, 'untracked.txt'), 'mine\n')
  writeFileSync(join(root, 'local.py'), 'SECRET = 1\n')
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  return { root, git }
}

it('snapshotTree captures the working tree and leaves status, index, HEAD and refs alone', async () => {
  const { root, git } = userCheckout()
  const status = git('status', '--porcelain')
  const before = state(root, git)
  const head = git('rev-parse', 'HEAD').trim()

  const snapshot = await snapshotTree(root)
  expect(git('show', `${snapshot.commit}:tracked.txt`)).toBe('staged\n')
  expect(git('show', `${snapshot.commit}:untracked.txt`)).toBe('mine\n')
  expect(git('ls-tree', '-r', '--name-only', snapshot.commit)).not.toMatch(/node_modules|local\.py/)
  expect(git('rev-parse', `${snapshot.commit}^`).trim()).toBe(head)
  expect(git('rev-parse', `${snapshot.commit}^{tree}`).trim()).toBe(snapshot.tree)
  expect(state(root, git)).toEqual(before)
  expect(git('status', '--porcelain')).toBe(status)
})

it('snapshotTree works on an unborn HEAD', async () => {
  const { root, git } = repo()
  writeFileSync(join(root, 'a.txt'), 'a\n')
  const snapshot = await snapshotTree(root)
  expect(git('show', `${snapshot.commit}:a.txt`)).toBe('a\n')
  expect(git('log', '--format=%P', '-1', snapshot.commit).trim()).toBe('')
  expect(existsSync(join(root, '.git', 'index'))).toBe(false)
  expect(git('status', '--porcelain')).toBe('?? a.txt\n')
})

it('snapshotTree skips a nested repository with no commit instead of failing', async () => {
  const { root, git } = repo()
  writeFileSync(join(root, 'a.txt'), 'a\n')
  mkdirSync(join(root, 'vendored'))
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'vendored') })
  writeFileSync(join(root, 'vendored', 'x.txt'), 'x\n')
  const snapshot = await snapshotTree(root)
  expect(git('ls-tree', '-r', '--name-only', snapshot.commit).trim()).toBe('a.txt')
})

it('withSnapshotClone: the reviewer works in its own clone; the user\'s files, stash, branches and config never change', async () => {
  const { root, git } = userCheckout()
  const snapshot = await snapshotTree(root)
  const before = state(root, git)
  let inside = ''

  const answer = await withSnapshotClone(root, snapshot.commit, async (cwd) => {
    inside = cwd
    expect(cwd.startsWith(root)).toBe(false)
    const wt = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString().trim()
    expect(wt('rev-parse', 'HEAD')).toBe(snapshot.commit)
    expect(readFileSync(join(cwd, 'untracked.txt'), 'utf8')).toBe('mine\n')
    expect(readFileSync(join(cwd, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    // No way back into the user's repository.
    expect(wt('remote')).toBe('')
    // Everything a reviewer told "do not fix anything" does anyway. Its stash
    // is its own: the pop takes its entry, not the user's newest.
    writeFileSync(join(cwd, 'tracked.txt'), 'reviewer fixed it\n')
    wt('stash', '-q')
    wt('stash', 'pop', '-q')
    expect(wt('stash', 'list')).toBe('')
    writeFileSync(join(cwd, 'scratch.py'), 'assert True\n')
    writeFileSync(join(cwd, 'node_modules', 'pkg', 'new.js'), 'added\n')
    // In place, as bash `>>` or open('a') would: a hard link would write theirs.
    appendFileSync(join(cwd, 'local.py'), 'HACKED = 1\n')
    wt('add', '-A')
    wt('commit', '-qm', 'reviewer commit')
    wt('checkout', '-q', '-b', 'main')
    wt('reset', '-q', '--hard', snapshot.commit)
    wt('branch', '-f', 'feature', 'HEAD')
    wt('config', 'user.name', 'reviewer')
    return 'measured'
  })

  expect(answer).toBe('measured')
  expect(existsSync(inside)).toBe(false)
  expect(state(root, git)).toEqual(before)
  expect(readFileSync(join(root, 'local.py'), 'utf8')).toBe('SECRET = 1\n')
})

/**
 * Snapshot an untracked file in `root` (so the snapshot commit is referenced by
 * nothing), review it in a copy, and check the source repository is untouched.
 */
async function reviewUnreferenced(root: string) {
  const git = gitAt(root)
  writeFileSync(join(root, 'fresh.txt'), 'only in the snapshot\n')
  const snapshot = await snapshotTree(root)
  const before = state(root, git)
  const seen = await withSnapshotClone(root, snapshot.commit, async (cwd) => ({
    file: readFileSync(join(cwd, 'fresh.txt'), 'utf8'),
    log: execFileSync('git', ['log', '--format=%s'], { cwd }).toString(),
  }))
  expect(seen.file).toBe('only in the snapshot\n')
  expect(state(root, git)).toEqual(before)
  return seen
}

function threeCommits(): string {
  const { root, git } = repo()
  for (const n of [1, 2, 3]) {
    writeFileSync(join(root, 'f.txt'), `${n}\n`)
    git('add', '.')
    git('commit', '-qm', `c${n}`)
  }
  return root
}

it('withSnapshotClone reaches an unreferenced snapshot of a SHALLOW repository', async () => {
  // `git clone --shared` of a shallow repo falls back to copying referenced
  // objects only, which loses the snapshot; the copy must not depend on it.
  const source = threeCommits()
  const shallow = join(mkdtempSync(join(tmpdir(), 'openswarm-snapshot-test-')), 'shallow')
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${source}`, shallow])
  expect(existsSync(join(shallow, '.git', 'shallow'))).toBe(true)
  const { log } = await reviewUnreferenced(shallow)
  // History stops at the same boundary, rather than failing on a missing parent.
  expect(log).toBe('gate-snapshot\nc3\n')
})

it('withSnapshotClone reaches an unreferenced snapshot from a linked worktree', async () => {
  const source = threeCommits()
  const linked = join(mkdtempSync(join(tmpdir(), 'openswarm-snapshot-test-')), 'linked')
  gitAt(source)('worktree', 'add', '-q', '--detach', linked)
  const before = state(source, gitAt(source))
  const { log } = await reviewUnreferenced(linked)
  expect(log).toBe('gate-snapshot\nc3\nc2\nc1\n')
  expect(state(source, gitAt(source))).toEqual(before)
})

it('withSnapshotClone replicates the whole ignored environment, build output included; member worktrees still do not', async () => {
  // A monorepo: package x builds to an ignored dist/, and node_modules links to
  // it relatively, so x resolves only where its dist/ exists.
  const { root, git } = repo()
  writeFileSync(join(root, '.gitignore'), 'node_modules/\ndist/\n.venv/\n')
  mkdirSync(join(root, 'packages', 'x'), { recursive: true })
  writeFileSync(join(root, 'packages', 'x', 'package.json'), '{"name":"x","main":"dist/index.js"}\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  mkdirSync(join(root, 'packages', 'x', 'dist'))
  writeFileSync(join(root, 'packages', 'x', 'dist', 'index.js'), 'module.exports = "built"\n')
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true })
  writeFileSync(join(root, '.venv', 'bin', 'python'), '#!/bin/sh\n')
  mkdirSync(join(root, 'node_modules'))
  symlinkSync('../packages/x', join(root, 'node_modules', 'x'))
  const snapshot = await snapshotTree(root)
  const before = state(root, git)

  await withSnapshotClone(root, snapshot.commit, async (cwd) => {
    expect(readFileSync(join(cwd, 'packages', 'x', 'dist', 'index.js'), 'utf8')).toBe('module.exports = "built"\n')
    expect(existsSync(join(cwd, '.venv', 'bin', 'python'))).toBe(true)
    // The workspace link resolves inside the copy, to the copy's own dist/.
    expect(realpathSync(join(cwd, 'node_modules', 'x', 'dist', 'index.js'))).toBe(
      realpathSync(join(cwd, 'packages', 'x', 'dist', 'index.js')),
    )
  })
  expect(state(root, git)).toEqual(before)

  // A member worktree keeps today's filtered environment: dependencies, no build output.
  const team = new SwarmGit({ repoRoot: root, teamId: 'filtered' })
  const wt = await team.worktree('t')
  expect(existsSync(join(wt.path, 'node_modules'))).toBe(true)
  expect(existsSync(join(wt.path, 'packages', 'x', 'dist'))).toBe(false)
  expect(existsSync(join(wt.path, '.venv'))).toBe(false)
  await team.removeAll()
})

it('withSnapshotClone removes the clone when the run throws', async () => {
  const { root, git } = userCheckout()
  const snapshot = await snapshotTree(root)
  const before = state(root, git)
  let inside = ''

  await expect(
    withSnapshotClone(root, snapshot.commit, async (cwd) => {
      inside = cwd
      writeFileSync(join(cwd, 'tracked.txt'), 'half done\n')
      throw new Error('reviewer crashed')
    }),
  ).rejects.toThrow('reviewer crashed')
  expect(existsSync(inside)).toBe(false)
  expect(state(root, git)).toEqual(before)
})

it('withSnapshotClone hands the run the counterpart of a subdirectory cwd, also from an unborn HEAD', async () => {
  const { root } = repo()
  mkdirSync(join(root, 'pkg'))
  writeFileSync(join(root, 'pkg', 'a.txt'), 'a\n')
  const snapshot = await snapshotTree(join(root, 'pkg'))
  const seen = await withSnapshotClone(join(root, 'pkg'), snapshot.commit, async (cwd) =>
    readFileSync(join(cwd, 'a.txt'), 'utf8'),
  )
  expect(seen).toBe('a\n')
})
