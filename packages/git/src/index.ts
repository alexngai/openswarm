/**
 * OpenSwarm git layer — per-task worktrees, auto-commit, and a sequential
 * merge queue (docs/01 Phase 2).
 *
 * Everything shells out to the system git. Task worktrees live under
 * `<repoRoot>/.swarm/worktrees/<teamId>/` on branches
 * `swarm/<teamId>/<taskKey>`. Merges happen inside a dedicated target
 * worktree, never in the user's checkout; the default target is a fresh
 * integration branch `swarm/<teamId>/integration` cut from the base ref
 * (task branches occupy `swarm/<teamId>/<taskKey>`, so the integration ref
 * lives beside them, never at the directory node), and a
 * configured target branch that is already checked out elsewhere fails
 * loud with git's own error. A conflicted merge is aborted and the task
 * branch retained for inspection — never auto-resolved.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export { snapshotTree, type TreeSnapshot } from './snapshot'

export interface SwarmGitOptions {
  repoRoot: string
  teamId: string
  /** Base ref task worktrees start from (default HEAD's current commit). */
  baseRef?: string
  /** Merge target branch (default: fresh integration branch `swarm/<teamId>/integration`). */
  targetBranch?: string
  /** Directory holding this team's worktrees (default `<repoRoot>/.swarm/worktrees/<teamId>`). */
  worktreeDir?: string
  /** Hard-link the main checkout's ignored environment into each new member worktree (default true). */
  linkIgnored?: boolean
  /** One human-readable progress line (what was linked, and how long it took). */
  onProgress?: (line: string) => void
}

/** Ignored files an import needs: native extensions and generated Python source (spaCy's `git_info.py`). */
const ENVIRONMENT_FILE = /\.(so|pyd|dylib|node|py)$/
/** Never replicated: build output a member's build regenerates, and the swarm's own scratch. */
const NOT_ENVIRONMENT = /(^|\/)(dist|build|out|coverage|\.cache|__pycache__|[^/]*\.egg-info|\.turbo|\.next|\.swarm)\//

export interface WorktreeInfo {
  taskKey: string
  path: string
  branch: string
}

export interface MergeOutcome {
  targetBranch: string
  /** Task branches merged into the target, in merge order. */
  merged: { taskKey: string; branch: string; commits: number }[]
  /** Task branches retained after a conflicted merge was aborted. */
  conflicts: { taskKey: string; branch: string }[]
  /** Task branches with no commits — nothing to merge. */
  empty: { taskKey: string; branch: string }[]
  /**
   * Task branches deliberately NOT merged because the run was not accepted.
   * The commits survive under these branch names, so withheld work is
   * recoverable; it just does not reach the integration branch on a verdict
   * that said the work was not good enough.
   */
  withheld: { taskKey: string; branch: string }[]
}

/** A team directory younger than this is treated as starting, not abandoned. */
const RECENT_MS = 60_000

export class SwarmGit {
  private readonly worktrees = new Map<string, WorktreeInfo>()
  /** One in-flight creation promise per task key — the concurrency memo. */
  private readonly worktreePromises = new Map<string, Promise<WorktreeInfo>>()
  /** Safe branch names already assigned, to disambiguate lossy collisions. */
  private readonly usedNames = new Set<string>()
  private ignoreChecked = false
  private base: string | undefined
  private targetPath: string | undefined
  private scratchPromise: Promise<string> | undefined

  constructor(private readonly options: SwarmGitOptions) {}

  private git(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
    return run('git', args, { cwd })
  }

  private get dir(): string {
    return (
      this.options.worktreeDir ??
      join(this.options.repoRoot, '.swarm', 'worktrees', this.options.teamId)
    )
  }

  /**
   * Create this team's worktree root, and the first time we do it, teach the
   * repo to ignore `.swarm/` — the default root lives INSIDE the user's
   * checkout, so without this every run leaves them staring at untracked
   * directories they did not create.
   *
   * `.git/info/exclude` rather than `.gitignore`: it is the per-clone,
   * untracked ignore file, so we never write to a file the user commits.
   * Skipped entirely for a custom `worktreeDir` outside the repo (not ours to
   * ignore) and for a `.git` that is not a real directory (a checkout that is
   * itself a worktree or submodule), where the path simply does not exist.
   */
  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true })
    if (this.ignoreChecked) return
    this.ignoreChecked = true
    const swarmRoot = join(this.options.repoRoot, '.swarm')
    if (!this.dir.startsWith(swarmRoot)) return
    try {
      const exclude = join(this.options.repoRoot, '.git', 'info', 'exclude')
      const current = readFileSync(exclude, 'utf8')
      if (/^\s*\.swarm\/?\s*$/m.test(current)) return
      appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}.swarm/\n`)
    } catch {
      // No standard .git/info/exclude here; nothing to teach.
    }
  }

  get targetBranch(): string {
    return this.options.targetBranch ?? `swarm/${this.options.teamId}/integration`
  }

  /** The resolved base commit (memoized on first use). */
  async baseCommit(): Promise<string> {
    if (this.base === undefined) {
      const { stdout } = await this.git(
        this.options.repoRoot,
        'rev-parse',
        this.options.baseRef ?? 'HEAD',
      )
      this.base = stdout.trim()
    }
    return this.base
  }

  /**
   * Create (or return the existing) worktree for one task. Promise-memoized
   * per key, so concurrent calls for the same key share one creation instead
   * of both running `git worktree add`.
   */
  worktree(taskKey: string): Promise<WorktreeInfo> {
    let promise = this.worktreePromises.get(taskKey)
    if (promise === undefined) {
      promise = this.createWorktree(taskKey)
      this.worktreePromises.set(taskKey, promise)
    }
    return promise
  }

  private async createWorktree(taskKey: string): Promise<WorktreeInfo> {
    const sanitized = taskKey.replace(/[^A-Za-z0-9._-]/g, '-')
    // Distinct keys that sanitize to the same name (or a name already taken)
    // would otherwise collide on one branch; a short deterministic hash keeps
    // each key's branch unique while staying readable.
    const safe =
      sanitized === taskKey && !this.usedNames.has(sanitized)
        ? sanitized
        : `${sanitized}-${createHash('sha1').update(taskKey).digest('hex').slice(0, 8)}`
    this.usedNames.add(safe)
    const branch = `swarm/${this.options.teamId}/${safe}`
    const path = join(this.dir, safe)
    this.ensureDir()
    await this.git(this.options.repoRoot, 'worktree', 'add', '-b', branch, path, await this.baseCommit())
    await this.link(path)
    const info: WorktreeInfo = { taskKey, path, branch }
    this.worktrees.set(taskKey, info)
    return info
  }

  /** {@link linkIgnored} into a new worktree, unless the team opted out. */
  private async link(path: string): Promise<void> {
    if (this.options.linkIgnored === false) return
    await linkIgnored(this.options.repoRoot, path, this.options.onProgress === undefined ? {} : { onProgress: this.options.onProgress })
  }

  /**
   * Force pathspecs in a worktree back to their base-commit state, discarding
   * any member edits AND any files the member added under them.
   *
   * This exists because a command gate that runs the repo's own tests reads
   * those tests FROM the worktree it is grading — so a member can pass the
   * gate by weakening the tests rather than by fixing the code. Restoring the
   * verification assets before each gate run takes them out of the graded
   * party's control.
   *
   * `checkout` alone would only restore tracked files, leaving an added file
   * (a fixture that neuters collection, say) in place, so the clean pass is
   * part of the guarantee rather than tidiness.
   *
   * Returns the paths that had in fact been modified, so a caller can say so
   * out loud — silently reverting a member's work would be its own trap.
   */
  async restoreFromBase(worktree: WorktreeInfo, pathspecs: string[]): Promise<string[]> {
    if (pathspecs.length === 0) return []
    const { stdout } = await this.git(worktree.path, 'status', '--porcelain', '--', ...pathspecs)
    const touched = stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== '')
    const base = await this.baseCommit()
    // `checkout` errors on a pathspec absent from the base tree, but pinning a
    // path that does not exist at base is a legitimate instruction — "nothing
    // may appear here" — which `clean` alone satisfies. So restore only the
    // pathspecs base actually knows, and let clean handle the rest.
    const known: string[] = []
    for (const spec of pathspecs) {
      const { stdout: listed } = await this.git(worktree.path, 'ls-tree', '-r', '--name-only', base, '--', spec)
      if (listed.trim() !== '') {
        known.push(spec)
        continue
      }
      // Absent from base is legitimate ONLY if the member put something there
      // ("nothing may appear here", which clean alone satisfies). Absent from
      // both means the pathspec matches nothing at all — a typo, or a glob git
      // does not expand the way the caller assumed. Treating that as a no-op
      // makes a gate that pins NOTHING look identical to one that works, which
      // is how `packages/*/tests` sat inert through a whole live matrix.
      const { stdout: present } = await this.git(worktree.path, 'status', '--porcelain', '--', spec)
      if (present.trim() === '') {
        throw new Error(
          `restoreFromBase: pathspec "${spec}" matches nothing at base and nothing in the worktree — ` +
            'it pins nothing. Note git matches wildcards against WHOLE paths, so "a/*/b" does not ' +
            'match "a/x/b/c.ts"; pass the directory itself.',
        )
      }
    }
    if (known.length > 0) {
      await this.git(worktree.path, 'checkout', base, '--', ...known)
    }
    await this.git(worktree.path, 'clean', '-fdq', '--', ...pathspecs)
    return touched
  }

  /**
   * Commit everything dirty in one worktree; false when it was clean.
   *
   * `--no-verify` here and on every merge the harness makes: these commits are
   * bookkeeping, not authorship, and a repo's hooks often depend on git-ignored
   * setup a worktree lacks (husky's `.husky/_/husky.sh`), so one failing hook
   * failed every thread of a task. Members' own git commands still run hooks.
   */
  async autoCommit(worktree: WorktreeInfo, message: string): Promise<boolean> {
    await this.git(worktree.path, 'add', '-A')
    try {
      await this.git(worktree.path, 'diff', '--cached', '--quiet')
      return false // clean
    } catch {
      await this.git(
        worktree.path,
        '-c', 'user.email=swarm@openswarm', '-c', 'user.name=openswarm',
        'commit', '-q', '--no-verify', '-m', message,
      )
      return true
    }
  }

  /** Number of commits a task branch carries beyond the base. */
  async commitCount(branch: string): Promise<number> {
    const { stdout } = await this.git(
      this.options.repoRoot,
      'rev-list', '--count', `${await this.baseCommit()}..${branch}`,
    )
    return Number(stdout.trim())
  }

  /** The target worktree the merge queue operates in (created on first use). */
  private async targetWorktree(): Promise<string> {
    if (this.targetPath !== undefined) return this.targetPath
    const path = join(this.dir, '.target')
    this.ensureDir()
    const { stdout } = await this.git(this.options.repoRoot, 'branch', '--list', this.targetBranch)
    if (stdout.trim() === '') {
      await this.git(this.options.repoRoot, 'worktree', 'add', '-b', this.targetBranch, path, await this.baseCommit())
    } else {
      // Existing target: git itself fails loud if it is checked out elsewhere.
      await this.git(this.options.repoRoot, 'worktree', 'add', path, this.targetBranch)
    }
    this.targetPath = path
    return path
  }

  /**
   * Sequentially merge every task worktree's branch into the target. A
   * conflicted merge is aborted and the branch retained; merged and empty
   * task worktrees are removed (branches always survive).
   */
  async mergeAll(): Promise<MergeOutcome> {
    const outcome: MergeOutcome = {
      targetBranch: this.targetBranch,
      merged: [],
      conflicts: [],
      empty: [],
      withheld: [],
    }
    if (this.worktrees.size === 0) return outcome
    const target = await this.targetWorktree()
    for (const info of this.worktrees.values()) {
      const commits = await this.commitCount(info.branch)
      if (commits === 0) {
        outcome.empty.push({ taskKey: info.taskKey, branch: info.branch })
        await this.removeWorktree(info)
        continue
      }
      try {
        await this.git(
          target,
          '-c', 'user.email=swarm@openswarm', '-c', 'user.name=openswarm',
          'merge', '--no-ff', '--no-verify', '-q', '-m', `swarm: merge ${info.branch}`, info.branch,
        )
        outcome.merged.push({ taskKey: info.taskKey, branch: info.branch, commits })
        await this.removeWorktree(info)
      } catch {
        await this.git(target, 'merge', '--abort').catch(() => {})
        outcome.conflicts.push({ taskKey: info.taskKey, branch: info.branch })
        // Retain the conflicted worktree and branch for inspection.
      }
    }
    return outcome
  }

  /**
   * A throwaway, detached worktree for member runs that have no task branch
   * (committee judge, coordinator synthesis, …). Detached at the base commit,
   * so it carries no branch and never enters the merge set; it isolates those
   * runs from the user's checkout and is removed on dispose. Promise-memoized
   * so concurrent callers share one worktree instead of racing its creation.
   */
  scratch(): Promise<string> {
    if (this.scratchPromise === undefined) {
      this.scratchPromise = (async () => {
        const path = join(this.dir, '.scratch')
        this.ensureDir()
        await this.git(this.options.repoRoot, 'worktree', 'add', '--detach', path, await this.baseCommit())
        await this.link(path)
        return path
      })()
    }
    return this.scratchPromise
  }

  private async removeWorktree(info: WorktreeInfo): Promise<void> {
    await this.git(this.options.repoRoot, 'worktree', 'remove', '--force', info.path).catch(() => {
      rmSync(info.path, { recursive: true, force: true })
    })
    this.worktrees.delete(info.taskKey)
    this.worktreePromises.delete(info.taskKey)
  }

  /**
   * Tear down every worktree this run created — task, target, and scratch —
   * without merging. The abort path: branches always survive, so nothing a
   * member committed is lost, but the checkouts stop littering the repo.
   */
  async removeAll(): Promise<void> {
    for (const info of [...this.worktrees.values()]) await this.removeWorktree(info)
    await this.dispose()
  }

  /**
   * Remove worktrees left behind by teams that died before finalizing (SIGKILL,
   * a crashed host, a killed terminal) — the case try/finally cannot cover.
   *
   * `git worktree prune` clears git's administrative records for directories
   * that no longer exist; the directory pass then removes team dirs git no
   * longer lists, which is the reverse leak (dir on disk, record pruned).
   * Only ever touches `<repoRoot>/.swarm/worktrees/`, never a user path, and
   * never a directory git still lists as a live worktree.
   *
   * ponytail: a live team's dirs ARE git-listed, so a concurrent run is safe
   * without locking. Two swarms starting in the same millisecond could still
   * race the prune; per-repo locking if that ever bites.
   */
  static async sweepOrphans(repoRoot: string, root?: string): Promise<string[]> {
    await run('git', ['worktree', 'prune'], { cwd: repoRoot }).catch(() => undefined)
    const dir = root ?? join(repoRoot, '.swarm', 'worktrees')
    let teams: string[]
    try {
      teams = readdirSync(dir)
    } catch {
      return [] // nothing has ever run here
    }
    const listed = await run('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot })
      .then(({ stdout }) => stdout)
      .catch(() => '')
    const removed: string[] = []
    for (const team of teams) {
      const path = join(dir, team)
      if (listed.includes(path)) continue // a live team owns it
      // A team that has created its directory but not yet finished
      // `git worktree add` is not listed either, so age is what separates
      // "starting" from "abandoned". Anything touched in the last minute is
      // left for the next sweep rather than pulled out from under a peer.
      try {
        if (Date.now() - statSync(path).mtimeMs < RECENT_MS) continue
      } catch {
        continue // vanished under us; nothing to remove
      }
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    }
    return removed
  }

  /** Remove the target and scratch worktrees (branches survive). */
  async dispose(): Promise<void> {
    if (this.targetPath !== undefined) {
      await this.git(this.options.repoRoot, 'worktree', 'remove', '--force', this.targetPath).catch(
        () => {},
      )
      this.targetPath = undefined
    }
    if (this.scratchPromise !== undefined) {
      const scratch = await this.scratchPromise.catch(() => undefined)
      this.scratchPromise = undefined
      if (scratch !== undefined) {
        await this.git(this.options.repoRoot, 'worktree', 'remove', '--force', scratch).catch(() => {})
      }
    }
  }
}

/**
 * Replicate a checkout's git-ignored ENVIRONMENT into a fresh worktree of it.
 * A worktree is gitignore-clean, so without this a TypeScript repo has no
 * `node_modules` (a member can neither build nor test there) and a Python
 * package with compiled extensions cannot even import.
 *
 * Replicated: every ignored `node_modules/` (nested ones too), ignored native
 * extensions, and ignored `*.py` — never build output or `.swarm/`, and
 * nothing the worktree already has. By hard link (`cp -al` keeps symlinks as
 * symlinks, so relative workspace links resolve INSIDE the worktree), with a
 * plain copy only where linking fails (across filesystems). Best-effort: a
 * failure leaves the worktree as git made it, and says so.
 *
 * `whole` replicates ALL of it, for a reviewer's copy, which has to run the
 * repo's tests as the checkout does: every ignored directory (build output
 * too — a monorepo's packages resolve each other through ignored `dist/` via
 * relative node_modules links — and `.venv`, `target`, caches), unfiltered but
 * for `.swarm/` and anything under `.git`; and every ignored loose file
 * COPIED rather than linked (a reflink where the filesystem has one), since
 * one can be the user's own (`local_settings.py`) and an append or
 * `open('w')` through a hard link writes their file.
 */
export async function linkIgnored(
  repoRoot: string,
  path: string,
  options: { onProgress?: (line: string) => void; whole?: boolean } = {},
): Promise<void> {
  const started = Date.now()
  let linked = 0
  try {
    const { stdout } = await run(
      'git',
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      { cwd: repoRoot },
    )
    for (const entry of stdout.split('\0')) {
      const isDir = entry.endsWith('/') // git marks directories with a trailing slash
      const rel = isDir ? entry.slice(0, -1) : entry
      const wanted =
        options.whole === true
          ? !/(^|\/)(\.swarm|\.git)(\/|$)/.test(rel)
          : (isDir ? /(^|\/)node_modules$/.test(rel) : ENVIRONMENT_FILE.test(rel)) && !NOT_ENVIRONMENT.test(entry)
      if (!wanted) continue
      const from = join(repoRoot, rel)
      const to = join(path, rel)
      if (existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      if (!isDir && options.whole === true) {
        copyFileSync(from, to, constants.COPYFILE_FICLONE)
        linked++
        continue
      }
      // ponytail: a hard-linked directory means a tool rewriting a file in place
      // (a rebuilt .so, tsc overwriting dist, a pip upgrade in .venv, a file of
      // the user's inside an ignored directory) also changes the checkout's
      // copy; fine for dependency trees, regenerated output and caches. Revisit
      // with reflinks or an overlay if it bites.
      try {
        if (isDir) await run('cp', ['-al', from, to])
        else linkSync(from, to)
      } catch {
        rmSync(to, { recursive: true, force: true })
        if (isDir) await run('cp', ['-a', from, to])
        else copyFileSync(from, to)
      }
      linked++
    }
    options.onProgress?.(`worktree: linked ${linked} ignored path(s) in ${Date.now() - started}ms`)
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    options.onProgress?.(`worktree: ignored environment only partly replicated (${linked} path(s)): ${why}`)
  }
}

/**
 * Run `fn` in a throwaway copy of `commit` (a snapshot of the checkout at
 * `cwd`), with the checkout's ignored environment replicated into it, and
 * delete it afterwards however `fn` ends. `fn` gets the copy's counterpart of
 * `cwd`. What runs there — a reviewer told its changes are discarded — never
 * touches the user's repository:
 *
 * - its own repository, not a linked worktree, so its refs, stash and config
 *   are its own (a worktree shares them: a `git stash pop` there pops the
 *   user's stash), and with no remote, so a push or fetch cannot reach back;
 * - objects borrowed through alternates, which is how the unreferenced
 *   snapshot commit is reachable from it. Built by hand, not `git clone
 *   --shared`: a clone of a SHALLOW repository ignores `--shared` and copies
 *   only referenced objects, losing the snapshot. The source's `shallow` file
 *   comes along, so history stops at the same boundary instead of failing;
 * - the checkout's WHOLE ignored environment (`linkIgnored`'s `whole`), build
 *   output included, so the reviewer can run the tests as the checkout does;
 *   ignored loose files copied, not hard-linked;
 * - checked out without hooks: a `post-checkout` hook is the user's, for their
 *   own checkouts, not for this bookkeeping one;
 * - in temp, outside the checkout, removed with one `rm -rf`.
 */
export async function withSnapshotClone<T>(
  cwd: string,
  commit: string,
  fn: (cwd: string) => Promise<T>,
  onProgress?: (line: string) => void,
): Promise<T> {
  const git = async (dir: string, ...args: string[]) => (await run('git', args, { cwd: dir })).stdout.trim()
  const root = await git(cwd, 'rev-parse', '--show-toplevel')
  const prefix = await git(cwd, 'rev-parse', '--show-prefix')
  // The common directory's, also from a linked worktree; resolved against root,
  // since git prints it relative to where it ran.
  const objects = resolve(root, await git(root, 'rev-parse', '--git-path', 'objects'))
  const shallow = resolve(root, await git(root, 'rev-parse', '--git-path', 'shallow'))
  const dir = mkdtempSync(join(tmpdir(), 'openswarm-review-'))
  const path = join(dir, 'tree')
  try {
    await git(dir, 'init', '-q', path)
    writeFileSync(join(path, '.git', 'objects', 'info', 'alternates'), `${objects}\n`)
    if (existsSync(shallow)) copyFileSync(shallow, join(path, '.git', 'shallow'))
    await git(path, '-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '--detach', commit)
    await linkIgnored(root, path, { ...(onProgress === undefined ? {} : { onProgress }), whole: true })
    return await fn(join(path, prefix))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
