/**
 * Reviewer-facing landing evidence (docs/05 §6.4, B4). Each landed or
 * ejected entry gets a small bundle folded from the journals, without asking
 * any member anything: the task's intent header, its diff against the tip it
 * landed on, the verifier levels it reached and what they said (levels,
 * counts and command names; never a hidden suite's content, nor a check's
 * output), its cost, the questions raised about it and who answered them,
 * and the repairs and resolvers it went through. A deterministic risk tier
 * orders the landing queue, so review, the scarce resource, goes where it is
 * needed first.
 *
 * The train journals a bundle as `train/evidence` as an entry lands or is
 * ejected, and, when a failing baseline sent the entries through the
 * sequential queue instead, for each it merged unverified or left conflicted.
 * Without the train, finalize journals one per merged or conflicted task as
 * `swarm/evidence` in the run's journal (its verifier: the gate's evidence
 * only). A messaging team's member usage is not journaled, so its bundles
 * carry no cost rather than a partial one. Scopes wait for C4 (deferred by
 * D18), so there is no diff-against-scope yet.
 */
import { join } from 'node:path'
import { effectiveLevel, evidenceText, foldBoard, type SwarmTamperEvent, type TaskEvidence } from './board'
import type { VerifierLevel } from './gate'
import { SwarmJournal, type SwarmJournalEvent } from './journal'
import { addUsage, count, duration, emptyUsage, priced, tokensOf, usageUnmeasured, type Pricing, type SwarmUsageEvent, type Usage, type UsageRole } from './metrics'
import { foldQuestions, foldRun } from './run'
import { trainVerdictText, type TrainEvents, type TrainVerdict } from './train'
import type { Intent } from './types'

/** What a branch changes: the files, and lines added and removed. */
export interface DiffSummary {
  files: string[]
  insertions: number
  deletions: number
}

/** `high` sorts first: a waiver, a partly enforced L3, a tamper sign, a repair or resolver, an unverified merge, a conflict, or below L2. */
export type RiskTier = 'high' | 'medium' | 'low'

/** Where and how an entry landed, was ejected, or conflicted in the queue: what the lander knows that the journals do not. */
export interface LandingAt {
  key: string
  /** `conflicted`: the sequential queue could not merge it; its branch is kept. */
  outcome: 'landed' | 'ejected' | 'conflicted'
  via: 'train' | 'queue'
  /** The queue merged (or tried) it because the train's baseline already failed: nothing verified the integrated tree. */
  unverified?: true
  branch: string
  /** The tip it landed on (the train's batch tip, the queue's base); an ejected entry's, the target's tip then. */
  base: string
  at: number
  /** The train's batch that landed it, and the commit the target moved to. */
  batch?: number
  commit?: string
  /** Why it was ejected. */
  reason?: string
  /** Undefined when git could not say. */
  diff?: DiffSummary
}

/** Payload of a `train/evidence` (or, without the train, `swarm/evidence`) journal event. */
export interface LandingEvidence extends LandingAt {
  version: 1
  subject?: string
  /** The task's intent header, else the run's. */
  intent?: Intent
  /** The strongest passing verifier's level: the gate's, or the train's batch (an L3 partly enforced counts as L2). */
  level: VerifierLevel
  /** What the task closed on at its gate, and how many gate rounds it took. */
  gate?: TaskEvidence
  gateRounds: number
  /** The train's verification of the batch that landed it, or the last one it failed. */
  train?: Omit<TrainVerdict, 'output'> & { batch: number }
  /** Usage of its member runs, reviews, repairs and resolvers, dollars priced when read; null where it is not measured, `unmeasured` saying why. */
  cost: { tokens: number; byRole: Partial<Record<UsageRole, number>>; byModel: Record<string, Usage> } | null
  unmeasured?: string
  questions: { id: string; trigger: string; status: string; answer?: string; by?: string; raisedAt: number; closedAt?: number }[]
  steps: { step: 'repair' | 'resolve'; member?: string; attempt?: number; outcome: string }[]
  tamper: { step: 'gate' | 'repair' | 'resolve'; severity: 'incident' | 'advisory'; signals: string[] }[]
  risk: RiskTier
  /** Why it is high risk; empty otherwise. */
  why: string[]
}

/** The bundle for one landing, from the run's journal and the train's. */
export function buildEvidence(landing: LandingAt, runEvents: readonly SwarmJournalEvent[], trainEvents: readonly SwarmJournalEvent[]): LandingEvidence {
  const { key } = landing
  const task = foldBoard(runEvents).get(key)
  const run = foldRun(runEvents)
  const intent = task?.intent ?? run?.spec?.intent
  const unmeasured = usageUnmeasured(run)
  const gate = task?.evidence
  const signals = (list: readonly { signal: string; where: string }[]) => [...new Set(list.map((s) => `${s.signal} in ${s.where}`))]

  let gateRounds = 0
  const tamper: LandingEvidence['tamper'] = []
  const cost = { tokens: 0, byRole: {} as Partial<Record<UsageRole, number>>, byModel: {} as Record<string, Usage> }
  for (const { type, data } of runEvents) {
    if (type === 'swarm/gate' && (data as { taskId: string }).taskId === key) gateRounds++
    else if (type === 'swarm/tamper' && (data as SwarmTamperEvent).taskId === key) {
      const t = data as SwarmTamperEvent
      tamper.push({ step: 'gate', severity: t.severity ?? 'incident', signals: signals(t.signals) })
    } else if (type === 'swarm/usage' && (data as SwarmUsageEvent).taskKey === key) {
      const u = data as SwarmUsageEvent
      cost.tokens += tokensOf(u.usage)
      cost.byRole[u.role] = (cost.byRole[u.role] ?? 0) + tokensOf(u.usage)
      addUsage((cost.byModel[u.model ?? 'unknown'] ??= emptyUsage()), u.usage)
    }
  }

  let verdict: TrainEvents['train/verified'] | undefined
  const steps: LandingEvidence['steps'] = []
  for (const { type, data } of trainEvents) {
    if (type === 'train/verified') {
      const v = data as TrainEvents['train/verified']
      if (landing.batch === undefined ? v.entries.includes(key) : v.batch === landing.batch) verdict = v
    } else if (type === 'train/repair' && (data as { key: string }).key === key) {
      const r = data as TrainEvents['train/repair']
      steps.push({ step: 'repair', member: r.member, attempt: r.attempt, outcome: r.outcome })
    } else if (type === 'train/resolve' && (data as { key: string }).key === key) {
      const r = data as TrainEvents['train/resolve']
      steps.push({ step: 'resolve', ...(r.member === undefined ? {} : { member: r.member }), outcome: r.outcome })
    } else if (type === 'train/tamper' && (data as { key: string }).key === key) {
      const t = data as TrainEvents['train/tamper']
      tamper.push({ step: t.step, severity: t.severity, signals: signals(t.signals) })
    }
  }
  // Never a check's output: under L3 it is feedback beside the suite, and a reviewer reads the command.
  const train =
    verdict === undefined
      ? undefined
      : (({ version: _v, output: _o, commit: _c, entries: _e, ...rest }) => rest)(verdict)

  const questions = [...foldQuestions(runEvents).values()]
    .filter((q) => q.taskId === key)
    .map((q) => ({
      id: q.id,
      trigger: q.trigger,
      status: q.status,
      ...(q.answer === undefined ? {} : { answer: q.answer }),
      ...(q.by === undefined ? {} : { by: q.by }),
      raisedAt: q.raisedAt,
      ...(q.closedAt === undefined ? {} : { closedAt: q.closedAt }),
    }))

  const level = Math.max(
    gate !== undefined && gate.passed && gate.kind !== 'human' ? effectiveLevel(gate) : 0,
    train?.passed === true ? (train.level === 3 && train.enforcement === 'partial' ? 2 : train.level) : 0,
  ) as VerifierLevel
  const why: string[] = []
  if (gate?.kind === 'human') why.push(`gate waived by ${gate.by}`)
  if (gate?.enforcement === 'partial' || train?.enforcement === 'partial') why.push('L3 only partly enforced')
  for (const t of tamper) why.push(`tamper ${t.severity} in its ${t.step}`)
  if (steps.some((s) => s.step === 'repair')) why.push('repaired')
  if (steps.some((s) => s.step === 'resolve')) why.push('went to the resolver')
  if (landing.unverified === true) why.push('merged unverified')
  if (landing.outcome === 'conflicted') why.push('conflicted in the queue')
  if (level < 2) why.push(`verified only to L${level}`)

  return {
    version: 1,
    ...landing,
    ...(task === undefined ? {} : { subject: task.subject }),
    ...(intent === undefined ? {} : { intent }),
    level,
    ...(gate === undefined ? {} : { gate }),
    gateRounds,
    ...(train === undefined ? {} : { train }),
    cost: unmeasured === undefined ? cost : null,
    ...(unmeasured === undefined ? {} : { unmeasured }),
    questions,
    steps,
    tamper,
    risk: why.length > 0 ? 'high' : level >= 3 ? 'low' : 'medium',
    why: [...new Set(why)],
  }
}

const RANK: Record<RiskTier, number> = { high: 0, medium: 1, low: 2 }

/** The landing queue (docs/05 §6.1): every bundle the journals hold, by risk tier, then oldest first. */
export function landingsOf(runEvents: readonly SwarmJournalEvent[], trainEvents: readonly SwarmJournalEvent[]): LandingEvidence[] {
  return [...trainEvents.filter((e) => e.type === 'train/evidence'), ...runEvents.filter((e) => e.type === 'swarm/evidence')]
    .map((e) => e.data as LandingEvidence)
    .sort((a, b) => RANK[a.risk] - RANK[b.risk] || a.at - b.at)
}

/** {@link landingsOf} over the journals in a run's directory (`<runs>/<run id>`). */
export function runLandings(runDir: string): LandingEvidence[] {
  return landingsOf(SwarmJournal.read(join(runDir, 'journal.jsonl')), SwarmJournal.read(join(runDir, 'train.jsonl')))
}

/** One landing as a compact block of lines, its first the tier and the entry; what `openswarm landings` and the Swarm tab show. */
export function landingText(e: LandingEvidence, pricing?: Pricing): string[] {
  const first = (text: string) => {
    const line = text.split('\n')[0]!
    return line.length > 100 ? `${line.slice(0, 99)}…` : line
  }
  const where =
    e.outcome === 'ejected'
      ? `branch ${e.branch} kept: ${first(e.reason ?? '')}`
      : e.outcome === 'conflicted'
        ? `queue, branch ${e.branch} kept`
        : e.via === 'train'
          ? `train batch ${e.batch}, ${e.commit?.slice(0, 8)}`
          : `queue${e.unverified === true ? ' unverified' : ''}, branch ${e.branch}`
  const lines = [`${e.risk.toUpperCase().padEnd(6)} ${e.key} ${e.outcome} (${where})${e.subject === undefined ? '' : ` — ${first(e.subject)}`}`]
  if (e.why.length > 0) lines.push(`why: ${e.why.join('; ')}`)
  if (e.intent !== undefined) lines.push(`intent: ${first(e.intent.purpose)} — end state: ${first(e.intent.endState)}`)
  const d = e.diff
  const files = d === undefined ? '' : `${d.files.slice(0, 5).join(', ')}${d.files.length > 5 ? `, +${d.files.length - 5} more` : ''}`
  lines.push(`diff on ${e.base.slice(0, 8)}: ${d === undefined ? 'unavailable' : `${d.files.length} file(s), +${d.insertions} −${d.deletions}${files === '' ? '' : `: ${files}`}`}`)
  const gate = e.gate === undefined ? 'none' : e.gate.kind === 'human' ? `waived by ${e.gate.by}` : `${evidenceText(e.gate)} ${e.gate.passed ? 'passed' : 'not passed'}`
  const train = e.train === undefined ? '' : `; train batch ${e.train.batch}: ${trainVerdictText(e.train)}`
  lines.push(`verified: L${e.level} (gate: ${gate}, ${e.gateRounds} round(s)${train})`)
  if (e.cost === null) lines.push(`cost: — ${e.unmeasured}`)
  else {
    const usd = priced(e.cost.byModel, pricing)
    const roles = Object.entries(e.cost.byRole).map(([role, n]) => `${role} ${count(n)}`)
    lines.push(`cost: ${count(e.cost.tokens)} tokens${roles.length === 0 ? '' : ` (${roles.join(', ')})`}${typeof usd === 'number' && e.cost.tokens > 0 ? `, $${usd.toFixed(2)}` : ''}`)
  }
  if (e.questions.length > 0) {
    const asked = e.questions.map((q) => {
      const closed = q.closedAt === undefined ? '' : ` after ${duration(q.closedAt - q.raisedAt)}`
      return `${q.id} ${q.trigger}: ${q.status === 'open' ? 'open' : `${q.answer} (${q.status === 'answered' ? `answered by ${q.by}` : q.status}${closed})`}`
    })
    lines.push(`questions: ${asked.join('; ')}`)
  }
  if (e.steps.length > 0) {
    const steps = e.steps.map((s) => `${s.step === 'repair' ? `repair ${s.attempt}` : 'resolver'}${s.member === undefined ? '' : ` by ${s.member}`}: ${s.outcome}`)
    lines.push(`steps: ${steps.join('; ')}`)
  }
  for (const t of e.tamper) lines.push(`tamper ${t.severity} in its ${t.step}: ${t.signals.join(', ')}`)
  return [lines[0]!, ...lines.slice(1).map((line) => `       ${line}`)]
}
