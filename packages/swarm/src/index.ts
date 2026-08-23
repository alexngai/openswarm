/**
 * `ctx.swarm` — the OpenSwarm swarm kernel over the dsh subagent seam.
 *
 * Phase-1 scope (docs/01): fanout and critic-loop topologies, members as
 * one-shot subagent runs. Members share the parent's cwd (worktrees are
 * Phase 2) and inherit its model route unless `agentOptions` overrides.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  CriticLoopResult,
  CriticLoopSpec,
  FanoutResult,
  FanoutSpec,
  MemberRunResult,
  MemberSpec,
  TeamResult,
  TeamSpec,
} from './types'

export * from './types'

export interface SwarmConfig {
  /** Subagent provider used when a member does not name one (default 'spawn'). */
  defaultSubagentProvider?: string
}

export interface RunTeamOptions {
  /** The delegating agent; members spawn as its subagent children. */
  parent: Agent
  signal?: AbortSignal
}

const DEFAULT_MAX_ROUNDS = 3

/** Concatenated text content of an assistant output. */
function textOf(output: ContentBlock[]): string {
  return output
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/** Critic verdict protocol: `APPROVED` approves; anything else is feedback. */
function isApproved(verdict: string): boolean {
  return /^\s*APPROVED\b/i.test(verdict)
}

export default class SwarmService extends Service {
  static inject = ['subagents']

  private swarmConfig: SwarmConfig

  constructor(ctx: Context, config: SwarmConfig = {}) {
    super(ctx, 'swarm')
    this.swarmConfig = config
  }

  async runTeam(spec: TeamSpec, options: RunTeamOptions): Promise<TeamResult> {
    switch (spec.topology) {
      case 'fanout':
        return this.runFanout(spec, options)
      case 'critic-loop':
        return this.runCriticLoop(spec, options)
    }
  }

  /** One member, one prompt, one settled subagent run. */
  private async runMember(
    member: MemberSpec,
    prompt: string,
    options: RunTeamOptions,
  ): Promise<MemberRunResult> {
    const provider =
      member.subagentProvider ?? this.swarmConfig.defaultSubagentProvider ?? 'spawn'
    const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
    const run = await this.ctx.subagents.start(provider, {
      label: member.name,
      prompt: [{ type: 'text', text }],
      parent: options.parent,
      signal: options.signal ?? new AbortController().signal,
      ...(member.agentOptions === undefined ? {} : { agentOptions: member.agentOptions }),
    })
    const result = await run.result
    return {
      member: member.name,
      runId: run.id,
      output: result.output,
      text: textOf(result.output),
      stopReason: result.stopReason,
    }
  }

  private async runFanout(spec: FanoutSpec, options: RunTeamOptions): Promise<FanoutResult> {
    const byName = new Map(spec.members.map((m) => [m.name, m]))
    if (byName.size !== spec.members.length) throw new Error('duplicate member name in team spec')
    const results = await Promise.all(
      spec.tasks.map((task) => {
        const member = byName.get(task.member)
        if (member === undefined) throw new Error(`fanout task names unknown member "${task.member}"`)
        return this.runMember(member, task.prompt, options)
      }),
    )
    return { topology: 'fanout', results }
  }

  private async runCriticLoop(
    spec: CriticLoopSpec,
    options: RunTeamOptions,
  ): Promise<CriticLoopResult> {
    const maxRounds = spec.maxRounds ?? DEFAULT_MAX_ROUNDS
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('maxRounds must be a positive integer')
    const history: CriticLoopResult['history'] = []
    let feedback: string | undefined
    let previous: MemberRunResult | undefined
    for (let round = 1; round <= maxRounds; round++) {
      const workerPrompt =
        previous === undefined || feedback === undefined
          ? spec.task
          : `${spec.task}\n\nYour previous draft:\n${previous.text}\n\nReviewer feedback:\n${feedback}\n\nRevise the draft to address the feedback.`
      const draft = await this.runMember(spec.worker, workerPrompt, options)
      const verdict = await this.runMember(
        spec.critic,
        `Task:\n${spec.task}\n\nDraft under review:\n${draft.text}\n\nReply with exactly APPROVED if the draft fully satisfies the task; otherwise reply REVISE: <specific feedback>.`,
        options,
      )
      history.push({ draft, verdict })
      if (isApproved(verdict.text)) {
        return { topology: 'critic-loop', approved: true, rounds: round, final: draft, history }
      }
      previous = draft
      feedback = verdict.text
    }
    const last = history[history.length - 1]
    if (last === undefined) throw new Error('unreachable: critic loop ran zero rounds')
    return { topology: 'critic-loop', approved: false, rounds: maxRounds, final: last.draft, history }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    swarm: SwarmService
  }
}
