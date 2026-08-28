/**
 * Topology implementations, parameterized by a member-run callback so they
 * stay pure coordination logic over whatever runtime the service wires in.
 */
import type { SwarmBoard } from './board'
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

/** Weakest-link command confidence: 1 when every command exits 0, else 0. */
export type RunConfidence = (commands: string[]) => Promise<number>

/**
 * One human-readable progress line from a running team. Only `coordinator`
 * emits today — it is what `/swarm` drives; other topologies report nothing
 * and their consumers see the final result as before.
 */
export type ReportProgress = (line: string) => void

export async function runFanout(spec: FanoutSpec, run: RunMember): Promise<FanoutResult> {
  const byName = new Map(spec.members.map((m) => [m.name, m]))
  if (byName.size !== spec.members.length) throw new Error('duplicate member name in team spec')
  const results = await Promise.all(
    spec.tasks.map((task, i) => {
      const member = byName.get(task.member)
      if (member === undefined) throw new Error(`fanout task names unknown member "${task.member}"`)
      return run(member, task.prompt, `task-${i}`)
    }),
  )
  return { topology: 'fanout', results }
}

const DEFAULT_MAX_ROUNDS = 3

export async function runCriticLoop(spec: CriticLoopSpec, run: RunMember): Promise<CriticLoopResult> {
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
    const draft = await run(spec.worker, workerPrompt, 'task')
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

export async function runCommittee(spec: CommitteeSpec, run: RunMember): Promise<CommitteeResult> {
  const answers = await Promise.all(spec.members.map((m) => run(m, spec.task, `answer-${m.name}`)))
  if (spec.judge === undefined) return { topology: 'committee', answers }
  const dossier = answers
    .map((a) => `--- Answer from ${a.member} ---\n${a.text}`)
    .join('\n\n')
  const synthesis = await run(
    spec.judge,
    `Task:\n${spec.task}\n\nIndependent answers:\n\n${dossier}\n\nSynthesize the best single answer, drawing on the strongest points of each.`,
  )
  return { topology: 'committee', answers, synthesis }
}

export async function runPipeline(spec: PipelineSpec, run: RunMember): Promise<PipelineResult> {
  if (spec.stages.length === 0) throw new Error('pipeline needs at least one stage')
  const stages: MemberRunResult[] = []
  let carry: string | undefined
  for (const stage of spec.stages) {
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
): Promise<CascadeResult> {
  if (spec.tiers.length === 0) throw new Error('cascade needs at least one tier')
  if (spec.confidence !== undefined && runConfidence === undefined) {
    throw new Error('cascade confidence gate requires a confidence runner')
  }
  const attempts: CascadeResult['attempts'] = []
  let feedback: string | undefined
  for (let tier = 0; tier < spec.tiers.length; tier++) {
    const member = spec.tiers[tier]!
    const prompt =
      feedback === undefined
        ? spec.task
        : `${spec.task}\n\nA previous attempt was rejected with this feedback:\n${feedback}`
    const result = await run(member, prompt, 'task')
    if (result.stopReason !== 'completed') {
      attempts.push({ tier, result })
      continue
    }
    if (spec.confidence !== undefined) {
      const confidence = await runConfidence!(spec.confidence.commands)
      attempts.push({ tier, result, confidence })
      if (confidence >= spec.confidence.tau) {
        return { topology: 'cascade', accepted: true, tier, final: result, attempts }
      }
      feedback = `automated confidence ${confidence} was below the required threshold ${spec.confidence.tau}; the verification commands did not pass`
      continue
    }
    if (spec.gate === undefined) {
      attempts.push({ tier, result })
      return { topology: 'cascade', accepted: true, tier, final: result, attempts }
    }
    const verdict = await run(
      spec.gate,
      `Task:\n${spec.task}\n\nCandidate result:\n${result.text}\n\nReply with exactly APPROVED if the result fully satisfies the task; otherwise reply REVISE: <specific feedback>.`,
      'task',
    )
    attempts.push({ tier, result, verdict })
    if (isApproved(verdict.text)) {
      return { topology: 'cascade', accepted: true, tier, final: result, attempts }
    }
    feedback = verdict.text
  }
  const last = attempts[attempts.length - 1]
  if (last === undefined) throw new Error('unreachable: cascade ran zero tiers')
  return { topology: 'cascade', accepted: false, tier: last.tier, final: last.result, attempts }
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
    created.push((await board.create({ subject: task.subject, prompt: task.prompt, blockedBy })).id)
  }
  return created
}

/** Run one claimed board task for a member. */
export type RunClaim = (
  member: MemberSpec,
  claimed: import('./board').SwarmTaskSnapshot,
) => Promise<MemberRunResult>

/**
 * Work-stealing fan-out over a seeded board: every member loops
 * claim-next-ready → run → complete until all seeded tasks are done. Shared by
 * the three peer-team execution modes. On any member's failure, the claim is
 * released (so the board is never left with a stuck in_progress task) and every
 * member's loop is signalled to stop before the error is rethrown — without
 * this, a single failure leaves sibling loops busy-polling forever.
 */
export async function runBoardWorkers(
  members: MemberSpec[],
  board: SwarmBoard,
  seeded: Set<string>,
  runClaim: RunClaim,
): Promise<Record<string, MemberRunResult>> {
  const runs: Record<string, MemberRunResult> = {}
  let aborted: unknown
  const boardDone = () => board.list().every((t) => !seeded.has(t.id) || t.status === 'completed')
  await Promise.all(
    members.map(async (member) => {
      while (aborted === undefined && !boardDone()) {
        const claimed = await board.claimNextReady(member.name)
        if (claimed === undefined) {
          // Nothing ready: blockers are still in flight with other members.
          // ponytail: 10ms poll; the board grows waitForChange out of process.
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        try {
          const result = await runClaim(member, claimed)
          runs[claimed.id] = result
          await board.complete(claimed.id, member.name, claimed.revision, result.text)
        } catch (error) {
          aborted ??= error
          // Release the claim so the board isn't stuck in_progress; siblings see
          // `aborted` and exit their loops.
          await board.release(claimed.id, member.name, claimed.revision).catch(() => undefined)
          return
        }
      }
    }),
  )
  if (aborted !== undefined) throw aborted
  return runs
}

export async function runPeerTeam(
  spec: PeerTeamSpec,
  run: RunMember,
  board: SwarmBoard,
): Promise<PeerTeamResult> {
  if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
  const seeded = new Set(await seedBoard(board, spec.tasks))
  const runs = await runBoardWorkers(spec.members, board, seeded, (member, claimed) =>
    run(member, claimed.prompt, claimed.id),
  )
  const tasks = board.list().filter((t) => seeded.has(t.id))
  return { topology: 'peer-team', tasks, runs }
}
