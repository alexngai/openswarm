/**
 * Worktree execution context (docs/01 Phase 2): member runs execute as full
 * peer harnesses in subprocesses, each rooted in its own per-task git
 * worktree via a dynamically mounted `subagent-dsh-sdk` provider instance
 * (Cordis reversible mounting — one instance per run, disposed after).
 *
 * Runs with a `taskKey` share that task's worktree (cascade tiers continue
 * each other's work; a critic reads the worker's tree). Runs without a key
 * (judge, plan, synthesis) execute at the repo root. On finalize, dirty task
 * worktrees are auto-committed (configurable) and the merge queue folds task
 * branches into the target branch — never the user's checkout.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import * as SdkProvider from '@deepseek-ai/dsh-subagent-dsh-sdk'
import { SwarmGit, type MergeOutcome } from 'openswarm-git'
import type { MemberRunResult, MemberSpec } from './types'
import type { RunTeamOptions } from './index'

const require = createRequire(import.meta.url)

export interface WorktreeMemberConfig {
  /** Child runtime executable (default: this Node running the dsh-jsonrpc-agent bin). */
  command?: string
  /** Arguments (default: the resolved runtime bin + config path). */
  args?: string[]
  /** Member composition (default: this package's member.cordis.yml). */
  configPath?: string
  /** Extra child environment (model endpoint, credentials, DSH_MODEL, …). */
  env?: Record<string, string>
  /** Default provider route for members without agentOptions. */
  provider?: string
  model?: string
  maxTokens?: number
}

export interface WorktreeTeamOptions {
  repoRoot: string
  /** Base ref task worktrees start from (default HEAD). */
  baseRef?: string
  /** Merge target (default: fresh `swarm/<teamId>/integration` from the base ref). */
  targetBranch?: string
  worktreeDir?: string
  /** Commit dirty task worktrees before merging (default true). */
  autoCommit?: boolean
  /**
   * Most member harnesses running at once (default 8). Each is a full
   * subprocess with its own model session, so an uncapped 50-task fanout
   * would spawn 50 of them; excess runs queue for a slot.
   */
  maxConcurrent?: number
  member?: WorktreeMemberConfig
}

/**
 * Minimal FIFO slot semaphore. `release` hands its slot straight to the next
 * waiter rather than decrementing, so the active count never dips below the
 * cap while work is queued.
 */
export class Slots {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.active--
    else next()
  }
}

/** Resolve the default child runtime bin (`dsh-jsonrpc-agent`). */
function defaultRuntimeBin(): string {
  const pkgPath = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json')
  const pkg = require('@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json')
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['dsh-jsonrpc-agent']
  return join(dirname(pkgPath), bin)
}

function defaultMemberConfig(): string {
  return fileURLToPath(new URL('../member.cordis.yml', import.meta.url))
}

const plug = (m: unknown): any => (m as any).default ?? m

/** Resolve the child runtime launch spec for one member config. */
export function resolveMemberLaunch(cfg: WorktreeMemberConfig = {}): {
  command: string
  args: string[]
} {
  return {
    command: cfg.command ?? process.execPath,
    args: cfg.args ?? [defaultRuntimeBin(), cfg.configPath ?? defaultMemberConfig()],
  }
}

export class WorktreeRun {
  readonly teamId = randomUUID().slice(0, 8)
  private readonly git: SwarmGit
  private readonly slots: Slots
  private seq = 0

  constructor(
    private readonly ctx: Context,
    private readonly options: WorktreeTeamOptions,
  ) {
    this.slots = new Slots(options.maxConcurrent ?? 8)
    this.git = new SwarmGit({
      repoRoot: options.repoRoot,
      teamId: this.teamId,
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      ...(options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch }),
      ...(options.worktreeDir === undefined ? {} : { worktreeDir: options.worktreeDir }),
    })
  }

  /** Run one member in the task's worktree (or the repo root without a key). */
  async runMember(
    member: MemberSpec,
    prompt: string,
    taskKey: string | undefined,
    run: RunTeamOptions,
  ): Promise<MemberRunResult> {
    // Wait for a harness slot before touching git or spawning anything, so a
    // large fanout queues instead of creating N worktrees and N subprocesses
    // up front.
    await this.slots.acquire()
    try {
      return await this.runMemberInSlot(member, prompt, taskKey, run)
    } finally {
      this.slots.release()
    }
  }

  private async runMemberInSlot(
    member: MemberSpec,
    prompt: string,
    taskKey: string | undefined,
    run: RunTeamOptions,
  ): Promise<MemberRunResult> {
    // Keyless runs (judge/synthesis) get a throwaway detached worktree, never
    // the user's checkout — the member harness carries write tools, so running
    // in repoRoot would let a model mutate the working tree.
    const cwd = taskKey === undefined ? await this.git.scratch() : (await this.worktree(taskKey)).path
    const cfg = this.options.member ?? {}
    const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
    const providerName = `swarm-sdk-${this.teamId}-${this.seq++}`
    const launch = resolveMemberLaunch(cfg)
    const fiber = this.ctx.plugin(plug(SdkProvider), {
      providerName,
      command: launch.command,
      args: launch.args,
      cwd,
      // Session logs must not land inside the worktree, or auto-commit
      // sweeps them into the task branch.
      env: {
        DSH_SESSION_ROOT: join(tmpdir(), 'openswarm-sessions', this.teamId),
        ...cfg.env,
      },
      provider: member.agentOptions?.provider ?? cfg.provider ?? 'openai',
      ...((member.agentOptions?.model ?? cfg.model) === undefined
        ? {}
        : { model: member.agentOptions?.model ?? cfg.model }),
      ...((member.agentOptions?.maxTokens ?? cfg.maxTokens) === undefined
        ? {}
        : { maxTokens: member.agentOptions?.maxTokens ?? cfg.maxTokens }),
    })
    try {
      await fiber.await()
      const started = await this.ctx.subagents.start(providerName, {
        label: member.name,
        prompt: [{ type: 'text', text }],
        parent: run.parent,
        signal: run.signal ?? new AbortController().signal,
      })
      const result = await started.result
      return {
        member: member.name,
        runId: started.id,
        output: result.output,
        text: result.output
          .filter((b): b is Extract<(typeof result.output)[number], { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join(''),
        stopReason: result.stopReason,
      }
    } finally {
      await fiber.dispose()
    }
  }

  /** Create (or return) the worktree for one task or member key. */
  worktree(key: string) {
    return this.git.worktree(key)
  }

  /**
   * Restore a task worktree's pinned pathspecs from the base commit, so a gate
   * grading that worktree does not read verification assets the member could
   * have edited. Returns the paths that had been modified.
   */
  async pinForGate(key: string, pathspecs: string[]): Promise<string[]> {
    return this.git.restoreFromBase(await this.git.worktree(key), pathspecs)
  }

  /**
   * Clear worktrees left by teams that died before finalizing. Called once per
   * run before any member starts, so a crashed predecessor does not accumulate
   * checkouts in the user's repo.
   */
  sweepOrphans(): Promise<string[]> {
    return SwarmGit.sweepOrphans(this.options.repoRoot, this.options.worktreeDir)
  }

  /**
   * Abort path: drop every worktree without merging. Task branches survive, so
   * committed member work is still recoverable by branch name.
   */
  abort(): Promise<void> {
    return this.git.removeAll()
  }

  /**
   * Auto-commit dirty task worktrees, then either run the merge queue or
   * withhold the work.
   *
   * `merge: false` commits as usual — so nothing is lost and every branch stays
   * reachable by name — but does not fold anything into the integration branch.
   * That is what makes a gate verdict mean something: a cascade that never
   * satisfied its gate previously merged anyway, since finalize ran
   * unconditionally after dispatch and never consulted `accepted`.
   */
  async finalize(options: { merge?: boolean } = {}): Promise<MergeOutcome> {
    if (this.options.autoCommit !== false) {
      for (const taskKey of this.taskKeys()) {
        const wt = await this.git.worktree(taskKey)
        await this.git.autoCommit(wt, `swarm: ${taskKey} (team ${this.teamId})`)
      }
    }
    if (options.merge === false) {
      const withheld: MergeOutcome['withheld'] = []
      for (const taskKey of this.taskKeys()) {
        const wt = await this.git.worktree(taskKey)
        if ((await this.git.commitCount(wt.branch)) > 0) {
          withheld.push({ taskKey, branch: wt.branch })
        }
      }
      await this.git.removeAll()
      await this.git.dispose()
      return {
        targetBranch: this.git.targetBranch,
        merged: [],
        conflicts: [],
        empty: [],
        withheld,
      }
    }
    const outcome = await this.git.mergeAll()
    await this.git.dispose()
    return outcome
  }

  private taskKeys(): string[] {
    // SwarmGit memoizes worktrees; expose the created task keys through it.
    return [...(this.git as any).worktrees.keys()]
  }
}
