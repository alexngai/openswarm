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
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface SwarmGitOptions {
  repoRoot: string
  teamId: string
  /** Base ref task worktrees start from (default HEAD's current commit). */
  baseRef?: string
  /** Merge target branch (default: fresh integration branch `swarm/<teamId>/integration`). */
  targetBranch?: string
  /** Directory holding this team's worktrees (default `<repoRoot>/.swarm/worktrees/<teamId>`). */
  worktreeDir?: string
}

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
    const info: WorktreeInfo = { taskKey, path, branch }
    this.worktrees.set(taskKey, info)
    return info
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
      if (listed.trim() !== '') known.push(spec)
    }
    if (known.length > 0) {
      await this.git(worktree.path, 'checkout', base, '--', ...known)
    }
    await this.git(worktree.path, 'clean', '-fdq', '--', ...pathspecs)
    return touched
  }

  /** Commit everything dirty in one worktree; false when it was clean. */
  async autoCommit(worktree: WorktreeInfo, message: string): Promise<boolean> {
    await this.git(worktree.path, 'add', '-A')
    try {
      await this.git(worktree.path, 'diff', '--cached', '--quiet')
      return false // clean
    } catch {
      await this.git(
        worktree.path,
        '-c', 'user.email=swarm@openswarm', '-c', 'user.name=openswarm',
        'commit', '-q', '-m', message,
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
          'merge', '--no-ff', '-q', '-m', `swarm: merge ${info.branch}`, info.branch,
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
