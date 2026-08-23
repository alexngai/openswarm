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
  member?: WorktreeMemberConfig
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

export class WorktreeRun {
  readonly teamId = randomUUID().slice(0, 8)
  private readonly git: SwarmGit
  private seq = 0

  constructor(
    private readonly ctx: Context,
    private readonly options: WorktreeTeamOptions,
  ) {
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
    const cwd = taskKey === undefined ? this.options.repoRoot : (await this.git.worktree(taskKey)).path
    const cfg = this.options.member ?? {}
    const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
    const providerName = `swarm-sdk-${this.teamId}-${this.seq++}`
    const fiber = this.ctx.plugin(plug(SdkProvider), {
      providerName,
      command: cfg.command ?? process.execPath,
      args: cfg.args ?? [defaultRuntimeBin(), cfg.configPath ?? defaultMemberConfig()],
      cwd,
      env: cfg.env ?? {},
      provider: member.agentOptions?.provider ?? cfg.provider ?? 'deepseek-official',
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

  /** Auto-commit dirty task worktrees, run the merge queue, release the target. */
  async finalize(): Promise<MergeOutcome> {
    if (this.options.autoCommit !== false) {
      for (const taskKey of this.taskKeys()) {
        const wt = await this.git.worktree(taskKey)
        await this.git.autoCommit(wt, `swarm: ${taskKey} (team ${this.teamId})`)
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
