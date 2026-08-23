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
import { SwarmBoard } from './board'
import { SwarmMailbox } from './mailbox'
import { askPeer, registerSwarmMessaging, spawnPeer, suppressSettlementTurns } from './peers'
import type { PeerHandle } from './types'
import {
  isApproved,
  runCascade,
  runCommittee,
  runCoordinator,
  runPeerTeam,
  runPipeline,
  seedBoard,
  type RunMember,
} from './topologies'
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
export * from './board'
export * from './mailbox'
export {
  askPeer,
  nextTurnEnd,
  registerSwarmMessaging,
  spawnPeer,
  suppressSettlementTurns,
} from './peers'
export { parseNumberedPlan } from './topologies'

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

export default class SwarmService extends Service {
  static inject = ['subagents']

  private swarmConfig: SwarmConfig

  constructor(ctx: Context, config: SwarmConfig = {}) {
    super(ctx, 'swarm')
    this.swarmConfig = config
  }

  private boards = new WeakMap<Agent, SwarmBoard>()

  /** The shared task board bound to one lead agent's session log. */
  board(lead: Agent): SwarmBoard {
    let board = this.boards.get(lead)
    if (board === undefined) {
      board = new SwarmBoard(this.ctx, lead)
      this.boards.set(lead, board)
    }
    return board
  }

  async runTeam(spec: TeamSpec, options: RunTeamOptions): Promise<TeamResult> {
    const run: RunMember = (member, prompt) => this.runMember(member, prompt, options)
    switch (spec.topology) {
      case 'fanout':
        return this.runFanout(spec, options)
      case 'critic-loop':
        return this.runCriticLoop(spec, options)
      case 'committee':
        return runCommittee(spec, run)
      case 'pipeline':
        return runPipeline(spec, run)
      case 'cascade':
        return runCascade(spec, run)
      case 'coordinator':
        return runCoordinator(spec, run)
      case 'peer-team':
        return spec.messaging === true
          ? this.runPeerTeamMessaging(spec, options)
          : runPeerTeam(spec, run, this.board(options.parent))
    }
  }

  /**
   * Messaging peer-team: continuable peers with the durable mailbox and the
   * `swarm_send_message` tool; board tasks are delivered as addressed turns.
   */
  private async runPeerTeamMessaging(
    spec: import('./types').PeerTeamSpec,
    options: RunTeamOptions,
  ): Promise<import('./types').PeerTeamResult> {
    if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
    const lead = options.parent
    const board = this.board(lead)
    const created = await seedBoard(board, spec.tasks)
    const seeded = new Set(created)

    const roster = new Map<string, PeerHandle>()
    const mailbox = this.mailbox(lead, roster)
    const provider = this.swarmConfig.defaultSubagentProvider ?? 'spawn'
    const disposers: (() => void)[] = [
      suppressSettlementTurns(lead),
      registerSwarmMessaging(this.ctx, roster, mailbox),
    ]
    for (const member of spec.members) {
      const names = spec.members.filter((m) => m.name !== member.name).map((m) => m.name)
      const handle = await spawnPeer(this.ctx, member, {
        parent: lead,
        provider: member.subagentProvider ?? provider,
        briefing: `You are ${member.name}, a member of a swarm team. Your teammates: ${names.join(', ') || '(none)'}. Coordinate with them via the swarm_send_message tool. Acknowledge this briefing and wait for tasks.`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      roster.set(member.name, handle)
    }

    const runs: Record<string, MemberRunResult> = {}
    const boardDone = () => board.list().every((t) => !seeded.has(t.id) || t.status === 'completed')
    try {
      await Promise.all(
        spec.members.map(async (member) => {
          const handle = roster.get(member.name)!
          while (!boardDone()) {
            const claimed = await board.claimNextReady(member.name)
            if (claimed === undefined) {
              await new Promise((r) => setTimeout(r, 10))
              continue
            }
            const result = await askPeer(this.ctx, lead, handle, claimed.prompt, {
              mailbox,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            })
            runs[claimed.id] = result
            await board.complete(claimed.id, member.name, claimed.revision, result.text)
          }
        }),
      )
    } finally {
      for (const dispose of disposers) dispose()
    }
    const tasks = board.list().filter((t) => seeded.has(t.id))
    return { topology: 'peer-team', tasks, runs }
  }

  /** A durable mailbox over one lead's session log and a live roster. */
  mailbox(lead: Agent, roster: Map<string, PeerHandle>): SwarmMailbox {
    return new SwarmMailbox(this.ctx, lead, roster)
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
