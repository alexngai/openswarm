/**
 * `ctx.swarm` — the OpenSwarm swarm kernel over the dsh subagent seam.
 *
 * Topologies run members as one-shot subagent runs (plus continuable peers
 * in messaging peer-teams). By default members share the parent's cwd and
 * inherit its model route unless `agentOptions` overrides; with
 * `RunTeamOptions.worktrees` they run as subprocess harnesses in per-task
 * git worktrees whose branches merge on finish (docs/01 Phase 2).
 *
 * A team run is durable (docs/05 A4): `start` mints a run id whose journal,
 * `<runsDir>/<run id>/journal.jsonl`, holds the run record, board and
 * mailbox, so `view`, `attach` and `runs` work from any process that can read
 * it. `runTeam` is `start` plus waiting for the result. Its handle takes
 * direction (`steer`, `cancel`) while the run is live (docs/05 A5), and
 * answers to the questions the harness raises (A6).
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only, for the `ctx.userQuestions` Context augmentation.
import type {} from '@deepseek-ai/dsh-user-questions'
import { SwarmBoard, foldBoard, type SwarmTaskSnapshot } from './board'
import { SwarmJournal } from './journal'
import { SwarmMailbox } from './mailbox'
import {
  foldQuestions,
  foldRun,
  recapJournal,
  type AskQuestion,
  type SwarmQuestion,
  type SwarmQuestionEvent,
  type SwarmQuestionRequest,
  type SwarmRunEvent,
  type SwarmRunRecord,
  type SwarmRunView,
  type SwarmSteerEvent,
} from './run'
import { runGateCommand } from './gate'
import { askPeer, registerSwarmMessaging, spawnPeer, suppressSettlementTurns } from './peers'
import type { Principal } from './protocol'
import type { PeerHandle } from './types'
import {
  CASCADE_TASK_KEY,
  head,
  runBoardWorkers,
  runCascade,
  runCommittee,
  runCoordinator,
  runCriticLoop,
  runFanout,
  runPeerTeam,
  runPipeline,
  seedBoard,
  withIntent,
  type ReportProgress,
  type RunConfidence,
  type RunMember,
} from './topologies'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { RemotePeer } from './remote-peer'
import { SwarmServer } from './server'
import { inheritedRoute, WorktreeRun, resolveMemberLaunch, type WorktreeTeamOptions } from './worktrees'
import type { MergeOutcome } from 'openswarm-git'
import type {
  MemberRunResult,
  MemberSpec,
  TeamResult,
  TeamSpec,
} from './types'

export * from './types'
export * from './board'
export * from './journal'
export * from './mailbox'
export * from './run'
export * from './protocol'
export * from './gate'
export {
  askPeer,
  nextTurnEnd,
  registerSwarmMessaging,
  spawnPeer,
  suppressSettlementTurns,
} from './peers'
export { coordinatorSpec, parseNumberedPlan, renderIntent } from './topologies'
export type { ReportProgress, RunMember } from './topologies'
export { RemotePeer } from './remote-peer'
export { SwarmServer } from './server'
export { WorktreeRun, memberEnvOf, reviewMemberConfig, runMemberProcess } from './worktrees'
export type { WorktreeTeamOptions, WorktreeMemberConfig } from './worktrees'

export interface SwarmConfig {
  /** Subagent provider used when a member does not name one (default 'spawn'). */
  defaultSubagentProvider?: string
  /**
   * Where run journals live, one `<run id>/journal.jsonl` each
   * (default `$OPENSWARM_HOME/runs`, else `~/.openswarm/runs`).
   */
  runsDir?: string
}

/** `$OPENSWARM_HOME`, else `~/.openswarm`. */
export function openswarmHome(): string {
  return process.env['OPENSWARM_HOME'] ?? join(homedir(), '.openswarm')
}

/** Where run journals live unless `SwarmConfig.runsDir` says otherwise. */
export function defaultRunsDir(): string {
  return join(openswarmHome(), 'runs')
}

/** A run's journal file under `runsDir`. The id names a directory, so it may not be a path. */
export function runJournalPath(runsDir: string, runId: string): string {
  if (!/^[\w-]+$/.test(runId)) throw new Error(`invalid run id "${runId}"`)
  return join(runsDir, runId, 'journal.jsonl')
}

/** Every run record under `runsDir`, oldest first. */
export function listRuns(runsDir: string): SwarmRunRecord[] {
  if (!existsSync(runsDir)) return []
  // ponytail: reads whole journals; add an index if listing gets slow.
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => foldRun(SwarmJournal.read(join(runsDir, entry.name, 'journal.jsonl'))) ?? [])
    .sort((a, b) => a.startedAt - b.startedAt)
}

/** A run read from its journal file. Read-only: it never appends or truncates. */
export function viewRun(runsDir: string, runId: string, { since }: { since?: number } = {}): SwarmRunView {
  const events = SwarmJournal.read(runJournalPath(runsDir, runId))
  const run = foldRun(events)
  if (run === undefined) throw new Error(`unknown run "${runId}"`)
  return {
    run,
    tasks: [...foldBoard(events).values()],
    questions: [...foldQuestions(events).values()],
    recap: recapJournal(events, since),
  }
}

/**
 * Whether a run's writer may still be appending. A writer on another host is
 * never judged dead from here.
 */
export function writerLive(run: SwarmRunRecord): boolean {
  // ponytail: same-host pid liveness; the git journal / mesh needs a real lease.
  return run.writer.host !== hostname() || pidAlive(run.writer.pid)
}

/**
 * Take over a run whose writer is dead: become the journal's writer,
 * release the dead writer's claims, and record the run `interrupted` under
 * this process. A run already settled is returned as viewed, untouched.
 * Resuming execution is out of scope; a later direction method does that.
 */
export async function attachRun(
  runsDir: string,
  runId: string,
): Promise<SwarmRunView & { released: SwarmTaskSnapshot[] }> {
  const view = viewRun(runsDir, runId)
  const { run } = view
  if (run.status !== 'running') return { ...view, released: [] }
  if (writerLive(run)) throw new Error(`run ${runId} is live in pid ${run.writer.pid} on ${run.writer.host}; use view`)
  const journal = SwarmJournal.open(runJournalPath(runsDir, runId))
  const released = await new SwarmBoard(journal).releaseOrphans()
  await journal.append('swarm/run', {
    version: 1,
    run: { ...run, status: 'interrupted', writer: writerOf(journal) },
  } satisfies SwarmRunEvent)
  return { ...viewRun(runsDir, runId), released }
}

/** A started team run (docs/05 §5.1). */
export interface RunHandle {
  /** `run-<8 hex>`; names the run's journal directory. */
  readonly id: string
  readonly journal: SwarmJournal
  board(): SwarmBoard
  /**
   * Direct one member of a messaging peer-team (docs/05 §6.1): a worktree
   * (subprocess) member is steered `immediate`, at its next step boundary; an
   * in-process one gets a waking mailbox message, its next turn (`enqueue`).
   * Journaled as `swarm/steer` once delivered. Throws for an unknown member or
   * a run with no addressable members.
   */
  steer(to: string, text: string, by?: string): Promise<SwarmSteerEvent['delivery']>
  /** Abort the run; it records `failed` with the abort error. */
  cancel(): void
  /**
   * Raise a question (docs/05 §6.1), journaled as `swarm/question`, and
   * resolve the first of: an `answer`, an answer from dsh's
   * `ctx.userQuestions` when one is mounted, or its default once
   * `RunTeamOptions.questions.timeoutMs` passes. Past `maxOpen` open questions
   * it is recorded `capped` and takes its default at once; a run that ends
   * closes its open questions with their defaults. The triggers call this.
   */
  ask(question: SwarmQuestionRequest): Promise<string>
  /** Answer an open question with one of its options; throws for anything else. */
  answer(questionId: string, answer: string, by: string): void
  /** Settles after the run's `finished` or `failed` record is written. */
  readonly result: Promise<TeamResult & { git?: MergeOutcome }>
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
   * Pathspecs restored from the base commit before EVERY gate run, under
   * worktree execution.
   *
   * Without this the gate is not independent of what it grades: it runs the
   * repo's own tests out of the member's worktree, so passing by deleting a
   * test is as effective as passing by fixing the code. Pin the verification
   * assets (`['packages/*[/]tests']` here) and the gate stops being something
   * the graded party can edit.
   *
   * Edits to these paths are DISCARDED, not merged — pinning says tests are
   * not this run's to change. A run that is supposed to add tests must leave
   * them unpinned and accept the weaker guarantee.
   */
  confidencePinPaths?: string[]
  /**
   * Execute member runs as subprocess harnesses in git worktrees, merging
   * completed branches on finish (docs/01 Phase 2). One-shot topologies use
   * per-task worktrees; `peer-team { messaging: true }` runs long-lived
   * multi-turn remote members in per-MEMBER worktrees (docs/01 Phase 4).
   */
  worktrees?: WorktreeTeamOptions
  /** Receives human-readable progress lines as the team advances. */
  onProgress?: ReportProgress
  /**
   * Harness-raised questions (docs/05 §6.1): how long one waits for an answer
   * before taking its default (default 0: at once, as an unattended run
   * needs), and how many may be open before the next is capped (default 3).
   */
  questions?: { timeoutMs?: number; maxOpen?: number }
}

/** Weakest-link default: every command must exit 0 in `cwd` for confidence 1. */
function defaultConfidenceRunner(cwd: string): RunConfidence {
  return async (commands) => {
    for (const command of commands) {
      const { ok, output } = await runGateCommand(command, cwd)
      if (!ok) return { score: 0, failedCommand: command, output }
    }
    return { score: 1 }
  }
}

/** The wire requires an explicit model for remote members; resolve or fail loud. */
function resolveMemberModel(
  member: MemberSpec,
  cfg: import('./worktrees').WorktreeMemberConfig,
): string {
  const model = member.agentOptions?.model ?? cfg.model ?? cfg.env?.['DSH_MODEL'] ?? inheritedRoute()['DSH_MODEL']
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

/** This process as the writer of `journal`. */
function writerOf(journal: SwarmJournal): SwarmRunRecord['writer'] {
  return { pid: process.pid, host: hostname(), incarnation: journal.incarnation }
}

/** Whether a pid on this host exists; EPERM means it does, under another user. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export default class SwarmService extends Service {
  static inject = ['subagents']

  /**
   * Protocol credentials, token → principal (docs/05 §5.3), which the socket
   * carrier resolves. ponytail: in memory, so minted tokens do not survive a
   * restart; persist them once a principal must outlive the process.
   */
  readonly tokens = new Map<string, Principal>()
  private swarmConfig: SwarmConfig
  private readonly liveRuns = new Map<string, RunHandle>()

  constructor(ctx: Context, config: SwarmConfig = {}) {
    super(ctx, 'swarm')
    this.swarmConfig = config
  }

  private runsDir(): string {
    return this.swarmConfig.runsDir ?? defaultRunsDir()
  }

  /** A run's journal file. The id names a directory, so it may not be a path. */
  journalPath(runId: string): string {
    return runJournalPath(this.runsDir(), runId)
  }

  /**
   * Start a team run: open its journal, record it `running`, and return once
   * that record is written. The result settles after the `finished` (with the
   * result) or `failed` (with the error message) record is written.
   */
  async start(spec: TeamSpec, options: RunTeamOptions): Promise<RunHandle> {
    let id: string
    do id = `run-${randomUUID().slice(0, 8)}`
    while (existsSync(join(this.runsDir(), id)))
    const journal = SwarmJournal.open(this.journalPath(id))
    const board = new SwarmBoard(journal)
    // The members steering reaches; the messaging peer-team runners fill it.
    const roster = new Map<string, PeerHandle>()
    const mailbox = new SwarmMailbox(this.ctx, options.parent, roster, journal)
    const controller = new AbortController()
    const signal =
      options.signal === undefined ? controller.signal : AbortSignal.any([options.signal, controller.signal])
    const record = (run: SwarmRunRecord) =>
      journal.append('swarm/run', { version: 1, run } satisfies SwarmRunEvent)

    // The run's question queue (docs/05 §6.1). An open question's `close` is
    // called by the first of an answer, userQuestions, the timeout or the run's
    // end; the rest find it gone.
    const { timeoutMs = 0, maxOpen = 3 } = options.questions ?? {}
    const open = new Map<string, { question: SwarmQuestion; close: (answer: string, by?: string) => void }>()
    let asked = 0
    let ended = false
    const recordQuestion = (question: SwarmQuestion) =>
      journal.append('swarm/question', { version: 1, question } satisfies SwarmQuestionEvent)
    const ask: AskQuestion = (request) => {
      const question: SwarmQuestion = {
        id: `q-${asked++}`,
        kind: 'escalation',
        tier: 'low',
        ...request,
        status: 'open',
        raisedAt: Date.now(),
      }
      // The rate cap: the queue may not outrun the person answering it.
      if (open.size >= maxOpen) {
        const capped = { ...question, status: 'capped', answer: question.default, closedAt: Date.now() } as const
        return recordQuestion(capped).then(() => question.default)
      }
      return new Promise<string>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const withdraw = new AbortController()
        // Without `by` nobody answered, and the default was taken.
        const close = (answer: string, by?: string) => {
          if (!open.delete(question.id)) return
          clearTimeout(timer)
          withdraw.abort()
          recordQuestion({
            ...question,
            status: by === undefined ? 'defaulted' : 'answered',
            answer,
            ...(by === undefined ? {} : { by }),
            closedAt: Date.now(),
          }).then(() => resolve(answer), reject)
        }
        open.set(question.id, { question, close })
        recordQuestion(question).catch(reject)
        if (ended || signal.aborted || timeoutMs <= 0) return close(question.default)
        // Clamped: past 2^31-1 ms (about 24.8 days) setTimeout fires at once.
        timer = setTimeout(() => close(question.default), Math.min(timeoutMs, 2 ** 31 - 1))
        // A person at dsh's web surface may answer first. Its provider shows a
        // question in the asking agent's session, so it refuses one without.
        this.ctx
          .get('userQuestions')
          ?.ask({
            agent: options.parent,
            questions: [
              {
                id: question.id,
                header: `swarm ${id}`,
                question: question.prompt,
                detail: `Defaults to ${question.default} in ${Math.round(timeoutMs / 1000)}s.`,
                options: question.options.map((label) => ({ label })),
              },
            ],
            signal: withdraw.signal,
          })
          .then(({ answers }) => {
            const reply = answers.find((a) => a.id === question.id)
            const text = (reply?.custom ?? reply?.selected[0])?.trim().toLowerCase()
            // Anything but one of the options is no answer; the question stays open.
            const choice = question.options.find((option) => option.toLowerCase() === text)
            if (choice !== undefined) close(choice, 'userQuestions')
          }, () => undefined)
      })
    }
    /** A run that ends, settled or cancelled, takes every open question's default. */
    const endQuestions = () => {
      ended = true
      for (const { question, close } of [...open.values()]) close(question.default)
    }
    signal.addEventListener('abort', endQuestions, { once: true })

    const running: SwarmRunRecord = {
      id,
      status: 'running',
      topology: spec.topology,
      parentSessionId: options.parent.session.id,
      writer: writerOf(journal),
      startedAt: Date.now(),
      spec,
    }
    await record(running)
    const result = this.execute(spec, { ...options, signal }, board, roster, mailbox, ask)
      .then((result) => {
        // Aborted members settle as results, not rejections, so a cancelled
        // run can come back whole; it still failed.
        signal.throwIfAborted()
        return result
      })
      // Journaled ahead of the run's own record.
      .finally(endQuestions)
      .then(
        async (result) => {
          await record({ ...running, status: 'finished', endedAt: Date.now(), result })
          return result
        },
        async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          await record({ ...running, status: 'failed', endedAt: Date.now(), error: message })
          throw error
        },
      )
      .finally(() => this.liveRuns.delete(id))
    const handle: RunHandle = {
      id,
      journal,
      board: () => board,
      result,
      cancel: () => controller.abort(new Error(`run ${id} cancelled`)),
      steer: async (to, text, by = 'owner') => {
        const peer = roster.get(to)
        if (peer === undefined) {
          throw new Error(
            roster.size === 0
              ? `run ${id} (${spec.topology}) has no addressable members`
              : `run ${id} has no member "${to}"`,
          )
        }
        const delivery = peer.remote === undefined ? 'enqueue' : 'immediate'
        if (peer.remote === undefined) await mailbox.send({ from: by, to, text })
        else await peer.remote.steer(text)
        await journal.append('swarm/steer', { version: 1, to, text, delivery, by } satisfies SwarmSteerEvent)
        return delivery
      },
      ask,
      answer: (questionId, answer, by) => {
        const entry = open.get(questionId)
        if (entry === undefined) throw new Error(`run ${id} has no open question "${questionId}"`)
        if (!entry.question.options.includes(answer)) {
          throw new Error(`question ${questionId} takes ${entry.question.options.join(' or ')}, not "${answer}"`)
        }
        entry.close(answer, by)
      },
    }
    this.liveRuns.set(id, handle)
    return handle
  }

  /** A run this process started that has not settled yet; with no id, every such run. */
  live(): RunHandle[]
  live(runId: string): RunHandle | undefined
  live(runId?: string): RunHandle[] | RunHandle | undefined {
    return runId === undefined ? [...this.liveRuns.values()] : this.liveRuns.get(runId)
  }

  async runTeam(
    spec: TeamSpec,
    options: RunTeamOptions,
  ): Promise<TeamResult & { git?: MergeOutcome }> {
    return (await this.start(spec, options)).result
  }

  /** {@link viewRun} under this service's runs directory. */
  view(runId: string, options: { since?: number } = {}): SwarmRunView {
    return viewRun(this.runsDir(), runId, options)
  }

  /** {@link attachRun} under this service's runs directory. */
  attach(runId: string): Promise<SwarmRunView & { released: SwarmTaskSnapshot[] }> {
    return attachRun(this.runsDir(), runId)
  }

  /** {@link listRuns} under this service's runs directory. */
  runs(): SwarmRunRecord[] {
    return listRuns(this.runsDir())
  }

  private async execute(
    spec: TeamSpec,
    options: RunTeamOptions,
    board: SwarmBoard,
    roster: Map<string, PeerHandle>,
    mailbox: SwarmMailbox,
    ask: AskQuestion,
  ): Promise<TeamResult & { git?: MergeOutcome }> {
    const worktrees =
      options.worktrees === undefined ? undefined : new WorktreeRun(this.ctx, options.worktrees, options.onProgress)
    // Every member prompt through here carries the intent header (docs/05
    // §6.1). A peer-team keys each member run by its board task, whose own
    // intent replaces the run's; no other topology seeds the board.
    const run: RunMember = (member, prompt, taskKey) => {
      const framed = withIntent(prompt, board.list().find((t) => t.id === taskKey)?.intent ?? spec.intent)
      return worktrees === undefined
        ? this.runMember(member, framed, options)
        : worktrees.runMember(member, framed, taskKey, options)
    }
    if (worktrees === undefined) return this.dispatch(spec, run, options, board, roster, mailbox, ask)

    // Clear anything a previously crashed team left in this repo before adding
    // our own checkouts.
    await worktrees.sweepOrphans()
    let result: TeamResult
    try {
      result = await this.dispatch(spec, run, options, board, roster, mailbox, ask, worktrees)
    } catch (error) {
      // Abort (signal or throw): drop our worktrees rather than leaving them
      // for the next sweep. Branches survive, so committed work is recoverable.
      await worktrees.abort().catch(() => undefined)
      throw error
    }
    // A verdict that does not decide anything is not a gate. Only the cascade
    // has a whole-run notion of acceptance; every other topology's tasks stand
    // or fall individually, so they merge as before.
    const merge = result.topology !== 'cascade' || result.accepted
    return { ...result, git: await worktrees.finalize({ merge }) }
  }

  /**
   * Resolve the cascade's command-confidence gate.
   *
   * Under worktree execution the tiers edit a worktree, NOT the repo root, so
   * a runner bound to `process.cwd()` would grade a tree the member never
   * touched — and since that tree is the user's own (usually green) checkout,
   * the gate would pass no matter what the tier did. The worktree is therefore
   * resolved lazily, per invocation: it does not exist when `dispatch` runs,
   * and `SwarmGit` memoizes it, so this returns the same tree the tiers share.
   * An explicit `confidenceRunner` still wins — the caller knows best.
   */
  private confidenceRunner(
    options: RunTeamOptions,
    worktrees?: WorktreeRun,
  ): RunConfidence {
    if (options.confidenceRunner !== undefined) return options.confidenceRunner
    if (worktrees === undefined) {
      return defaultConfidenceRunner(options.confidenceCwd ?? process.cwd())
    }
    const pinPaths = options.confidencePinPaths ?? []
    const report = options.onProgress ?? (() => {})
    return async (commands) => {
      const cwd = (await worktrees.worktree(CASCADE_TASK_KEY)).path
      if (pinPaths.length > 0) {
        const discarded = await worktrees.pinForGate(CASCADE_TASK_KEY, pinPaths)
        // Reverting a member's work silently would be its own trap, and a tier
        // that spent its turn editing tests should show up in the record.
        if (discarded.length > 0) {
          report(`gate: discarded member edits to ${discarded.length} pinned path(s): ${discarded.slice(0, 5).join(', ')}`)
        }
      }
      return defaultConfidenceRunner(cwd)(commands)
    }
  }

  private dispatch(
    spec: TeamSpec,
    run: RunMember,
    options: RunTeamOptions,
    board: SwarmBoard,
    roster: Map<string, PeerHandle>,
    mailbox: SwarmMailbox,
    ask: AskQuestion,
    worktrees?: WorktreeRun,
  ): Promise<TeamResult> {
    const report = options.onProgress
    switch (spec.topology) {
      case 'fanout':
        return runFanout(spec, run, report)
      case 'critic-loop':
        return runCriticLoop(spec, run, report)
      case 'committee':
        return runCommittee(spec, run, report)
      case 'pipeline':
        return runPipeline(spec, run, report)
      case 'cascade':
        return runCascade(spec, run, this.confidenceRunner(options, worktrees), report, ask)
      case 'coordinator':
        return runCoordinator(spec, run, report)
      case 'peer-team':
        return spec.messaging === true
          ? worktrees === undefined
            ? this.runPeerTeamMessaging(spec, options, board, roster, mailbox, ask)
            : this.runRemotePeerTeam(spec, options, board, roster, mailbox, ask, worktrees)
          : runPeerTeam(spec, run, board, report, ask)
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
    board: SwarmBoard,
    roster: Map<string, PeerHandle>,
    mailbox: SwarmMailbox,
    ask: AskQuestion,
    worktrees: WorktreeRun,
  ): Promise<import('./types').PeerTeamResult> {
    if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
    const created = await seedBoard(board, spec.tasks)
    const seeded = new Set(created)

    const server = new SwarmServer(mailbox)
    await server.listen()
    const cfg = options.worktrees?.member ?? {}
    const launch = resolveMemberLaunch(cfg)
    const peers: RemotePeer[] = []
    const report = options.onProgress ?? (() => {})
    const idleTimeoutMs = spec.memberIdleTimeoutMs ?? 300_000
    const restarts = new Map<string, number>()
    const maxRestarts = spec.maxMemberRestarts ?? 1
    /** Per member, `maxRestarts` plus one for each 'restart' answer once it was spent. */
    const budgets = new Map<string, number>()

    /** Spawn one member; a restarted one resumes its session, so it is not re-briefed. */
    const spawnMember = async (member: MemberSpec, restarted = false): Promise<RemotePeer> => {
      const names = spec.members.filter((m) => m.name !== member.name).map((m) => m.name)
      const worktree = await worktrees.worktree(member.name)
      const peer = await RemotePeer.spawn({
        name: member.name,
        command: launch.command,
        args: launch.args,
        cwd: worktree.path,
        env: {
          // Same session root on restart, so the member server resumes.
          ...worktrees.memberEnv(),
          OPENSWARM_SWARM_URL: server.url,
          // A restart is a new identity on the wire; the dead token stays dead.
          OPENSWARM_SWARM_TOKEN: server.addMember(member.name),
        },
        provider: member.agentOptions?.provider ?? cfg.provider ?? 'openai',
        model: resolveMemberModel(member, cfg),
        idleTimeoutMs,
        onStall: async () => {
          const task = board.list().find((t) => t.status === 'in_progress' && t.owner === member.name)
          const answer = await ask({
            trigger: 'stall',
            prompt: `${member.name} has produced no output for over ${Math.round((2 * idleTimeoutMs) / 1000)}s${task === undefined ? '' : ` on "${task.subject}"`} and did not respond to a nudge. Restart it (its session resumes), or wait another ${Math.round(idleTimeoutMs / 1000)}s?`,
            options: ['restart', 'wait'],
            default: 'restart',
          })
          return answer === 'wait' ? 'wait' : 'restart'
        },
        briefing: restarted
          ? 'Your process was restarted. Your conversation and worktree are intact; continue your task.'
          : `${member.persona === undefined ? '' : `${member.persona}\n\n`}You are ${member.name}, a member of a swarm team working in your own git worktree. Your teammates: ${names.join(', ') || '(none)'}. Coordinate with them via the swarm_send_message tool. Acknowledge this briefing and wait for tasks.`,
      })
      peers.push(peer)
      roster.set(member.name, { name: member.name, remote: peer })
      return peer
    }

    /**
     * Bring a dead member back with what it knew: the replacement reuses the
     * session id and root, so the member server resumes its persisted session,
     * and its worktree still holds its file changes. Once the restart budget
     * is spent it asks: 'restart' allows exactly one more, 'drop' (the
     * default) returns false, which hands the task to `runBoardWorkers` to
     * retry on a sibling.
     */
    const restart = async (member: MemberSpec, task: SwarmTaskSnapshot, error: unknown): Promise<boolean> => {
      const used = restarts.get(member.name) ?? 0
      let budget = budgets.get(member.name) ?? maxRestarts
      if (used >= budget) {
        report(`${member.name} exhausted its restart budget (${budget})`)
        const answer = await ask({
          trigger: 'restart-budget',
          prompt: `${member.name} died on "${task.subject}" with its restart budget spent (${used}/${budget}); last error: ${head(error instanceof Error ? error.message : String(error))}. Restart it once more, or drop it and leave the task to a sibling?`,
          options: ['drop', 'restart'],
          default: 'drop',
        })
        if (answer !== 'restart') return false
        budgets.set(member.name, ++budget)
      }
      restarts.set(member.name, used + 1)
      await roster.get(member.name)?.remote?.close().catch(() => undefined)
      report(`restarting ${member.name} (${used + 1}/${budget})`)
      try {
        await spawnMember(member, true)
        return true
      } catch (error) {
        report(`${member.name} failed to restart: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }

    try {
      for (const member of spec.members) await spawnMember(member)

      const runs = await runBoardWorkers(
        spec.members,
        board,
        seeded,
        async (member, claimed) => {
          // A cancelled run takes no new turns; a running turn finishes first.
          options.signal?.throwIfAborted()
          const blocks: ContentBlock[] = [{ type: 'text', text: withIntent(claimed.prompt, claimed.intent ?? spec.intent) }]
          for (let attempt = 0; ; attempt++) {
            const handle = roster.get(member.name)!
            const prelude = mailbox.framePendingQuiet(member.name)
            try {
              const result = await handle.remote!.ask([...prelude.blocks, ...blocks])
              await prelude.ack()
              return result
            } catch (error) {
              // Mail stays pending for the replacement rather than being
              // consumed by a turn that never happened.
              prelude.release()
              if (attempt > 0 || !(await restart(member, claimed, error))) throw error
            }
          }
        },
        options.onProgress,
        spec.maxTaskAttempts,
        ask,
      )
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
    board: SwarmBoard,
    roster: Map<string, PeerHandle>,
    mailbox: SwarmMailbox,
    ask: AskQuestion,
  ): Promise<import('./types').PeerTeamResult> {
    if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
    const lead = options.parent
    const created = await seedBoard(board, spec.tasks)
    const seeded = new Set(created)

    const provider = this.swarmConfig.defaultSubagentProvider ?? 'spawn'
    // A child's last settlement notice can reach the lead after this runner
    // returns, so the suppression outlives the run: every notice while it
    // runs, then only this run's children's, for the lead's lifetime.
    // ponytail: one filter per run on a long-lived parent; drop it once each
    // child's final notice is swallowed if parents ever host many runs.
    const children = new Set<string>()
    let running = true
    suppressSettlementTurns(lead, (childId) => running || children.has(childId))
    const disposers: (() => void)[] = [registerSwarmMessaging(this.ctx, roster, mailbox)]
    for (const member of spec.members) {
      const names = spec.members.filter((m) => m.name !== member.name).map((m) => m.name)
      const handle = await spawnPeer(this.ctx, member, {
        parent: lead,
        provider: member.subagentProvider ?? provider,
        briefing: `You are ${member.name}, a member of a swarm team. Your teammates: ${names.join(', ') || '(none)'}. Coordinate with them via the swarm_send_message tool. Acknowledge this briefing and wait for tasks.`,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      roster.set(member.name, handle)
      if (handle.childId !== undefined) children.add(String(handle.childId))
    }

    let runs: Record<string, MemberRunResult>
    try {
      runs = await runBoardWorkers(
        spec.members,
        board,
        seeded,
        (member, claimed) =>
          askPeer(this.ctx, lead, roster.get(member.name)!, withIntent(claimed.prompt, claimed.intent ?? spec.intent), {
            mailbox,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
        options.onProgress,
        spec.maxTaskAttempts,
        ask,
      )
    } finally {
      running = false
      for (const dispose of disposers) dispose()
    }
    const tasks = board.list().filter((t) => seeded.has(t.id))
    return { topology: 'peer-team', tasks, runs }
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
