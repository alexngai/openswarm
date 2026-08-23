/**
 * Topology implementations, parameterized by a member-run callback so they
 * stay pure coordination logic over whatever runtime the service wires in.
 */
import type { SwarmBoard } from './board'
import type {
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

export type RunMember = (member: MemberSpec, prompt: string) => Promise<MemberRunResult>

/** Critic/gate verdict protocol: `APPROVED` approves; anything else is feedback. */
export function isApproved(verdict: string): boolean {
  return /^\s*APPROVED\b/i.test(verdict)
}

export async function runCommittee(spec: CommitteeSpec, run: RunMember): Promise<CommitteeResult> {
  const answers = await Promise.all(spec.members.map((m) => run(m, spec.task)))
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
    const result = await run(stage.member, prompt)
    stages.push(result)
    carry = result.text
  }
  const final = stages[stages.length - 1]
  if (final === undefined) throw new Error('unreachable: pipeline ran zero stages')
  return { topology: 'pipeline', stages, final }
}

export async function runCascade(spec: CascadeSpec, run: RunMember): Promise<CascadeResult> {
  if (spec.tiers.length === 0) throw new Error('cascade needs at least one tier')
  const attempts: CascadeResult['attempts'] = []
  let feedback: string | undefined
  for (let tier = 0; tier < spec.tiers.length; tier++) {
    const member = spec.tiers[tier]!
    const prompt =
      feedback === undefined
        ? spec.task
        : `${spec.task}\n\nA previous attempt was rejected with this feedback:\n${feedback}`
    const result = await run(member, prompt)
    if (result.stopReason !== 'completed') {
      attempts.push({ tier, result })
      continue
    }
    if (spec.gate === undefined) {
      attempts.push({ tier, result })
      return { topology: 'cascade', accepted: true, tier, final: result, attempts }
    }
    const verdict = await run(
      spec.gate,
      `Task:\n${spec.task}\n\nCandidate result:\n${result.text}\n\nReply with exactly APPROVED if the result fully satisfies the task; otherwise reply REVISE: <specific feedback>.`,
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

export async function runCoordinator(spec: CoordinatorSpec, run: RunMember): Promise<CoordinatorResult> {
  if (spec.workers.length === 0) throw new Error('coordinator needs at least one worker')
  const plan = await run(
    spec.coordinator,
    `Task:\n${spec.task}\n\nDecompose this task into independent subtasks, one per line, as a numbered list (1. …). Reply with only the list.`,
  )
  const prompts = parseNumberedPlan(plan.text)
  if (prompts.length === 0) throw new Error('coordinator produced no parseable numbered subtasks')
  const subtasks = await Promise.all(
    prompts.map(async (prompt, i) => {
      const worker = spec.workers[i % spec.workers.length]!
      return { prompt, worker: worker.name, result: await run(worker, prompt) }
    }),
  )
  const dossier = subtasks
    .map((s) => `--- Subtask: ${s.prompt} (by ${s.worker}) ---\n${s.result.text}`)
    .join('\n\n')
  const synthesis = await run(
    spec.coordinator,
    `Task:\n${spec.task}\n\nSubtask results:\n\n${dossier}\n\nSynthesize the final deliverable for the task.`,
  )
  return { topology: 'coordinator', plan, subtasks, synthesis }
}

export async function runPeerTeam(
  spec: PeerTeamSpec,
  run: RunMember,
  board: SwarmBoard,
): Promise<PeerTeamResult> {
  if (spec.members.length === 0) throw new Error('peer-team needs at least one member')
  // Seed the board; blockedBy indices resolve against creation order.
  const created: string[] = []
  for (const task of spec.tasks) {
    const blockedBy = (task.blockedBy ?? []).map((i) => {
      const id = created[i]
      if (id === undefined) throw new Error(`peer task blockedBy index ${i} does not precede it`)
      return id
    })
    created.push((await board.create({ subject: task.subject, prompt: task.prompt, blockedBy })).id)
  }

  const runs: Record<string, MemberRunResult> = {}
  const seeded = new Set(created)
  const boardDone = () =>
    board.list().every((t) => !seeded.has(t.id) || t.status === 'completed')

  await Promise.all(
    spec.members.map(async (member) => {
      while (!boardDone()) {
        const claimed = await board.claimNextReady(member.name)
        if (claimed === undefined) {
          // Nothing ready: blockers are still in flight with other members.
          // ponytail: 10ms poll; the board grows waitForChange when it moves
          // out of process.
          await new Promise((r) => setTimeout(r, 10))
          continue
        }
        const result = await run(member, claimed.prompt)
        runs[claimed.id] = result
        await board.complete(claimed.id, member.name, claimed.revision, result.text)
      }
    }),
  )

  const tasks = board.list().filter((t) => seeded.has(t.id))
  return { topology: 'peer-team', tasks, runs }
}
