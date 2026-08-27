/**
 * `ctx.swarm` — the OpenSwarm swarm kernel over the dsh subagent seam.
 *
 * Topologies run members as one-shot subagent runs (plus continuable peers
 * in messaging peer-teams). By default members share the parent's cwd and
 * inherit its model route unless `agentOptions` overrides; with
 * `RunTeamOptions.worktrees` they run as subprocess harnesses in per-task
 * git worktrees whose branches merge on finish (docs/01 Phase 2).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SwarmBoard } from './board'
import { SwarmMailbox } from './mailbox'
import { askPeer, registerSwarmMessaging, spawnPeer, suppressSettlementTurns } from './peers'
import type { PeerHandle } from './types'
import {
  runBoardWorkers,
  runCascade,
  runCommittee,
  runCoordinator,
  runCriticLoop,
  runFanout,
  runPeerTeam,
  runPipeline,
  seedBoard,
  type RunMember,
} from './topologies'
import { tmpdir } from 'node:os'
import { RemotePeer } from './remote-peer'
import { SwarmServer } from './server'
import { WorktreeRun, resolveMemberLaunch, type WorktreeTeamOptions } from './worktrees'
import type { MergeOutcome } from 'openswarm-git'
import type {
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
export { RemotePeer } from './remote-peer'
export { SwarmServer } from './server'
export { WorktreeRun } from './worktrees'
export type { WorktreeTeamOptions, WorktreeMemberConfig } from './worktrees'

export interface SwarmConfig {
  /** Subagent provider used when a member does not name one (default 'spawn'). */
  defaultSubagentProvider?: string
}

export interface RunTeamOptions {
  /** The delegating agent; members spawn as its subagent children. */
  parent: Agent
  signal?: AbortSignal
  /**
   * Runs cascade command-confidence gates (weakest link over exit codes).
   * Default: bash in `confidenceCwd` (or the process cwd).
   */
  confidenceRunner?: (commands: string[]) => Promise<number>
  /** Working directory for the default confidence runner. */
  confidenceCwd?: string
  /**
   * Execute member runs as subprocess harnesses in git worktrees, merging
   * completed branches on finish (docs/01 Phase 2). One-shot topologies use
   * per-task worktrees; `peer-team { messaging: true }` runs long-lived
   * multi-turn remote members in per-MEMBER worktrees (docs/01 Phase 4).
   */
  worktrees?: WorktreeTeamOptions
}

const execFileAsync = promisify(execFile)

/** Weakest-link default: every command must exit 0 in `cwd` for confidence 1. */
function defaultConfidenceRunner(cwd: string): (commands: string[]) => Promise<number> {
  return async (commands) => {
    for (const command of commands) {
      try {
        await execFileAsync('bash', ['-c', command], { cwd, maxBuffer: 16 * 1024 * 1024 })
      } catch {
        return 0
      }
    }
    return 1
  }
}

/** The wire requires an explicit model for remote members; resolve or fail loud. */
function resolveMemberModel(
  member: MemberSpec,
  cfg: import('./worktrees').WorktreeMemberConfig,
): string {
  const model = member.agentOptions?.model ?? cfg.model ?? cfg.env?.['DSH_MODEL']
  if (model === undefined) {
    throw new Error(
      `remote member "${member.name}" has no model: set member.agentOptions.model, worktrees.member.model, or DSH_MODEL in worktrees.member.env`,
    )
  }
  return model
}

/** Concatenated text content of an assistant output. */
function textOf(output: ContentBlock[]): string {
  return output
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export default class SwarmService extends Service {
  // 'sessions' is a real dependency: the board and mailbox flush durable
  // events through ctx.sessions. Undeclared it resolves only when accessed
  // from an unrestricted root context — service-to-service callers hit
  // cordis's inject guard.
  static inject = ['subagents', 'sessions']

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

  async runTeam(
    spec: TeamSpec,
    options: RunTeamOptions,
  ): Promise<TeamResult & { git?: MergeOutcome }> {
    const worktrees =
      options.worktrees === undefined ? undefined : new WorktreeRun(this.ctx, options.worktrees)
    const run: RunMember = (member, prompt, taskKey) =>
      worktrees === undefined
        ? this.runMember(member, prompt, options)
        : worktrees.runMember(member, prompt, taskKey, options)
    const result = await this.dispatch(spec, run, options, worktrees)
    if (worktrees === undefined) return result
    return { ...result, git: await worktrees.finalize() }
  }

  private dispatch(
    spec: TeamSpec,
    run: RunMember,
    options: RunTeamOptions,
    worktrees?: WorktreeRun,
  ): Promise<TeamResult> {
    switch (spec.topology) {
      case 'fanout':
        return runFanout(spec, run)
      case 'critic-loop':
        return runCriticLoop(spec, run)
      case 'committee':
        return runCommittee(spec, run)
      case 'pipeline':
        return runPipeline(spec, run)
      case 'cascade':
        return runCascade(
          spec,
          run,
          options.confidenceRunner ?? defaultConfidenceRunner(options.confidenceCwd ?? process.cwd()),
        )
      case 'coordinator':
        return runCoordinator(spec, run)
      case 'peer-team':
        return spec.messaging === true
          ? worktrees === undefined
            ? this.runPeerTeamMessaging(spec, options)
            : this.runRemotePeerTeam(spec, options, worktrees)
          : runPeerTeam(spec, run, this.board(options.parent))
    }
  }

  /**
   * Remote messaging peer-team (docs/01 Phase 4): each member is a
   * long-lived subprocess harness in its OWN member-keyed worktree, keeping
   * one session across briefing, tasks, and peer messages. The lead exposes
   * the swarm socket; members' `swarm_send_message` reaches the durable
   * mailbox through it, authenticated by per-member spawn tokens.
   */
  private async runRemotePeerTeam(
    spec: import('./types').PeerTeamSpec,
    options: RunTeamOptions,
    worktrees: WorktreeRun,
  ): Promise<import('./types').PeerTeamResult> {
    if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
    const lead = options.parent
    const board = this.board(lead)
    const created = await seedBoard(board, spec.tasks)
    const seeded = new Set(created)

    const roster = new Map<string, PeerHandle>()
    const mailbox = this.mailbox(lead, roster)
    const server = new SwarmServer(mailbox)
    await server.listen()
    const cfg = options.worktrees?.member ?? {}
    const launch = resolveMemberLaunch(cfg)
    const peers: RemotePeer[] = []
    try {
      for (const member of spec.members) {
        const names = spec.members.filter((m) => m.name !== member.name).map((m) => m.name)
        const worktree = await worktrees.worktree(member.name)
        const peer = await RemotePeer.spawn({
          name: member.name,
          command: launch.command,
          args: launch.args,
          cwd: worktree.path,
          env: {
            DSH_SESSION_ROOT: `${tmpdir()}/openswarm-sessions/${worktrees.teamId}`,
            ...cfg.env,
            OPENSWARM_SWARM_URL: server.url,
            OPENSWARM_SWARM_TOKEN: server.addMember(member.name),
          },
          provider: member.agentOptions?.provider ?? cfg.provider ?? 'openai',
          model: resolveMemberModel(member, cfg),
          briefing: `${member.persona === undefined ? '' : `${member.persona}\n\n`}You are ${member.name}, a member of a swarm team working in your own git worktree. Your teammates: ${names.join(', ') || '(none)'}. Coordinate with them via the swarm_send_message tool. Acknowledge this briefing and wait for tasks.`,
        })
        peers.push(peer)
        roster.set(member.name, { name: member.name, remote: peer })
      }

      const runs = await runBoardWorkers(spec.members, board, seeded, async (member, claimed) => {
        const handle = roster.get(member.name)!
        const prelude = mailbox.framePendingQuiet(member.name)
        const result = await handle.remote!.ask([...prelude.blocks, { type: 'text', text: claimed.prompt }])
        await prelude.ack()
        return result
      })
      const tasks = board.list().filter((t) => seeded.has(t.id))
      return { topology: 'peer-team', tasks, runs }
    } finally {
      for (const peer of peers) await peer.close().catch(() => undefined)
      await server.close()
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

    let runs: Record<string, MemberRunResult>
    try {
      runs = await runBoardWorkers(spec.members, board, seeded, (member, claimed) =>
        askPeer(this.ctx, lead, roster.get(member.name)!, claimed.prompt, {
          mailbox,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
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

}

declare module '@deepseek-ai/cordis' {
  interface Context {
    swarm: SwarmService
  }
}
