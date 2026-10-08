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
 * answers to the questions the harness raises (A6). Every member run journals
 * its usage, every landing an evidence bundle (B4), and a settled run's
 * result carries its RunMetrics (B5), also emitted as `swarm/metrics`.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Type-only, for the `ctx.userQuestions` Context augmentation.
import type {} from '@deepseek-ai/dsh-user-questions'
import { SwarmBoard, foldBoard, type SwarmTaskSnapshot } from './board'
import { buildEvidence, landingsOf, type LandingEvidence } from './evidence'
import { SwarmJournal, type SwarmJournalEvent } from './journal'
import { foldMetrics, recordUsage, type Pricing, type RecordUsage, type RunMetrics, type SwarmRestartEvent, type UsageRole } from './metrics'
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
import { runGateCommand, type HiddenSuite, type VerifierLevel } from './gate'
import { activeVerifier, hiddenSuite, openVerifier, recordToolEvents, toolEventsFromLogs, type Verifier } from './verifier'
import { recapTrain, trainVerify, TrainStoppedError, validateTrain } from './train'
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
  type BoardGate,
  type ReportProgress,
  type RunConfidence,
  type RunMember,
} from './topologies'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

const execFileAsync = promisify(execFile)

export * from './types'
export * from './board'
export * from './journal'
export * from './mailbox'
export * from './run'
export * from './protocol'
export * from './gate'
export * from './verifier'
export * from './train'
export * from './evidence'
export * from './metrics'
export {
  askPeer,
  nextTurnEnd,
  registerSwarmMessaging,
  spawnPeer,
  suppressSettlementTurns,
} from './peers'
export { coordinatorSpec, parseNumberedPlan, renderIntent } from './topologies'
export type { BoardGate, ReportProgress, RunMember } from './topologies'
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
  /**
   * $ per million tokens by model id, for RunMetrics' dollars (docs/05 B5).
   * No default: without a price, metrics report tokens and dollars are null.
   */
  pricing?: Pricing
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

/** A run's train journal (docs/05 B2), beside its run journal. */
export function trainJournalPath(runsDir: string, runId: string): string {
  return join(dirname(runJournalPath(runsDir, runId)), 'train.jsonl')
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

/**
 * A run read from its journal file. Read-only: it never appends or truncates.
 * The recap ends with the train's lines, from its own journal; past a cursor
 * into the run's, those journaled after that event.
 */
export function viewRun(runsDir: string, runId: string, { since }: { since?: number } = {}): SwarmRunView {
  const events = SwarmJournal.read(runJournalPath(runsDir, runId))
  const run = foldRun(events)
  if (run === undefined) throw new Error(`unknown run "${runId}"`)
  // ponytail: by time, as the train's seqs are its own; an event in the cursor's millisecond is skipped.
  const after = since === undefined ? -Infinity : (events.find((e) => e.seq === since)?.time ?? -Infinity)
  return {
    run,
    tasks: [...foldBoard(events).values()],
    questions: [...foldQuestions(events).values()],
    recap: [...recapJournal(events, since), ...recapTrain(SwarmJournal.read(trainJournalPath(runsDir, runId)).filter((e) => e.time > after))],
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
  /** Settles after the run's `finished` or `failed` record is written; a finished run's carries its metrics (docs/05 B5). */
  readonly result: Promise<TeamResult & { git?: MergeOutcome; metrics?: RunMetrics }>
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
  /**
   * Working directory for the default confidence runner, and for a gated
   * peer-team's checks when members do not run in worktrees.
   */
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
  /**
   * The L3 verifier a gated team's hidden suites run on (docs/05 B1): for
   * tests, set in code. Default the installed one (`/usr/bin/sudo -n -u …`).
   */
  verifier?: Verifier
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

/**
 * What a member's run is for when its caller does not say (docs/05 B5): a
 * critic or a cascade's gate reviews, a coordinator or a committee's judge
 * leads; everyone else does task work.
 */
function roleOf(spec: TeamSpec, member: string): UsageRole {
  if (spec.topology === 'critic-loop' && spec.critic.name === member) return 'review'
  if (spec.topology === 'cascade' && spec.gate?.name === member) return 'review'
  if (spec.topology === 'committee' && spec.judge?.name === member) return 'lead'
  if (spec.topology === 'coordinator' && spec.coordinator.name === member) return 'lead'
  return 'task'
}

/** A spec's members, in order: who the train asks to repair or resolve an entry no member ran in. */
function teamMembers(spec: TeamSpec): MemberSpec[] {
  switch (spec.topology) {
    case 'critic-loop':
      return [spec.worker, spec.critic]
    case 'pipeline':
      return spec.stages.map((stage) => stage.member)
    case 'cascade':
      return spec.tiers
    case 'coordinator':
      return [...spec.workers, spec.coordinator]
    default:
      return spec.members
  }
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
  /** In-process members' usage, by session, until their run takes it. */
  private readonly usage: ReturnType<typeof recordUsage>

  constructor(ctx: Context, config: SwarmConfig = {}) {
    super(ctx, 'swarm')
    this.swarmConfig = config
    this.usage = recordUsage(ctx)
  }

  private runsDir(): string {
    return this.swarmConfig.runsDir ?? defaultRunsDir()
  }

  /** `SwarmConfig.pricing`: what metrics and landings price usage at. */
  get pricing(): Pricing | undefined {
    return this.swarmConfig.pricing
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
    // A gated team's board refuses to complete a task without passing evidence.
    // A path that resumes a run from its journal must derive this flag the same
    // way, from the journaled spec, or the resumed board closes tasks unverified.
    const board = new SwarmBoard(
      journal,
      spec.topology === 'peer-team' && spec.gate !== undefined
        ? { gated: true, ...(spec.gate.minLevel === undefined ? {} : { minLevel: spec.gate.minLevel }) }
        : {},
    )
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
    const ask: AskQuestion = (request, onClosed) => {
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
        onClosed?.(capped)
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
          const closed: SwarmQuestion = {
            ...question,
            status: by === undefined ? 'defaulted' : 'answered',
            answer,
            ...(by === undefined ? {} : { by }),
            closedAt: Date.now(),
          }
          onClosed?.(closed)
          recordQuestion(closed).then(() => resolve(answer), reject)
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
      ...(options.worktrees === undefined ? {} : { landing: options.worktrees.train === undefined ? 'queue' : 'train' }),
      usageJournaled: true,
      spec,
    }
    await record(running)
    /**
     * The run's metrics as it settles (docs/05 B5), emitted as `swarm/metrics`
     * for an eval to record; neither a fold nor a listener that throws fails the run.
     */
    const settle = (endedAt: number, git?: MergeOutcome): RunMetrics | undefined => {
      let metrics: RunMetrics
      try {
        const train = SwarmJournal.read(trainJournalPath(this.runsDir(), id))
        metrics = foldMetrics(journal.events, train, { now: endedAt, ...(git === undefined ? {} : { git }), ...(this.pricing === undefined ? {} : { pricing: this.pricing }) })
      } catch {
        return undefined
      }
      try {
        this.ctx.emit('swarm/metrics', id, metrics)
      } catch {}
      return metrics
    }
    const result = this.execute(spec, { ...options, signal }, board, roster, mailbox, ask, journal)
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
          const endedAt = Date.now()
          const metrics = settle(endedAt, result.git)
          const settled = metrics === undefined ? result : { ...result, metrics }
          await record({ ...running, status: 'finished', endedAt, result: settled })
          return settled
        },
        async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          // A train that stopped says what had landed: those commits are on the target.
          const git = error instanceof TrainStoppedError ? { git: error.outcome } : {}
          const endedAt = Date.now()
          settle(endedAt, git.git)
          await record({ ...running, status: 'failed', endedAt, error: message, ...git })
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
  ): Promise<TeamResult & { git?: MergeOutcome; metrics?: RunMetrics }> {
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

  /** A run's journal events: in memory while it is live here, else read from its file. */
  events(runId: string): readonly SwarmJournalEvent[] {
    return this.liveRuns.get(runId)?.journal.events ?? SwarmJournal.read(this.journalPath(runId))
  }

  /** A run's landing queue (docs/05 B4), from `events` when the caller has them. */
  landings(runId: string, events = this.events(runId)): LandingEvidence[] {
    return landingsOf(events, SwarmJournal.read(trainJournalPath(this.runsDir(), runId)))
  }

  /** A run's {@link foldMetrics} (docs/05 B5), priced with `SwarmConfig.pricing`, from `events` when the caller has them. */
  metrics(runId: string, events = this.events(runId)): RunMetrics {
    return foldMetrics(events, SwarmJournal.read(trainJournalPath(this.runsDir(), runId)), this.pricing === undefined ? {} : { pricing: this.pricing })
  }

  private async execute(
    spec: TeamSpec,
    options: RunTeamOptions,
    board: SwarmBoard,
    roster: Map<string, PeerHandle>,
    mailbox: SwarmMailbox,
    ask: AskQuestion,
    journal: SwarmJournal,
  ): Promise<TeamResult & { git?: MergeOutcome }> {
    // Every member run's usage, journaled as it settles (docs/05 B5).
    const usage: RecordUsage = async ({ role, ...record }) => {
      await journal.append('swarm/usage', { version: 1, ...record, role: role ?? roleOf(spec, record.member) })
    }
    const worktrees =
      options.worktrees === undefined ? undefined : new WorktreeRun(this.ctx, options.worktrees, options.onProgress, usage)
    // Every member prompt through here carries the intent header (docs/05
    // §6.1). A peer-team keys each member run by its board task, whose own
    // intent replaces the run's; no other topology seeds the board.
    const run: RunMember = (member, prompt, taskKey, role) => {
      const framed = withIntent(prompt, board.list().find((t) => t.id === taskKey)?.intent ?? spec.intent)
      return worktrees === undefined
        ? this.runMember(member, framed, options, { usage, ...(taskKey === undefined ? {} : { taskKey }), ...(role === undefined ? {} : { role }) })
        : worktrees.runMember(member, framed, taskKey, options, role)
    }
    if (worktrees === undefined) return this.dispatch(spec, run, options, board, roster, mailbox, ask, journal)

    // The train is refused, and the L3 verifier asked whether it holds the
    // suite, before any spend.
    const train = options.worktrees!.train
    if (train !== undefined) validateTrain(train, options.worktrees!)
    const hidden =
      train?.suite === undefined
        ? undefined
        : { session: await openVerifier(options.verifier ?? activeVerifier(), [train.suite]), envRoot: resolve(options.worktrees!.repoRoot) }
    // Clear anything a previously crashed team left in this repo before adding
    // our own checkouts.
    await worktrees.sweepOrphans()
    let result: TeamResult
    try {
      result = await this.dispatch(spec, run, options, board, roster, mailbox, ask, journal, worktrees)
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
    const landing =
      train === undefined || !merge
        ? {}
        : {
            train: {
              journal: SwarmJournal.open(join(dirname(journal.path), 'train.jsonl')),
              runEvents: () => journal.events,
              tasks: board.list(),
              members: teamMembers(spec),
              verify: trainVerify(train, hidden),
              // Under L3 each repair and resolver is scanned as a gate round is (B1),
              // its transcript from the subprocess member's session logs.
              ...(hidden === undefined
                ? {}
                : {
                    scan: (key: string, step: Parameters<HiddenSuite['scan']>[0]) =>
                      hiddenSuite(hidden.session, {
                        suite: train.suite!,
                        cwd: async () => (await worktrees.worktree(key)).path,
                        envRoot: hidden.envRoot,
                        transcript: (_result, startedAt) => toolEventsFromLogs(worktrees.memberEnv()['DSH_SESSION_ROOT']!, startedAt),
                      }).scan(step),
                  }),
              ask,
              options,
              ...(options.onProgress === undefined ? {} : { report: options.onProgress }),
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            },
          }
    const git = await worktrees.finalize({ merge, ...landing })
    // Without the train, each merged or conflicted task's evidence (docs/05 B4): its gate's, and its diff against the base.
    if (landing.train === undefined) {
      const landed = [...git.merged.map((m) => ['landed', m] as const), ...git.conflicts.map((c) => ['conflicted', c] as const)]
      for (const [outcome, { taskKey, branch }] of landed) {
        const { base, diff } = await worktrees.landingDiff(branch)
        const at = { key: taskKey, outcome, via: 'queue', branch, base, at: Date.now(), ...(diff === undefined ? {} : { diff }) } as const
        await journal.append('swarm/evidence', buildEvidence(at, journal.events, []))
      }
    }
    return { ...result, git }
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
    journal: SwarmJournal,
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
        return (async () => {
          // Checked here, before any path seeds the board.
          const { gate, dispose } = await this.boardGate(spec, options, worktrees)
          try {
            return await (spec.messaging === true
              ? worktrees === undefined
                ? this.runPeerTeamMessaging(spec, options, board, roster, mailbox, ask)
                : this.runRemotePeerTeam(spec, options, board, roster, mailbox, ask, worktrees, journal)
              : runPeerTeam(spec, run, board, report, ask, gate))
          } finally {
            dispose()
          }
        })()
    }
  }

  /**
   * A gated peer-team's gate (docs/05 B6b), refused before seeding when it
   * cannot run. A task's checks run where its member's work lands: its
   * per-task worktree under worktree execution, else `confidenceCwd`. A task
   * without checks needs the reviewer, a subprocess member launched as
   * worktree members are, so review mode requires worktree execution. Under
   * worktrees the gate owns the tree, so a regression is rolled back and
   * `confidencePinPaths` are restored after every member round; neither ever
   * touches the user's checkout.
   *
   * Levels (docs/05 B1): a task needing L2 needs checks, L3 a hidden suite;
   * a task with a suite is accepted by it, its checks or reviewer giving
   * feedback only. The verifier is asked before any spend whether it holds
   * every suite named; `dispose` ends the transcript recording L3 scans read.
   */
  private async boardGate(
    spec: import('./types').PeerTeamSpec,
    options: RunTeamOptions,
    worktrees?: WorktreeRun,
  ): Promise<{ gate?: BoardGate; dispose: () => void }> {
    const gate = spec.gate
    if (gate === undefined) return { dispose: () => {} }
    // ponytail: messaging teams are not gated. Under worktrees a member keeps
    // one long-lived worktree, so a failed attempt's edits stay in it, taint
    // its next task's snapshot and checks, and merge unverified; and on any
    // path a teammate's wakeup message can start a turn while the gate
    // snapshots, checks or rolls back (a rollback silently erases that turn's
    // edits, or collides on index.lock). Gating them needs wakeups held quiet
    // during a gated claim and a rollback to the claim's base before release.
    if (spec.messaging === true) {
      throw new Error('the completion gate (peer-team gate) does not cover messaging teams yet; drop gate or messaging')
    }
    if (gate.rounds !== undefined && (!Number.isInteger(gate.rounds) || gate.rounds < 1)) {
      throw new Error('peer-team gate.rounds must be a positive integer')
    }
    for (const task of spec.tasks) {
      const level: VerifierLevel = task.minLevel ?? gate.minLevel ?? 0
      const which = `gated task "${task.subject}"`
      if (![0, 1, 2, 3].includes(level)) {
        throw new Error(`${which} needs L${level}; a gate reaches L1 (reviewer), L2 (checks) or L3 (hidden suite), and L4 (external CI) is not built`)
      }
      const suite = task.suite ?? gate.suite
      if (suite !== undefined && !/^[a-z0-9-]{1,64}$/.test(suite)) throw new Error(`${which} names suite "${suite}"; a suite name is 1-64 of [a-z0-9-]`)
      if (level === 3 && suite === undefined) throw new Error(`${which} needs L3, a hidden suite: give it (or the gate) a suite`)
      if (level === 2 && suite === undefined && (task.checks ?? gate.checks ?? []).length === 0) {
        throw new Error(`${which} needs L2: give it (or the gate) checks`)
      }
    }
    // A task with a suite is accepted by it; only one with neither suite nor checks rests on the reviewer.
    const reviewed = spec.tasks.find((task) => (task.checks ?? gate.checks ?? []).length === 0 && (task.suite ?? gate.suite) === undefined)
    // Sandboxed unless the env says otherwise, as on the CLI's single path.
    // ponytail: no preflight here, so on a host that cannot sandbox each review
    // fails and stops its gate unaccepted; probe as the CLI does if that spend matters.
    const sandbox = process.env['OPENSWARM_GATE_REVIEWER_SANDBOX'] || 'workspace-write'
    if (reviewed !== undefined) {
      const which = `gated task "${reviewed.subject}" has no checks`
      if (gate.review === false) throw new Error(`${which} and the team's gate has review off; give it checks`)
      if (worktrees === undefined) {
        throw new Error(
          `${which}, so a reviewer would measure it, and the reviewer runs as a worktree member: run with worktree execution (RunTeamOptions.worktrees) or give every task checks`,
        )
      }
      if (sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') {
        throw new Error(`OPENSWARM_GATE_REVIEWER_SANDBOX must be workspace-write or danger-full-access, not "${sandbox}"`)
      }
    }
    const pinPaths = options.confidencePinPaths ?? []
    const report = options.onProgress ?? (() => {})
    const suites = [...new Set(spec.tasks.flatMap((task) => task.suite ?? gate.suite ?? []))]
    const session = suites.length === 0 ? undefined : await openVerifier(options.verifier ?? activeVerifier(), suites)
    const shared = options.confidenceCwd ?? process.cwd()
    // The repository the members' ignored environment lives in (node_modules, .venv…).
    const envRoot =
      session === undefined
        ? ''
        : worktrees !== undefined
          ? resolve(options.worktrees!.repoRoot)
          : (await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: shared })).stdout.trim()
    // In-process members' tool calls reach this context's events; subprocess
    // members' are in their session logs. Last, so nothing above leaves it recording.
    const recorder = session === undefined || worktrees !== undefined ? undefined : recordToolEvents(this.ctx)
    const sessionRoot = worktrees?.memberEnv()['DSH_SESSION_ROOT']
    const hidden = (claimed: SwarmTaskSnapshot, cwd: () => Promise<string>) => {
      const suite = claimed.suite ?? gate.suite
      return session === undefined || suite === undefined
        ? {}
        : {
            hidden: hiddenSuite(session, {
              suite,
              cwd,
              envRoot,
              transcript: (result: MemberRunResult, startedAt: number) =>
                recorder !== undefined ? recorder.take(result.runId) : sessionRoot === undefined ? [] : toolEventsFromLogs(sessionRoot, startedAt),
            }),
          }
    }
    return {
      dispose: () => recorder?.dispose(),
      gate: {
        ...(gate.rounds === undefined ? {} : { rounds: gate.rounds }),
        ...(gate.checks === undefined ? {} : { checks: gate.checks }),
        ...(gate.minLevel === undefined ? {} : { minLevel: gate.minLevel }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        tree: (member, claimed) => {
          // ponytail: without worktrees every member shares this one tree, so a
          // task's checks also see siblings' work in flight; worktrees isolate it.
          if (worktrees === undefined) return { cwd: shared, ...hidden(claimed, async () => shared) }
          const key = claimed.id
          const cwd = async () => (await worktrees.worktree(key)).path
          return {
            cwd,
            ...hidden(claimed, cwd),
            // The member's own route reviews, as on the single path; under L3
            // only for feedback, and not at all with review off.
            ...(gate.review === false
              ? {}
              : {
                  review: (prompt: string, commit: string) =>
                    worktrees.review(
                      key,
                      { name: 'reviewer', ...(member.agentOptions === undefined ? {} : { agentOptions: member.agentOptions }) },
                      prompt,
                      commit,
                      sandbox,
                      options,
                    ),
                }),
            rollback: (commit) => worktrees.rollback(key, commit),
            // As the cascade's gate does: the graded party may not edit what grades it.
            ...(pinPaths.length === 0
              ? {}
              : {
                  pin: async () => {
                    const discarded = await worktrees.pinForGate(key, pinPaths)
                    if (discarded.length > 0) {
                      report(`gate: discarded member edits to ${discarded.length} pinned path(s): ${discarded.slice(0, 5).join(', ')}`)
                    }
                  },
                }),
          }
        },
      },
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
    journal: SwarmJournal,
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
            ...(task === undefined ? {} : { taskId: task.id }),
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
          taskId: task.id,
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
        await journal.append('swarm/restart', { version: 1, member: member.name, taskId: task.id, restart: used + 1 } satisfies SwarmRestartEvent)
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

  /** One member, one prompt, one settled subagent run, its usage journaled (docs/05 B5). */
  private async runMember(
    member: MemberSpec,
    prompt: string,
    options: RunTeamOptions,
    account: { usage: RecordUsage; taskKey?: string; role?: UsageRole },
  ): Promise<MemberRunResult> {
    const provider =
      member.subagentProvider ?? this.swarmConfig.defaultSubagentProvider ?? 'spawn'
    const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
    const startedAt = Date.now()
    const run = await this.ctx.subagents.start(provider, {
      label: member.name,
      prompt: [{ type: 'text', text }],
      parent: options.parent,
      signal: options.signal ?? new AbortController().signal,
      ...(member.agentOptions === undefined ? {} : { agentOptions: member.agentOptions }),
    })
    try {
      const result = await run.result
      return {
        member: member.name,
        runId: run.id,
        output: result.output,
        text: textOf(result.output),
        stopReason: result.stopReason,
      }
    } finally {
      // Settled or thrown, what it spent is journaled. A local provider's run id is its child
      // session's id. ponytail: a member's own subagents are other sessions, not counted.
      const { usage, ...named } = this.usage.take(run.id)
      const route = { ...options.parent.options, ...member.agentOptions, ...named }
      await account
        .usage({
          member: member.name,
          ...(account.role === undefined ? {} : { role: account.role }),
          ...(account.taskKey === undefined ? {} : { taskKey: account.taskKey }),
          runtime: `dsh:${provider}`,
          ...(route.provider === undefined ? {} : { provider: route.provider }),
          ...(route.model === undefined ? {} : { model: route.model }),
          runId: run.id,
          usage,
          startedAt,
        })
        // The member's own result or error stands; a journal that cannot append fails the run's record anyway.
        .catch(() => undefined)
    }
  }

}

declare module '@deepseek-ai/cordis' {
  interface Context {
    swarm: SwarmService
  }
  interface Events {
    /** A run settled, with its metrics (docs/05 B5); the eval reporter records them. */
    'swarm/metrics'(runId: string, metrics: RunMetrics): void
  }
}
