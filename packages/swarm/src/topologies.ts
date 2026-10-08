/**
 * Topology implementations, parameterized by a member-run callback so they
 * stay pure coordination logic over whatever runtime the service wires in.
 */
import type { SwarmBoard, SwarmTaskSnapshot, TaskEvidence } from './board'
import { runGate, targetStatuses, type GateDeps, type GateEvidence, type GateRound, type VerifierLevel } from './gate'
import type { AskQuestion } from './run'
import type {
  CriticLoopResult,
  CriticLoopSpec,
  FanoutResult,
  FanoutSpec,
  CascadeResult,
  CascadeSpec,
  CommitteeResult,
  CommitteeSpec,
  CoordinatorResult,
  CoordinatorSpec,
  Intent,
  MemberRunResult,
  MemberSpec,
  PeerTeamResult,
  PeerTeamSpec,
  PipelineResult,
  PipelineSpec,
} from './types'

/**
 * Run one member with one prompt. `taskKey` scopes the run to a shared unit
 * of work: under worktree execution, runs with the same key share a worktree
 * and runs without a key execute at the repo root.
 */
export type RunMember = (
  member: MemberSpec,
  prompt: string,
  taskKey?: string,
) => Promise<MemberRunResult>

/**
 * What a command gate observed. The score is the weakest link — 1 when every
 * command exits 0, else 0 — but a bare score is useless as feedback: the tier
 * that failed is told only that it failed, so the next tier is guessing. The
 * failing command and its output are what make the escalation loop informative
 * rather than ceremonial.
 */
export interface ConfidenceOutcome {
  score: number
  /** The first command that failed, when one did. */
  failedCommand?: string
  /** Tail of that command's combined output. */
  output?: string
}

/** A plain number is still accepted, and read as a bare score. */
export type RunConfidence = (commands: string[]) => Promise<number | ConfidenceOutcome>

/**
 * Every cascade tier (and its gate) shares this task key, so under worktree
 * execution the whole chain continues in ONE worktree. Exported because the
 * confidence gate must run its commands in that same tree — see the runner
 * built in `dispatch`.
 */
export const CASCADE_TASK_KEY = 'task'

/**
 * One human-readable progress line from a running team. Every topology emits;
 * the default is a no-op, so a consumer that does not pass one sees exactly
 * the previous behavior.
 */
export type ReportProgress = (line: string) => void

/** The default for a question nobody is there to answer: its own default, at once. */
const unattended: AskQuestion = async (question) => question.default

/** A text's whitespace-collapsed head, for question prompts. */
export const head = (text: string, max = 160): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

export async function runFanout(
  spec: FanoutSpec,
  run: RunMember,
  report: ReportProgress = () => {},
): Promise<FanoutResult> {
  const byName = new Map(spec.members.map((m) => [m.name, m]))
  if (byName.size !== spec.members.length) throw new Error('duplicate member name in team spec')
  report(`fanout: ${spec.tasks.length} task(s) across ${spec.members.length} member(s)`)
  let settled = 0
  const results = await Promise.all(
    spec.tasks.map(async (task, i) => {
      const member = byName.get(task.member)
      if (member === undefined) throw new Error(`fanout task names unknown member "${task.member}"`)
      const result = await run(member, task.prompt, `task-${i}`)
      report(`[${++settled}/${spec.tasks.length}] ${member.name}: ${task.prompt}`)
      return result
    }),
  )
  return { topology: 'fanout', results }
}

const DEFAULT_MAX_ROUNDS = 3

export async function runCriticLoop(
  spec: CriticLoopSpec,
  run: RunMember,
  report: ReportProgress = () => {},
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
        : `${spec.task}

Your previous draft:
${previous.text}

Reviewer feedback:
${feedback}

Revise the draft to address the feedback.`
    report(`round ${round}/${maxRounds}: ${spec.worker.name} drafting…`)
    const draft = await run(spec.worker, workerPrompt, 'task')
    report(`round ${round}/${maxRounds}: ${spec.critic.name} reviewing…`)
    const verdict = await run(
      spec.critic,
      `Task:
${spec.task}

Draft under review:
${draft.text}

Reply with exactly APPROVED if the draft fully satisfies the task; otherwise reply REVISE: <specific feedback>.`,
      'task',
    )
    history.push({ draft, verdict })
    report(`round ${round}: ${isApproved(verdict.text) ? 'approved' : 'revise'}`)
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

/** Critic/gate verdict protocol: `APPROVED` approves; anything else is feedback. */
export function isApproved(verdict: string): boolean {
  return /^\s*APPROVED\b/i.test(verdict)
}

export async function runCommittee(
  spec: CommitteeSpec,
  run: RunMember,
  report: ReportProgress = () => {},
): Promise<CommitteeResult> {
  report(`committee: ${spec.members.length} member(s) answering…`)
  let settled = 0
  const answers = await Promise.all(
    spec.members.map(async (m) => {
      const answer = await run(m, spec.task, `answer-${m.name}`)
      report(`[${++settled}/${spec.members.length}] ${m.name} answered`)
      return answer
    }),
  )
  if (spec.judge === undefined) return { topology: 'committee', answers }
  report(`${spec.judge.name} synthesizing…`)
  const dossier = answers
    .map((a) => `--- Answer from ${a.member} ---\n${a.text}`)
    .join('\n\n')
  const synthesis = await run(
    spec.judge,
    `Task:\n${spec.task}\n\nIndependent answers:\n\n${dossier}\n\nSynthesize the best single answer, drawing on the strongest points of each.`,
  )
  return { topology: 'committee', answers, synthesis }
}

export async function runPipeline(
  spec: PipelineSpec,
  run: RunMember,
  report: ReportProgress = () => {},
): Promise<PipelineResult> {
  if (spec.stages.length === 0) throw new Error('pipeline needs at least one stage')
  const stages: MemberRunResult[] = []
  let carry: string | undefined
  let index = 0
  for (const stage of spec.stages) {
    report(`stage ${++index}/${spec.stages.length}: ${stage.member.name}…`)
    const prompt =
      carry === undefined ? stage.prompt : `${stage.prompt}\n\nInput from the previous stage:\n${carry}`
    const result = await run(stage.member, prompt, 'pipeline')
    stages.push(result)
    carry = result.text
  }
  const final = stages[stages.length - 1]
  if (final === undefined) throw new Error('unreachable: pipeline ran zero stages')
  return { topology: 'pipeline', stages, final }
}

export async function runCascade(
  spec: CascadeSpec,
  run: RunMember,
  runConfidence?: RunConfidence,
  report: ReportProgress = () => {},
  ask: AskQuestion = unattended,
): Promise<CascadeResult> {
  if (spec.tiers.length === 0) throw new Error('cascade needs at least one tier')
  if (spec.confidence !== undefined && runConfidence === undefined) {
    throw new Error('cascade confidence gate requires a confidence runner')
  }
  const attempts: CascadeResult['attempts'] = []
  let feedback: string | undefined
  const top = spec.tiers.length - 1
  /**
   * The tiers in order. The loop returns on an accepted tier, so resuming past
   * the last one means every tier failed: ask, and on 'retry' run the top tier
   * once more with the last feedback, returning whatever that attempt yields.
   */
  async function* tiers(): AsyncGenerator<number> {
    for (let tier = 0; tier <= top; tier++) yield tier
    const last = attempts.at(-1)!
    const why =
      last.result.stopReason === 'completed'
        ? `last feedback: ${head(feedback ?? '')}`
        : `${last.result.member} stopped (${last.result.stopReason})`
    const answer = await ask({
      trigger: 'verifier-failure',
      prompt: `cascade task "${head(spec.task, 80)}" failed on all ${spec.tiers.length} tier(s) (${attempts.length} attempt(s)); ${why}. Retry ${spec.tiers[top]!.name} once more with that feedback, or stop?`,
      options: ['stop', 'retry'],
      default: 'stop',
    })
    if (answer === 'retry') yield top
  }
  for await (const tier of tiers()) {
    const member = spec.tiers[tier]!
    const prompt =
      feedback === undefined
        ? spec.task
        : `${spec.task}\n\nA previous attempt was rejected with this feedback:\n${feedback}`
    report(`tier ${tier + 1}/${spec.tiers.length}: ${member.name}…`)
    const result = await run(member, prompt, CASCADE_TASK_KEY)
    if (result.stopReason !== 'completed') {
      report(`tier ${tier + 1}: ${result.stopReason} — escalating`)
      attempts.push({ tier, result })
      continue
    }
    if (spec.confidence !== undefined) {
      const raw = await runConfidence!(spec.confidence.commands)
      const outcome: ConfidenceOutcome = typeof raw === 'number' ? { score: raw } : raw
      const confidence = outcome.score
      attempts.push({
        tier,
        result,
        confidence,
        ...(outcome.failedCommand === undefined
          ? {}
          : { failure: { command: outcome.failedCommand, output: outcome.output ?? '' } }),
      })
      report(
        outcome.failedCommand === undefined
          ? `tier ${tier + 1}: confidence ${confidence} vs tau ${spec.confidence.tau}`
          : `tier ${tier + 1}: confidence ${confidence} vs tau ${spec.confidence.tau} — failed: ${outcome.failedCommand}`,
      )
      if (confidence >= spec.confidence.tau) {
        return { topology: 'cascade', accepted: true, tier, final: result, attempts }
      }
      // Hand the next tier the actual failure. "The commands did not pass" tells
      // it nothing it can act on; the command and its output tell it what broke.
      feedback =
        outcome.failedCommand === undefined
          ? `automated confidence ${confidence} was below the required threshold ${spec.confidence.tau}; the verification commands did not pass`
          : `Verification failed. This command exited non-zero:\n\n  ${outcome.failedCommand}\n\nIts output ended with:\n\n${outcome.output ?? '(no output captured)'}`
      continue
    }
    if (spec.gate === undefined) {
      attempts.push({ tier, result })
      return { topology: 'cascade', accepted: true, tier, final: result, attempts }
    }
    const verdict = await run(
      spec.gate,
      `Task:\n${spec.task}\n\nCandidate result:\n${result.text}\n\nReply with exactly APPROVED if the result fully satisfies the task; otherwise reply REVISE: <specific feedback>.`,
      CASCADE_TASK_KEY,
    )
    attempts.push({ tier, result, verdict })
    report(`tier ${tier + 1}: gate ${isApproved(verdict.text) ? 'approved' : 'rejected'}`)
    if (isApproved(verdict.text)) {
      return { topology: 'cascade', accepted: true, tier, final: result, attempts }
    }
    feedback = verdict.text
  }
  const last = attempts[attempts.length - 1]
  if (last === undefined) throw new Error('unreachable: cascade ran zero tiers')
  return { topology: 'cascade', accepted: false, tier: last.tier, final: last.result, attempts }
}

/** An intent as the markdown header on member prompts (docs/05 §6.1); empty lists are left out. */
export function renderIntent(intent: Intent): string {
  const list = (title: string, items: string[] = []) =>
    items.length === 0 ? [] : [`${title}:`, ...items.map((item) => `- ${item}`)]
  return [
    '## Intent',
    `Purpose: ${intent.purpose}`,
    `End state (checkable): ${intent.endState}`,
    ...list('Constraints', intent.constraints),
    ...list('Preferences', intent.preferences),
  ].join('\n')
}

/** `prompt` under the intent header, or unchanged when there is no intent. */
export function withIntent(prompt: string, intent: Intent | undefined): string {
  return intent === undefined ? prompt : `${renderIntent(intent)}\n\n${prompt}`
}

/** Parse a numbered plan (`1. …` / `2) …`) into one prompt per subtask. */
export function parseNumberedPlan(text: string): string[] {
  const subtasks: string[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*\d+[.)]\s+(.+\S)\s*$/.exec(line)
    if (match?.[1] !== undefined) subtasks.push(match[1])
  }
  return subtasks
}

/** The team as a coordinator spec over N anonymous workers: what `/swarm` and `openswarm start "task"` run. */
export function coordinatorSpec(task: string, workerCount: number): CoordinatorSpec {
  return {
    topology: 'coordinator',
    coordinator: { name: 'coordinator' },
    workers: Array.from({ length: workerCount }, (_, i) => ({ name: `worker-${i + 1}` })),
    task,
  }
}

export async function runCoordinator(
  spec: CoordinatorSpec,
  run: RunMember,
  report: ReportProgress = () => {},
): Promise<CoordinatorResult> {
  if (spec.workers.length === 0) throw new Error('coordinator needs at least one worker')
  report(`planning with ${spec.coordinator.name}…`)
  const plan = await run(
    spec.coordinator,
    `Task:\n${spec.task}\n\nDecompose this task into independent subtasks, one per line, as a numbered list (1. …). Reply with only the list.`,
  )
  const prompts = parseNumberedPlan(plan.text)
  if (prompts.length === 0) throw new Error('coordinator produced no parseable numbered subtasks')
  report(`plan: ${prompts.length} subtask(s) across ${spec.workers.length} worker(s)`)
  let settled = 0
  const subtasks = await Promise.all(
    prompts.map(async (prompt, i) => {
      const worker = spec.workers[i % spec.workers.length]!
      const result = await run(worker, prompt, `subtask-${i}`)
      // Subtasks settle out of order; count completions rather than index.
      report(`[${++settled}/${prompts.length}] ${worker.name}: ${prompt}`)
      return { prompt, worker: worker.name, result }
    }),
  )
  const dossier = subtasks
    .map((s) => `--- Subtask: ${s.prompt} (by ${s.worker}) ---\n${s.result.text}`)
    .join('\n\n')
  report(`synthesizing with ${spec.coordinator.name}…`)
  const synthesis = await run(
    spec.coordinator,
    `Task:\n${spec.task}\n\nSubtask results:\n\n${dossier}\n\nSynthesize the final deliverable for the task.`,
  )
  return { topology: 'coordinator', plan, subtasks, synthesis }
}

/** Seed the board from spec tasks; `blockedBy` indices resolve to created ids. */
export async function seedBoard(board: SwarmBoard, tasks: PeerTeamSpec['tasks']): Promise<string[]> {
  const created: string[] = []
  for (const task of tasks) {
    const blockedBy = (task.blockedBy ?? []).map((i) => {
      const id = created[i]
      if (id === undefined) throw new Error(`peer task blockedBy index ${i} does not precede it`)
      return id
    })
    created.push(
      (
        await board.create({
          subject: task.subject,
          prompt: task.prompt,
          blockedBy,
          intent: task.intent,
          checks: task.checks,
          minLevel: task.minLevel,
          suite: task.suite,
        })
      ).id,
    )
  }
  return created
}

/**
 * Run one claimed board task for a member. `prompt` defaults to the task's
 * own; a gate sending the work back passes its continuation instead. Either
 * way the path frames it as usual (intent header included).
 */
export type RunClaim = (member: MemberSpec, claimed: SwarmTaskSnapshot, prompt?: string) => Promise<MemberRunResult>

/**
 * A gated team's completion gate (docs/05 B6b), as `runBoardWorkers` applies
 * it to each claim. The execution path supplies `tree`: where the claim's
 * work lands, its reviewer when review mode can run there, a rollback only
 * when that tree is the gate's own (a worktree), never the user's, and `pin`
 * when verification paths are pinned there.
 */
export interface BoardGate {
  /** Agent rounds per attempt (default 4). */
  rounds?: number
  /** The team's checks; a task's own replace them. None → review mode. */
  checks?: readonly string[]
  /** The team's verifier level; a task's own replaces it (docs/05 B1). */
  minLevel?: VerifierLevel
  /** The run's: a cancelled run starts no further gate round. */
  signal?: AbortSignal
  tree: (
    member: MemberSpec,
    claimed: SwarmTaskSnapshot,
  ) => Pick<GateDeps, 'cwd' | 'review' | 'rollback' | 'hidden'> & {
    /** After each member round, before the gate measures it: restore the pinned paths, so no round passes by editing them. */
    pin?: () => Promise<void>
  }
}

/** A gate round as the evidence a board task closes on. */
function evidenceOf(round: GateRound): TaskEvidence {
  const e = round.evidence
  return {
    kind: e.kind,
    level: e.level,
    passed: e.passed,
    round: round.round,
    ...verdictFields(e),
    ...(e.enforcement === undefined ? {} : { enforcement: e.enforcement }),
    snapshot: round.snapshot,
  }
}

/** What a piece of gate evidence says, in the fields the journal keeps. */
function verdictFields(e: GateEvidence) {
  return {
    ...(e.score === undefined ? {} : { score: e.score }),
    ...(e.targets === undefined ? {} : { targets: targetStatuses(e.targets) }),
    ...(e.failedCommands === undefined ? {} : { failedCommands: e.failedCommands }),
    ...(e.suite === undefined ? {} : { suite: e.suite }),
    ...(e.total === undefined ? {} : { total: e.total, failed: e.failed }),
    ...(e.refused === undefined ? {} : { refused: e.refused }),
  }
}

/**
 * Work-stealing fan-out over a seeded board: every member loops
 * claim-next-ready → run → complete until all seeded tasks are done. Shared by
 * the three peer-team execution modes. On any member's failure, the claim is
 * released (so the board is never left with a stuck in_progress task) and every
 * member's loop is signalled to stop before the error is rethrown — without
 * this, a single failure leaves sibling loops busy-polling forever.
 *
 * With a `gate`, a claim runs through the completion gate instead of once,
 * and completes only on passing evidence. Work that never passes is a failed
 * attempt, not a failed member: the task is released for another attempt and
 * the member stays in the pool. Out of attempts, a person may accept it.
 */
export async function runBoardWorkers(
  members: MemberSpec[],
  board: SwarmBoard,
  seeded: Set<string>,
  runClaim: RunClaim,
  report: ReportProgress = () => {},
  maxTaskAttempts = 2,
  ask: AskQuestion = unattended,
  gate?: BoardGate,
): Promise<Record<string, MemberRunResult>> {
  const runs: Record<string, MemberRunResult> = {}
  const attempts = new Map<string, number>()
  /** Attempts granted past `maxTaskAttempts` by a 'retry' answer. */
  const extra = new Map<string, number>()
  /** Tasks no member will finish, with the failure that condemned them. */
  const abandoned = new Map<string, string>()
  /** Members still in the pool; one that fails leaves it. */
  let active = members.length
  let settled = 0

  /**
   * Abandon a task and everything transitively waiting on it — a dependent of
   * a task that will never complete can never become ready, and leaving it
   * pending would park the remaining members forever.
   */
  const abandon = (id: string, reason: string): void => {
    if (abandoned.has(id)) return
    abandoned.set(id, reason)
    for (const task of board.list()) {
      if (seeded.has(task.id) && task.blockedBy.includes(id)) {
        abandon(task.id, `blocked by abandoned task ${id}`)
      }
    }
  }

  const done = () =>
    board
      .list()
      .every((t) => !seeded.has(t.id) || t.status === 'completed' || abandoned.has(t.id))

  await Promise.all(
    members.map(async (member) => {
      while (!done()) {
        // An abandoned task is released to pending, but never run again.
        const claimed = await board.claimNextReady(member.name, (task) => abandoned.has(task.id))
        if (claimed === undefined) {
          // Nothing ready: blockers are still in flight with other members.
          // Park until a sibling commits (or a short backstop elapses) rather
          // than spinning; the backstop also re-checks the exit conditions.
          await board.waitForChange()
          continue
        }
        try {
          report(`${member.name} claimed: ${claimed.subject}`)
          const closed = (result: MemberRunResult, evidence?: TaskEvidence) => {
            runs[claimed.id] = result
            report(`[${++settled}/${seeded.size}] ${member.name}: ${claimed.subject}`)
            return board.complete(claimed.id, member.name, claimed.revision, result.text, evidence)
          }
          if (gate === undefined) {
            await closed(await runClaim(member, claimed))
            continue
          }
          const { pin, ...tree } = gate.tree(member, claimed)
          const gated = await runGate(
            {
              task: claimed.prompt,
              member,
              ...(gate.rounds === undefined ? {} : { maxRounds: gate.rounds }),
              commands: [...(claimed.checks ?? gate.checks ?? [])],
              ...((claimed.minLevel ?? gate.minLevel) === undefined ? {} : { minLevel: claimed.minLevel ?? gate.minLevel }),
            },
            {
              ...tree,
              ...(gate.signal === undefined ? {} : { signal: gate.signal }),
              // Round 1's prompt is the task's own, so it runs exactly as ungated.
              run: async (m, prompt) => {
                const result = await runClaim(m, claimed, prompt)
                await pin?.()
                return result
              },
              report,
              record: async ({ round, changed, evidence: e, rolledBack, snapshot, feedback: f, advisory }) => {
                await board.recordGate({
                  taskId: claimed.id,
                  member: member.name,
                  round,
                  changed,
                  kind: e.kind,
                  level: e.level,
                  passed: e.passed,
                  ...verdictFields(e),
                  ...(e.enforcement === undefined ? {} : { enforcement: e.enforcement }),
                  ...(e.tamper === undefined ? {} : { tamper: true }),
                  ...(f === undefined || f.kind === 'hidden'
                    ? {}
                    : {
                        feedback: {
                          kind: f.kind,
                          level: f.kind === 'review' ? 1 : 2,
                          passed: f.passed,
                          ...(f.score === undefined ? {} : { score: f.score }),
                          ...(f.failedCommands === undefined ? {} : { failedCommands: f.failedCommands }),
                        },
                      }),
                  ...(rolledBack === true ? { rolledBack } : {}),
                  ...(e.error === undefined ? {} : { error: e.error }),
                  snapshot,
                })
                const signals = e.tamper ?? advisory
                if (signals !== undefined) {
                  await board.recordTamper({
                    taskId: claimed.id,
                    member: member.name,
                    round,
                    suite: e.suite ?? '',
                    severity: e.tamper === undefined ? 'advisory' : 'incident',
                    signals,
                  })
                }
              },
            },
          )
          if (gated.accepted) {
            await closed(gated.final, evidenceOf(gated.rounds.at(-1)!))
            continue
          }
          if (gated.reason === 'tamper') {
            // An owner decides, not a default retry: the member reached for the
            // hidden suite (docs/05 §6.4). Asked while the claim holds. Unless
            // someone says continue, the task and its dependents are abandoned.
            const signals = gated.rounds.at(-1)!.evidence.tamper ?? []
            const answer = await ask({
              trigger: 'tamper',
              kind: 'escalation',
              tier: 'high',
              prompt: `task ${claimed.id} "${claimed.subject}": ${member.name} reached for the hidden suite in gate round ${gated.rounds.length} (${[...new Set(signals.map((t) => `${t.signal} in ${t.where}`))].join(', ')}). Abandon the task and its dependents, or continue as a failed attempt?`,
              options: ['abandon', 'continue'],
              default: 'abandon',
            }).catch(() => 'abandon')
            if (answer !== 'continue') {
              abandon(claimed.id, `tamper incident in gate round ${gated.rounds.length}`)
              report(`task "${claimed.subject}" abandoned: tamper incident`)
              await board.release(claimed.id, member.name, claimed.revision).catch(() => undefined)
              continue
            }
          }
          // Not accepted: a failed attempt, but the member is healthy, so it
          // stays in the pool (the catch below is for members that break).
          const why =
            gated.reason === undefined
              ? `not accepted after ${gated.rounds.length} gate round(s)`
              : gated.reason === 'tamper'
                ? `tamper incident in gate round ${gated.rounds.length}`
                : `${gated.reason}: ${head(gated.rounds.at(-1)?.evidence.error ?? '')}`
          const attempt = (attempts.get(claimed.id) ?? 0) + 1
          attempts.set(claimed.id, attempt)
          if (attempt >= maxTaskAttempts + (extra.get(claimed.id) ?? 0)) {
            // Asked while the claim holds, so no sibling starts it meanwhile.
            // Accepting closes it without passing evidence, which only a person
            // who answered may do (P8): a default or an ask that fails never does.
            let by: string | undefined
            const answer = await ask(
              {
                trigger: 'verifier-failure',
                kind: 'approval',
                prompt: `task ${claimed.id} "${claimed.subject}" did not pass its gate in ${attempt} attempt(s), last on ${member.name}: ${why}. Accept it without passing evidence, or abandon it and its dependents?`,
                options: ['abandon', 'accept'],
                default: 'abandon',
              },
              (question) => (by = question.by),
            ).catch(() => 'abandon')
            if (answer === 'accept' && by !== undefined) {
              await closed(gated.final, { kind: 'human', passed: true, by })
              continue
            }
            abandon(claimed.id, why)
            report(`task "${claimed.subject}" abandoned after ${attempt} attempt(s): ${why}`)
          } else {
            report(`${member.name}: "${claimed.subject}" did not pass its gate (attempt ${attempt}): ${why}`)
          }
          await board.release(claimed.id, member.name, claimed.revision).catch(() => undefined)
        } catch (error) {
          // This member leaves the pool below, whatever else happens.
          active--
          const reason = error instanceof Error ? error.message : String(error)
          const attempt = (attempts.get(claimed.id) ?? 0) + 1
          attempts.set(claimed.id, attempt)
          const allowed = maxTaskAttempts + (extra.get(claimed.id) ?? 0)
          // Out of attempts: ask, if a sibling remains to take a retry, while
          // the claim still holds, so none starts a task that may be abandoned.
          // An ask that fails is no answer.
          const retry =
            attempt >= allowed &&
            active > 0 &&
            (await ask({
              trigger: 'task-attempts',
              prompt: `task "${claimed.subject}" failed ${attempt} of ${allowed} allowed attempt(s), last on ${member.name}: ${head(reason)}. Retry it once more on a sibling, or abandon it and its dependents?`,
              options: ['abandon', 'retry'],
              default: 'abandon',
            }).catch(() => 'abandon')) === 'retry'
          if (retry) extra.set(claimed.id, (extra.get(claimed.id) ?? 0) + 1)
          if (attempt >= allowed && !retry) {
            // Retried enough. Condemning it stops a poison task from taking
            // the roster down one member at a time; condemned before the
            // release, so no sibling that wakes on it claims it again.
            abandon(claimed.id, reason)
            report(`task "${claimed.subject}" abandoned after ${attempt} attempt(s): ${reason}`)
          } else {
            report(`${member.name} failed "${claimed.subject}" (attempt ${attempt}): ${reason}`)
          }
          // Then release: a claim left in_progress is unreclaimable, and a
          // sibling retrying this task is the whole point.
          await board.release(claimed.id, member.name, claimed.revision).catch(() => undefined)
          // Presume THIS member is the casualty and leave the pool; a healthy
          // sibling picks the task up. A member that was merely unlucky is
          // recovered by the caller's own respawn, not here.
          return
        }
      }
    }),
  )

  // Members exhausted with work outstanding: nothing will run it now.
  for (const task of board.list()) {
    if (seeded.has(task.id) && task.status !== 'completed') {
      abandon(task.id, 'no members left to run it')
    }
  }

  if (abandoned.size > 0) {
    const detail = [...abandoned.entries()].map(([id, why]) => `${id}: ${why}`).join('; ')
    throw new Error(`swarm board abandoned ${abandoned.size} task(s) — ${detail}`)
  }
  return runs
}

export async function runPeerTeam(
  spec: PeerTeamSpec,
  run: RunMember,
  board: SwarmBoard,
  report: ReportProgress = () => {},
  ask: AskQuestion = unattended,
  gate?: BoardGate,
): Promise<PeerTeamResult> {
  if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
  const seeded = new Set(await seedBoard(board, spec.tasks))
  report(`peer-team: ${seeded.size} task(s) across ${spec.members.length} member(s)`)
  const runs = await runBoardWorkers(
    spec.members,
    board,
    seeded,
    (member, claimed, prompt = claimed.prompt) => run(member, prompt, claimed.id),
    report,
    spec.maxTaskAttempts,
    ask,
    gate,
  )
  const tasks = board.list().filter((t) => seeded.has(t.id))
  return { topology: 'peer-team', tasks, runs }
}
