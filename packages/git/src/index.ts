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
import { mkdirSync, rmSync } from 'node:fs'
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

  /** Create (or return the existing) worktree for one task. */
  async worktree(taskKey: string): Promise<WorktreeInfo> {
    const existing = this.worktrees.get(taskKey)
    if (existing !== undefined) return existing
    const safe = taskKey.replace(/[^A-Za-z0-9._-]/g, '-')
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
