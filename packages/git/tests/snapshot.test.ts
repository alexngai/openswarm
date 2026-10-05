import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { snapshotTree, withSnapshotClone } from '../src/index'

type Git = (...args: string[]) => string

function repo(): { root: string; git: Git } {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-snapshot-test-'))
  const git: Git = (...args) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root }).toString()
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
  return {
    files,
    index: readFileSync(join(root, '.git', 'index')).toString('base64'),
    head: readFileSync(join(root, '.git', 'HEAD'), 'utf8'),
    config: readFileSync(join(root, '.git', 'config'), 'utf8'),
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
    wt('checkout', '-q', 'main')
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
