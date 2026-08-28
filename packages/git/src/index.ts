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
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
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

export class SwarmGit {
  private readonly worktrees = new Map<string, WorktreeInfo>()
  /** One in-flight creation promise per task key — the concurrency memo. */
  private readonly worktreePromises = new Map<string, Promise<WorktreeInfo>>()
  /** Safe branch names already assigned, to disambiguate lossy collisions. */
  private readonly usedNames = new Set<string>()
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
    mkdirSync(this.dir, { recursive: true })
    await this.git(this.options.repoRoot, 'worktree', 'add', '-b', branch, path, await this.baseCommit())
    const info: WorktreeInfo = { taskKey, path, branch }
    this.worktrees.set(taskKey, info)
    return info
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
    mkdirSync(this.dir, { recursive: true })
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
        mkdirSync(this.dir, { recursive: true })
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
