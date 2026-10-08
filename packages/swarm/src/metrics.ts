/**
 * RunMetrics (docs/05 §6.8, B5): one run's numbers, folded from its journal,
 * its train's journal and the usage its member runs journaled, so one fold
 * serves the run's result, `openswarm metrics`, `swarm/metrics` and an eval's
 * record. A row the journals cannot support yet is null, with why in
 * `unsupported`, never a 0 that reads as measured.
 *
 * Usage is journaled per member run (`swarm/usage`): an in-process member's
 * from this process's `session/event` stream, a worktree member's from the
 * session logs under its own session root, each with the model its messages
 * name. Messaging peers keep one session across many tasks and journal none
 * yet, so a messaging team's tokens are null even where the train's steps
 * journaled some; the lead's own turns are its session's, outside the run.
 * Dollars need a pricing table ($ per million tokens, by model) as
 * configuration (`SwarmConfig.pricing`, `--pricing`): there are no default
 * prices, so without one dollars are null.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MergeOutcome } from 'openswarm-git'
import { effectiveLevel, foldBoard, type SwarmTamperEvent } from './board'
import type { LandingEvidence } from './evidence'
import { SwarmJournal, type SwarmJournalEvent } from './journal'
import { foldQuestions, foldRun, type SwarmRunRecord } from './run'
import type { TrainEvents } from './train'

/** Model usage, in dsh's field names; `calls` counts assistant messages. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  calls: number
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 })

/** Every token a usage counts, cached ones included. */
export const tokensOf = (u: Usage): number => u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens

/** Add `u` to `total`, in place; returns `total`. */
export function addUsage(total: Usage, u: Usage): Usage {
  total.inputTokens += u.inputTokens
  total.outputTokens += u.outputTokens
  total.cacheReadTokens += u.cacheReadTokens
  total.cacheWriteTokens += u.cacheWriteTokens
  total.calls += u.calls
  return total
}

/** One `assistant/message` event's usage record as a Usage of one call. */
const messageUsage = (u: any): Usage => ({
  inputTokens: u?.inputTokens ?? 0,
  outputTokens: u?.outputTokens ?? 0,
  cacheReadTokens: u?.cacheReadTokens ?? 0,
  cacheWriteTokens: u?.cacheWriteTokens ?? 0,
  calls: 1,
})

/** What a member run was for: its task's own work, or coordination around it. */
export type UsageRole = 'task' | 'review' | 'repair' | 'resolve' | 'lead'

/** Payload of a `swarm/usage` journal event: one member run's model usage (docs/05 B5). */
export type SwarmUsageEvent = {
  version: 1
  member: string
  /** `lead`: a coordinator's plan or synthesis, a committee's judge; `review`: a gate reviewer, a critic, a cascade's gate. */
  role: UsageRole
  /** The task (worktree) key it ran for; none for a keyless run. */
  taskKey?: string
  /** `dsh:<provider>` in this process, `dsh:sdk` as a worktree subprocess. */
  runtime: string
  provider?: string
  model?: string
  runId: string
  usage: Usage
  startedAt: number
}

/** Journal one member run's usage; without a `role`, who the member is in the team decides it. */
export type RecordUsage = (record: Omit<SwarmUsageEvent, 'version' | 'role'> & { role?: UsageRole }) => Promise<void>

/** What one member run spent, and the route its messages name when they do. */
export interface Metered {
  usage: Usage
  provider?: string
  model?: string
}

/** One `assistant/message` event's data into `metered`, in place: its usage, and its route (the last named wins). */
function meter(metered: Metered, data: any): Metered {
  addUsage(metered.usage, messageUsage(data.usage))
  const source = data.message?.source
  if (typeof source?.provider === 'string') metered.provider = source.provider
  if (typeof source?.model === 'string') metered.model = source.model
  return metered
}

/**
 * Why a run's member usage cannot be read as measured, or undefined when it
 * can: a messaging team's peers journal none, so whatever else journaled
 * some (the train's repairs) is partial; a run from before B5 journaled none.
 */
export function usageUnmeasured(run: SwarmRunRecord | undefined): string | undefined {
  if (run?.spec?.topology === 'peer-team' && run.spec.messaging === true) return "messaging peers' usage is not journaled yet"
  if (run?.usageJournaled !== true) return 'the run predates usage records'
  return undefined
}

/** Payload of a `swarm/restart` journal event: a dead member restarted on its task. */
export type SwarmRestartEvent = { version: 1; member: string; taskId: string; restart: number }

/** $ per million tokens, by model id. Cached tokens are billed as input unless their own rate is given. */
export type Pricing = Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>

/** Dollars for usage by model, or why there are none: no table, or a model that spent tokens it does not price. */
export function priced(byModel: Readonly<Record<string, Usage>>, pricing?: Pricing): number | { reason: string } {
  if (pricing === undefined) return { reason: 'no pricing configured (SwarmConfig.pricing, or --pricing <file>)' }
  const spent = Object.entries(byModel).filter(([, u]) => tokensOf(u) > 0)
  const unpriced = spent.map(([model]) => model).filter((model) => !Object.hasOwn(pricing, model))
  if (unpriced.length > 0) return { reason: `no price for ${unpriced.join(', ')}` }
  let usd = 0
  for (const [model, u] of spent) {
    const p = pricing[model]!
    usd += (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * (p.cacheRead ?? p.input) + u.cacheWriteTokens * (p.cacheWrite ?? p.input)) / 1e6
  }
  return usd
}

/**
 * The usage in the session logs under `root`, and the route its messages
 * name: a worktree member's, which never reaches this process's events. A
 * blank or torn last line (a killed member) is skipped. ponytail: plain
 * `.jsonl` only; a `.jsonl.zstd` log (dsh's `compression: zstd`) is not read,
 * as members' compositions write `none`; decode it if one ever must count.
 */
export function usageFromLogs(root: string): Metered {
  const metered: Metered = { usage: emptyUsage() }
  let files: string[]
  try {
    files = readdirSync(root, { recursive: true, encoding: 'utf8' })
  } catch {
    return metered
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      // Most lines are tool traffic; parse only those that can be a message.
      if (!line.includes('"assistant/message"')) continue
      try {
        const event = JSON.parse(line)
        if (event?.type === 'assistant/message' && event.data?.usage !== undefined) meter(metered, event.data)
      } catch {}
    }
  }
  return metered
}

/**
 * In-process members' usage, per session, live off `session/event`; `take`
 * hands over a session's and forgets it. ponytail: sessions never taken (a
 * lead's, any other agent's in this process) keep five numbers each for the
 * recorder's life; forget them on session close if a process hosts very many.
 */
export function recordUsage(ctx: Context): { take(sessionId: string): Metered; dispose(): void } {
  const sessions = new Map<string, Metered>()
  const dispose = ctx.on('session/event' as any, (session: any, event: any) => {
    if (event?.type !== 'assistant/message' || event.data?.usage === undefined) return
    const id = String(session?.id)
    sessions.set(id, meter(sessions.get(id) ?? { usage: emptyUsage() }, event.data))
  })
  return {
    take(sessionId) {
      const metered = sessions.get(sessionId) ?? { usage: emptyUsage() }
      sessions.delete(sessionId)
      return metered
    },
    dispose: () => void dispose(),
  }
}

/** A run's numbers (docs/05 §6.8). Null rows say why in `unsupported`, keyed by their path. */
export interface RunMetrics {
  version: 1
  runId: string
  /** Tasks landed: merged by the train or the queue; without worktrees, a board task completed in the shared tree. */
  landed: number | null
  /** Landed tasks by the strongest passing verifier each reached (`L0`: none; a human waiver is none). */
  levels: Record<string, number> | null
  tokens: (Usage & { total: number; byPrincipal: Record<string, number>; byModel: Record<string, number>; byRuntime: Record<string, number> }) | null
  dollars: { total: number; byModel: Record<string, number> } | null
  /** From the run's start to its end, or to now while it runs. */
  wallClockMs: number
  /** Coordination tokens (reviews, repairs, resolvers, lead and judge runs) ÷ task-work tokens, with the split. */
  coordination: { ratio: number | null; coordination: number; task: number; split: Record<Exclude<UsageRole, 'task'>, number> } | null
  interventions: { steers: number; answers: number; restarts: number; questions: Record<string, number>; medianTimeToAnswerMs: number | null }
  /** The train's health, or the queue's where the run merged through it; entries are the branches with commits. */
  landing: {
    entries: number
    landed: number
    landingRate: number | null
    /** Landed with no conflict, repair or resolver. */
    cleanMergeRate: number | null
    /** Batches split to find a culprit. */
    bisects: number | null
    conflicts: number
    /** From an entry's enqueueing to its landing. */
    latencyMs: { median: number; max: number } | null
  } | null
  /** Seeded tasks against the final board, by subject. */
  tasks: { seeded: number; lost: number; duplicated: number } | null
  tamper: { incidents: number; advisories: number }
  costPerLanding: { tokens: number; dollars: number | null } | null
  unsupported: Record<string, string>
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

const counts = (keys: string[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const key of keys) out[key] = (out[key] ?? 0) + 1
  return out
}

/**
 * Fold a run's journal and its train's journal into its metrics. `git` is the
 * landing outcome when the run's record does not hold it yet (its result is
 * being settled); `now` ends the wall clock of a run still running.
 */
export function foldMetrics(
  events: readonly SwarmJournalEvent[],
  trainEvents: readonly SwarmJournalEvent[],
  options: { pricing?: Pricing; now?: number; git?: MergeOutcome } = {},
): RunMetrics {
  const run = foldRun(events)
  if (run === undefined) throw new Error('the journal holds no run record')
  const unsupported: Record<string, string> = {}
  const missing = (key: string, reason: string): null => {
    unsupported[key] = reason
    return null
  }
  const of = <T>(list: readonly SwarmJournalEvent[], type: string) => list.filter((e) => e.type === type).map((e) => e.data as T)
  const git = options.git ?? run.result?.git ?? run.git
  const inPlace = "nothing lands: the run's members work in place, without worktrees"
  // A worktree run from before B4 merged without leaving evidence: not in place, just unrecorded.
  const predates = run.landing === undefined && (git !== undefined || trainEvents.length > 0) ? 'the run predates landing records' : undefined

  // The numerator: landings with evidence (B4), or a board's completed tasks in place.
  const board = [...foldBoard(events).values()]
  const bundles = [...of<LandingEvidence>(trainEvents, 'train/evidence'), ...of<LandingEvidence>(events, 'swarm/evidence')]
  const landedLevels =
    predates !== undefined
      ? undefined
      : run.landing !== undefined
        ? bundles.filter((b) => b.outcome === 'landed').map((b) => b.level)
        : run.topology === 'peer-team'
          ? board.filter((t) => t.status === 'completed').map((t) => (t.evidence === undefined ? 0 : effectiveLevel(t.evidence)))
          : undefined
  const landed = landedLevels?.length ?? missing('landed', predates ?? `${inPlace}, and it has no board`)
  const levels = landedLevels === undefined ? missing('levels', unsupported['landed']!) : counts(landedLevels.map((level) => `L${level}`))

  // The denominator: tokens and dollars by principal, model and runtime.
  const usage = of<{ member: string; role: UsageRole; model?: string; runtime: string; usage: Usage }>(events, 'swarm/usage')
  const byModel: Record<string, Usage> = {}
  const byRole: Record<UsageRole, number> = { task: 0, review: 0, repair: 0, resolve: 0, lead: 0 }
  const tally = (key: (u: (typeof usage)[number]) => string) => {
    const out: Record<string, number> = {}
    for (const u of usage) out[key(u)] = (out[key(u)] ?? 0) + tokensOf(u.usage)
    return out
  }
  for (const u of usage) {
    addUsage((byModel[u.model ?? 'unknown'] ??= emptyUsage()), u.usage)
    byRole[u.role] += tokensOf(u.usage)
  }
  const total = Object.values(byModel).reduce(addUsage, emptyUsage())
  const unmeasured = usageUnmeasured(run)
  const tokens =
    unmeasured !== undefined
      ? missing('tokens', unmeasured)
      : { ...total, total: tokensOf(total), byPrincipal: tally((u) => u.member), byModel: tally((u) => u.model ?? 'unknown'), byRuntime: tally((u) => u.runtime) }
  const usd = tokens === null ? { reason: unsupported['tokens']! } : priced(byModel, options.pricing)
  const dollars =
    typeof usd === 'number'
      ? { total: usd, byModel: Object.fromEntries(Object.entries(byModel).map(([model, u]) => [model, priced({ [model]: u }, options.pricing) as number])) }
      : missing('dollars', usd.reason)

  const { task, ...split } = byRole
  const coordinationTokens = split.review + split.repair + split.resolve + split.lead
  const coordination =
    tokens === null
      ? missing('coordination', unsupported['tokens']!)
      : {
          ratio: task > 0 ? coordinationTokens / task : missing('coordination.ratio', 'no task-work tokens to divide by'),
          coordination: coordinationTokens,
          task,
          split,
        }

  // Interventions: what people did, and what the harness asked of them.
  const questions = [...foldQuestions(events).values()]
  const answered = questions.filter((q) => q.status === 'answered' && q.closedAt !== undefined)
  const interventions = {
    steers: of(events, 'swarm/steer').length,
    answers: answered.length,
    restarts: of(events, 'swarm/restart').length,
    questions: counts(questions.map((q) => q.trigger)),
    medianTimeToAnswerMs:
      answered.length === 0 ? missing('interventions.medianTimeToAnswerMs', 'no question was answered') : median(answered.map((q) => q.closedAt! - q.raisedAt)),
  }

  // Landing health: the train's from its journal; the queue's from the run's merge outcome.
  let landing: RunMetrics['landing']
  if (run.landing === 'train') {
    const enqueued = new Map<string, number>()
    for (const e of trainEvents) if (e.type === 'train/enqueued' && !enqueued.has((e.data as TrainEvents['train/enqueued']).key)) enqueued.set((e.data as TrainEvents['train/enqueued']).key, e.time)
    const landings = of<TrainEvents['train/landed']>(trainEvents, 'train/landed')
    const landedAt = new Map(trainEvents.filter((e) => e.type === 'train/landed').map((e) => [(e.data as TrainEvents['train/landed']).key, e.time]))
    const batches = of<TrainEvents['train/batch']>(trainEvents, 'train/batch')
    // A conflict in a batch, or in the queue a failing baseline sent the entries through.
    const conflicted = new Set([...batches.flatMap((b) => b.conflicted), ...bundles.filter((b) => b.outcome === 'conflicted').map((b) => b.key)])
    // Not clean: a repair, a resolver, a tamper sign, or a merge the train never verified.
    const fixed = new Set([
      ...trainEvents.filter((e) => ['train/repair', 'train/resolve', 'train/tamper'].includes(e.type)).map((e) => (e.data as { key: string }).key),
      ...landings.filter((l) => l.unverified === true).map((l) => l.key),
    ])
    const clean = [...landedAt.keys()].filter((key) => !conflicted.has(key) && !fixed.has(key)).length
    const latencies = [...landedAt].map(([key, time]) => time - (enqueued.get(key) ?? time))
    const none = 'the train had no entries'
    landing = {
      entries: enqueued.size,
      landed: landedAt.size,
      landingRate: enqueued.size === 0 ? missing('landing.landingRate', none) : landedAt.size / enqueued.size,
      cleanMergeRate: enqueued.size === 0 ? missing('landing.cleanMergeRate', none) : clean / enqueued.size,
      bisects: new Set(batches.flatMap((b) => (b.parent === undefined ? [] : [b.parent]))).size,
      conflicts: conflicted.size,
      latencyMs: latencies.length === 0 ? missing('landing.latencyMs', 'nothing landed') : { median: median(latencies), max: Math.max(...latencies) },
    }
  } else if (run.landing === 'queue') {
    if (git === undefined) landing = missing('landing', 'the run has not landed its work yet')
    else {
      const entries = git.merged.length + git.conflicts.length
      landing = {
        entries,
        landed: git.merged.length,
        landingRate: entries === 0 ? missing('landing.landingRate', 'no branch had commits') : git.merged.length / entries,
        cleanMergeRate: missing('landing.cleanMergeRate', 'the sequential queue merges without verifying'),
        bisects: missing('landing.bisects', 'the sequential queue does not bisect'),
        conflicts: git.conflicts.length,
        latencyMs: missing('landing.latencyMs', 'the sequential queue journals no landing times'),
      }
    }
  } else landing = missing('landing', predates ?? inPlace)

  // Zero loss: the seeded task set against the final board, by subject.
  let tasks: RunMetrics['tasks']
  if (run.spec?.topology !== 'peer-team') tasks = missing('tasks', 'only a peer-team seeds a board')
  else {
    const seeded = counts(run.spec.tasks.map((t) => t.subject))
    const final = counts(board.map((t) => t.subject))
    let lost = 0
    let duplicated = 0
    for (const subject of new Set([...Object.keys(seeded), ...Object.keys(final)])) {
      const diff = (final[subject] ?? 0) - (seeded[subject] ?? 0)
      if (diff < 0) lost -= diff
      else duplicated += diff
    }
    tasks = { seeded: run.spec.tasks.length, lost, duplicated }
  }

  const severities = [
    ...of<SwarmTamperEvent>(events, 'swarm/tamper').map((t) => t.severity ?? 'incident'),
    ...of<TrainEvents['train/tamper']>(trainEvents, 'train/tamper').map((t) => t.severity),
  ]
  const costPerLanding =
    tokens === null || landed === null || landed === 0
      ? missing('costPerLanding', tokens === null ? unsupported['tokens']! : unsupported['landed'] ?? 'nothing landed')
      : { tokens: Math.round(tokens.total / landed), dollars: dollars === null ? null : dollars.total / landed }
  if (costPerLanding !== null && dollars === null) unsupported['costPerLanding.dollars'] = unsupported['dollars']!

  return {
    version: 1,
    runId: run.id,
    landed,
    levels,
    tokens,
    dollars,
    wallClockMs: (run.endedAt ?? (run.status === 'interrupted' ? lastWrite(events) : undefined) ?? options.now ?? Date.now()) - run.startedAt,
    coordination,
    interventions,
    landing,
    tasks,
    tamper: { incidents: severities.filter((s) => s === 'incident').length, advisories: severities.filter((s) => s === 'advisory').length },
    costPerLanding,
    unsupported,
  }
}

/**
 * When an interrupted run's dead writer last wrote: the event before the
 * takeover's `interrupted` record and the claim releases it journaled just ahead of it.
 */
function lastWrite(events: readonly SwarmJournalEvent[]): number | undefined {
  let at = events.findIndex((e) => e.type === 'swarm/run' && (e.data as { run: SwarmRunRecord }).run.status === 'interrupted') - 1
  while (at >= 0 && events[at]!.type === 'swarm/task' && (events[at]!.data as { task: { status: string } }).task.status === 'pending') at--
  return at < 0 ? undefined : events[at]!.time
}

/** {@link foldMetrics} over the journals in a run's directory (`<runs>/<run id>`). */
export function runMetrics(runDir: string, options: { pricing?: Pricing } = {}): RunMetrics {
  return foldMetrics(SwarmJournal.read(join(runDir, 'journal.jsonl')), SwarmJournal.read(join(runDir, 'train.jsonl')), options)
}

/** `12,345`. */
export const count = (n: number): string => n.toLocaleString('en-US')

/** `950ms`, `42s`, `5m 3s`, `2h 10m`. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1_000)
  if (s < 60) return `${s}s`
  if (s < 3_600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`
}

/** The metrics as [row, value] text pairs, a null row as `— <why>`: what `openswarm metrics` and the Swarm tab show. */
export function metricsRows(m: RunMetrics): [string, string][] {
  const why = (key: string) => `— ${m.unsupported[key] ?? 'not measured'}`
  const list = (record: Record<string, number>, format = count) =>
    Object.entries(record)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key} ${format(value)}`)
      .join(', ')
  const ratio = (value: number | null, key: string) => (value === null ? why(key) : value.toFixed(2))
  const usd = (value: number) => `$${value.toFixed(2)}`
  const rows: [string, string][] = []
  rows.push(['landed', m.landed === null ? why('landed') : `${m.landed}${m.levels === null || m.landed === 0 ? '' : ` (${list(m.levels)})`}`])
  if (m.tokens === null) rows.push(['tokens', why('tokens')])
  else {
    const t = m.tokens
    rows.push(['tokens', `${count(t.total)} (input ${count(t.inputTokens)}, output ${count(t.outputTokens)}, cache read ${count(t.cacheReadTokens)}, cache write ${count(t.cacheWriteTokens)}; ${count(t.calls)} calls)`])
    rows.push(['  by principal', list(t.byPrincipal)])
    rows.push(['  by model', list(t.byModel)])
    rows.push(['  by runtime', list(t.byRuntime)])
  }
  rows.push(['dollars', m.dollars === null ? why('dollars') : `${usd(m.dollars.total)} (${list(m.dollars.byModel, usd)})`])
  rows.push(['wall clock', duration(m.wallClockMs)])
  const c = m.coordination
  rows.push(['coordination', c === null ? why('coordination') : `${ratio(c.ratio, 'coordination.ratio')} = ${count(c.coordination)} (${list(c.split)}) ÷ ${count(c.task)} task work`])
  const i = m.interventions
  const answer = i.medianTimeToAnswerMs === null ? why('interventions.medianTimeToAnswerMs') : duration(i.medianTimeToAnswerMs)
  rows.push(['interventions', `steers ${i.steers}, answers ${i.answers}, restarts ${i.restarts}; median time-to-answer ${answer}`])
  rows.push(['questions', Object.keys(i.questions).length === 0 ? 'none raised' : list(i.questions)])
  const l = m.landing
  rows.push([
    'landing',
    l === null
      ? why('landing')
      : [
          `${l.landed} of ${l.entries} landed`,
          `landing rate ${ratio(l.landingRate, 'landing.landingRate')}`,
          `clean-merge rate ${ratio(l.cleanMergeRate, 'landing.cleanMergeRate')}`,
          `bisects ${l.bisects ?? why('landing.bisects')}`,
          `conflicts ${l.conflicts}`,
          `latency ${l.latencyMs === null ? why('landing.latencyMs') : `median ${duration(l.latencyMs.median)}, max ${duration(l.latencyMs.max)}`}`,
        ].join('; '),
  ])
  rows.push(['tasks', m.tasks === null ? why('tasks') : `seeded ${m.tasks.seeded}, lost ${m.tasks.lost}, duplicated ${m.tasks.duplicated}`])
  rows.push(['tamper', `${m.tamper.incidents} incident(s), ${m.tamper.advisories} advisory`])
  const p = m.costPerLanding
  rows.push(['cost per landing', p === null ? why('costPerLanding') : `${count(p.tokens)} tokens, ${p.dollars === null ? why('costPerLanding.dollars') : usd(p.dollars)}`])
  return rows
}
