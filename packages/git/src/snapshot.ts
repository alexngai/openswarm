/**
 * Non-intrusive tree snapshots for the completion gate (docs/05 B6).
 *
 * The gate runs in the user's real checkout on the single-agent path, so a
 * snapshot may never move HEAD, touch the real index or create a ref: the
 * write goes through a throwaway copy of the index (GIT_INDEX_FILE), and a
 * snapshot is a commit object no ref points at. Nothing is ever restored into
 * the user's tree; a reviewer measures a snapshot in its own clone
 * (`withSnapshotClone`).
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface TreeSnapshot {
  /** A commit of `tree` (parent HEAD, when there is one) that no ref points at. */
  commit: string
  tree: string
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    maxBuffer: 256 << 20,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  })
  return stdout.trim()
}

/**
 * The working tree as a tree object: the real index's entries plus every
 * untracked file, at their working-tree content. A temp copy of the index
 * keeps the stat cache (so unchanged files are not re-hashed) and leaves the
 * real one alone; a missing index is an empty one.
 *
 * ponytail: a submodule or nested repository is recorded as its commit
 * (a gitlink), never its working tree, so edits inside one — or inside a
 * nested repository with no commit yet, which is skipped — are invisible to
 * the gate; snapshot each nested work tree too if gated work ever lives there.
 */
async function writeTree(root: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-index-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const real = resolve(root, await git(root, ['rev-parse', '--git-path', 'index']))
    if (existsSync(real)) copyFileSync(real, env.GIT_INDEX_FILE)
    // A nested repository with no commit cannot be added; --ignore-errors adds
    // everything else and exits 1, so 1 is not a failure here.
    await git(root, ['add', '-A', '--ignore-errors', '--', '.'], env).catch((error) => {
      if (error?.code !== 1) throw error
    })
    return await git(root, ['write-tree'], env)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Snapshot the whole working tree of the checkout at `cwd` (from its top
 * level, whatever subdirectory `cwd` is) without changing HEAD, the index or
 * any ref.
 */
export async function snapshotTree(cwd: string): Promise<TreeSnapshot> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  const tree = await writeTree(root)
  const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => undefined)
  // Bookkeeping, not authorship: a fixed identity, and never signed (a signing
  // prompt would hang an unattended run).
  const commit = await git(root, [
    '-c', 'user.email=swarm@openswarm', '-c', 'user.name=openswarm',
    'commit-tree', '--no-gpg-sign', tree, ...(head === undefined ? [] : ['-p', head]), '-m', 'gate-snapshot',
  ])
  return { commit, tree }
}
