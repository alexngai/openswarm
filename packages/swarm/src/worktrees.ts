/**
 * Worktree execution context (docs/01 Phase 2): member runs execute as full
 * peer harnesses in subprocesses, each rooted in its own per-task git
 * worktree via a dynamically mounted `subagent-dsh-sdk` provider instance
 * (Cordis reversible mounting — one instance per run, disposed after).
 *
 * Runs with a `taskKey` share that task's worktree (cascade tiers continue
 * each other's work; a critic reads the worker's tree). Runs without a key
 * (judge, plan, synthesis) execute at the repo root. On finalize, dirty task
 * worktrees are auto-committed (configurable) and the merge queue, or the
 * train when configured (docs/05 B2), folds task branches into the target
 * branch — never the user's checkout.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as SdkProvider from '@deepseek-ai/dsh-subagent-dsh-sdk'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { SwarmGit, withSnapshotClone, type MergeOutcome } from 'openswarm-git'
import { landTrain, type TrainConfig, type TrainDeps } from './train'
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
  /**
   * Member sandbox for this run (docs/05 §5.5); `OPENSWARM_MEMBER_SANDBOX` is
   * the default, and unset means `danger-full-access`. A custom `configPath`
   * composition must read `OPENSWARM_MEMBER_SANDBOX` itself.
   */
  sandbox?: 'workspace-write'
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
   * Hard-link the main checkout's git-ignored environment (`node_modules`,
   * native extensions) into each new worktree so members can build and test
   * there (default true).
   */
  linkIgnored?: boolean
  /**
   * Most member harnesses running at once (default 8). Each is a full
   * subprocess with its own model session, so an uncapped 50-task fanout
   * would spawn 50 of them; excess runs queue for a slot.
   */
  maxConcurrent?: number
  member?: WorktreeMemberConfig
  /**
   * Land through the train (docs/05 B2, B3) instead of the sequential queue:
   * speculative batches verified once by `checks` (L2) or a hidden `suite`
   * (L3), a failure bisected to its culprit, which its member repairs, and a
   * conflict handed to a resolver. Unset, finalize merges as before.
   */
  train?: TrainConfig
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

/** The completion gate reviewer's composition: the member's, as the measured reviewer ran (review.cordis.yml). */
export function reviewMemberConfig(): string {
  return fileURLToPath(new URL('../review.cordis.yml', import.meta.url))
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

/**
 * The launcher's own OpenAI-compatible route (Azure or OpenAI), as member env,
 * so a member reaches the model the way this process does unless its config
 * says otherwise. The SDK spawner scrubs `*_KEY` names from the inherited env,
 * so they travel explicitly; without this, starting a worktree run from the
 * web or the CLI would need the caller to send an API key. Members speak only
 * that route, so nothing is inherited for any other provider.
 */
export function inheritedRoute(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env['OPENSWARM_DEFAULT_PROVIDER'] !== 'openai') return {}
  const route: Record<string, string | undefined> = {
    OPENSWARM_LLM_BASE_URL: env['OPENSWARM_LLM_BASE_URL'],
    OPENSWARM_LLM_API_KEY: env['OPENSWARM_LLM_API_KEY'],
    DSH_MODEL: env['OPENSWARM_DEFAULT_MODEL'],
  }
  return Object.fromEntries(Object.entries(route).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

/**
 * One member run as a subprocess harness rooted at `cwd`, through a
 * `subagent-dsh-sdk` provider mounted for this run alone and disposed after.
 * `env` is the child's whole environment (the spawner scrubs the inherited
 * one); `config` supplies the launch and the route a member without
 * agentOptions falls back on.
 */
export async function runMemberProcess(
  ctx: Context,
  member: MemberSpec,
  prompt: string,
  options: {
    cwd: string
    env: Record<string, string>
    parent: Agent
    signal?: AbortSignal
    config?: WorktreeMemberConfig
    /** Unique per mount (default: random). */
    providerName?: string
  },
): Promise<MemberRunResult> {
  const cfg = options.config ?? {}
  const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
  const providerName = options.providerName ?? `swarm-sdk-${randomUUID().slice(0, 8)}`
  const launch = resolveMemberLaunch(cfg)
  const fiber = ctx.plugin(plug(SdkProvider), {
    providerName,
    command: launch.command,
    args: launch.args,
    cwd: options.cwd,
    env: options.env,
    provider: member.agentOptions?.provider ?? cfg.provider ?? 'openai',
    ...((member.agentOptions?.model ?? cfg.model) === undefined
      ? {}
      : { model: member.agentOptions?.model ?? cfg.model }),
    ...((member.agentOptions?.maxTokens ?? cfg.maxTokens) === undefined
      ? {}
      : { maxTokens: member.agentOptions?.maxTokens ?? cfg.maxTokens }),
  })
  let started: SubagentRun | undefined
  try {
    await fiber.await()
    started = await ctx.subagents.start(providerName, {
      label: member.name,
      prompt: [{ type: 'text', text }],
      parent: options.parent,
      signal: options.signal ?? new AbortController().signal,
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
    // Disposing the PROVIDER does not reap the run: `SubagentRun.dispose()` is
    // what cancels remaining work, reaches child quiescence, and releases
    // resources. Awaiting `result` and skipping it leaked the member's harness
    // subprocess on every worktree run — one orphaned node process per member,
    // surviving well past the provider's SIGTERM/SIGKILL grace. The suite never
    // caught it because vitest force-exits its workers.
    await started?.dispose().catch(() => undefined)
    await fiber.dispose()
  }
}

/**
 * The environment a member starts with, passed explicitly because the
 * one-shot spawner scrubs the inherited one. `cfg.env` wins. `runId` names the
 * run's session and cache directories.
 */
export function memberEnvOf(cfg: WorktreeMemberConfig, runId: string): Record<string, string> {
  const sandbox =
    cfg.sandbox ?? cfg.env?.['OPENSWARM_MEMBER_SANDBOX'] ?? process.env['OPENSWARM_MEMBER_SANDBOX']
  // Under workspace-write a member writes only its worktree and temp, so
  // package caches move out of the home directory into a per-run temp dir.
  // By design, global installs (`pip install` into site-packages) and git
  // writes (the object store and `.git/worktrees/<name>` live outside the
  // worktree) still fail; the lead auto-commits.
  // ponytail: per run, so each run re-downloads and the OS reaps temp; share
  // one across runs if downloads cost.
  const caches = join(tmpdir(), 'openswarm-cache', runId)
  return {
    ...inheritedRoute(),
    // Session logs must not land inside the worktree, or auto-commit
    // sweeps them into the task branch.
    DSH_SESSION_ROOT: join(tmpdir(), 'openswarm-sessions', runId),
    ...(sandbox === undefined ? {} : { OPENSWARM_MEMBER_SANDBOX: sandbox }),
    ...(sandbox === 'workspace-write'
      ? {
          npm_config_cache: join(caches, 'npm'),
          PIP_CACHE_DIR: join(caches, 'pip'),
          CARGO_HOME: join(caches, 'cargo'),
          XDG_CACHE_HOME: join(caches, 'xdg'),
        }
      : {}),
    ...cfg.env,
  }
}

export class WorktreeRun {
  readonly teamId = randomUUID().slice(0, 8)
  private readonly git: SwarmGit
  private readonly slots: Slots
  private seq = 0
  /**
   * Per task key, the member that first ran in its worktree and its prompt:
   * the writer, whom the train asks to repair it. A critic, a later pipeline
   * stage or cascade tier runs in the same worktree after it.
   */
  private readonly owners = new Map<string, { member: MemberSpec; prompt: string }>()

  constructor(
    private readonly ctx: Context,
    private readonly options: WorktreeTeamOptions,
    onProgress?: (line: string) => void,
  ) {
    this.slots = new Slots(options.maxConcurrent ?? 8)
    this.git = new SwarmGit({
      repoRoot: options.repoRoot,
      teamId: this.teamId,
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      ...(options.targetBranch === undefined ? {} : { targetBranch: options.targetBranch }),
      ...(options.worktreeDir === undefined ? {} : { worktreeDir: options.worktreeDir }),
      ...(options.linkIgnored === undefined ? {} : { linkIgnored: options.linkIgnored }),
      ...(onProgress === undefined ? {} : { onProgress }),
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
    if (taskKey !== undefined && !this.owners.has(taskKey)) this.owners.set(taskKey, { member, prompt })
    return runMemberProcess(this.ctx, member, prompt, {
      cwd,
      env: this.memberEnv(),
      parent: run.parent,
      ...(run.signal === undefined ? {} : { signal: run.signal }),
      ...(this.options.member === undefined ? {} : { config: this.options.member }),
      providerName: `swarm-sdk-${this.teamId}-${this.seq++}`,
    })
  }

  /**
   * The environment every member of this run starts with, passed explicitly
   * because the one-shot spawner scrubs the inherited one. `member.env` wins.
   */
  memberEnv(): Record<string, string> {
    return memberEnvOf(this.options.member ?? {}, this.teamId)
  }

  /** Create (or return) the worktree for one task or member key. */
  worktree(key: string) {
    return this.git.worktree(key)
  }

  /**
   * The completion gate's reviewer for the tree at `key` (docs/05 B6b), as
   * the single path runs it: a subprocess member in a disposable clone of
   * `commit`, never the worktree itself, so whatever it changes goes away with
   * the clone, as its prompt promises; with the measured reviewer's
   * composition (review.cordis.yml), under `sandbox`, in a harness slot.
   */
  async review(
    key: string,
    member: MemberSpec,
    prompt: string,
    commit: string,
    sandbox: string,
    run: RunTeamOptions,
  ): Promise<MemberRunResult> {
    const cwd = (await this.worktree(key)).path
    const { sandbox: _memberSandbox, ...cfg } = this.options.member ?? {}
    await this.slots.acquire()
    try {
      return await withSnapshotClone(cwd, commit, (clone) =>
        runMemberProcess(this.ctx, member, prompt, {
          cwd: clone,
          env: memberEnvOf({ ...cfg, env: { ...cfg.env, OPENSWARM_MEMBER_SANDBOX: sandbox } }, this.teamId),
          parent: run.parent,
          ...(run.signal === undefined ? {} : { signal: run.signal }),
          config: { ...cfg, configPath: reviewMemberConfig() },
          providerName: `swarm-sdk-${this.teamId}-${this.seq++}`,
        }),
      )
    } finally {
      this.slots.release()
    }
  }

  /** Put the worktree at `key` back to a gate snapshot commit (docs/05 B6b): a tree the gate owns. */
  async rollback(key: string, commit: string): Promise<void> {
    await this.git.resetTo(await this.git.worktree(key), commit)
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
   *
   * With `train` (and `WorktreeTeamOptions.train`), the branches land through
   * the train instead of the queue; its repairs and resolvers run as members
   * of this run, in the entries' own worktrees.
   */
  async finalize(
    options: { merge?: boolean; train?: Omit<TrainDeps, 'owners' | 'run'> & { options: RunTeamOptions } } = {},
  ): Promise<MergeOutcome> {
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
    if (options.train !== undefined && this.options.train !== undefined) {
      const { options: run, ...deps } = options.train
      try {
        return await landTrain(this.git, this.options.train, {
          ...deps,
          owners: this.owners,
          run: (member, prompt, key) => this.runMember(member, prompt, key, run),
        })
      } finally {
        await this.git.dispose()
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
