/**
 * The train (docs/05 §6.4, B2) and its integrate-and-repair steps (B3, D15).
 *
 * At a run's end every task branch with commits is an entry, carrying its
 * board blockers and its task order as priority. The landing loop is code.
 * First the target's tip is verified alone: a target that already fails
 * would make every entry look like a culprit, so a person decides (default:
 * stop). Then: take up to `batchSize` ready entries, merge them
 * speculatively onto the tip in the train's own worktree, verify that tree
 * once (the train's checks, L2, or a hidden suite, L3), and fast-forward the
 * target on a pass. A failing batch is bisected: each half lands on the
 * then-current tip, so a lone failing entry is the culprit and its
 * batch-mates land without it, a pair that fails only together included (the
 * first lands).
 *
 * Judgment enters only as agent steps, once a wave has nothing left ready: a
 * culprit's repair, run by the member that wrote its task after the target's
 * tip is merged into its branch, and a conflict's resolver. Each ends in an
 * auto-commit and the entry queued again, to be verified like any other.
 * Under L3 each step is scanned for the member reaching for the hidden suite,
 * as a gate round is (B1); an incident ejects the entry unless a person says
 * continue. What cannot be repaired or resolved is ejected with its branch
 * kept, after a question whose default is to eject; its dependents go too.
 *
 * The train stops early, keeping every unlanded branch and removing the task
 * worktrees, when the run is aborted, the verifier cannot run twice running,
 * or anything throws; its outcome then says what landed. A verifier that
 * cannot run returns that outcome; an abort or a throw rejects with it
 * ({@link TrainStoppedError}).
 *
 * Lead-hosted and service-shaped (D3): its own journal, `train.jsonl` beside
 * the run's, and it reaches the run only through the question queue (the
 * protocol's) until Phase D promotes it; it reads the run's journal for each
 * landing's evidence bundle (B4), journaled as `train/evidence` as the entry
 * lands or is ejected. Scope-violation questions wait for scopes (C4,
 * deferred by D18).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { snapshotTree, type MergeOutcome, type SwarmGit, type WorktreeInfo } from 'openswarm-git'
import type { SwarmTaskSnapshot } from './board'
import { buildEvidence, type LandingAt, type LandingEvidence } from './evidence'
import { runGateCommand, type HiddenSuite, type TamperSignal } from './gate'
import type { SwarmJournal, SwarmJournalEvent } from './journal'
import type { AskQuestion } from './run'
import type { ReportProgress, RunMember } from './topologies'
import type { MemberRunResult, MemberSpec } from './types'
import { runHiddenSuite, type VerifierSession } from './verifier'

/** `RunTeamOptions.worktrees.train`: land through the train instead of the sequential queue. */
export interface TrainConfig {
  /** Checks every batch tree must pass (L2); beside a suite, the repairing member's feedback only. */
  checks?: string[]
  /** The hidden suite every batch tree must pass (L3), by the name the verifier holds it under. */
  suite?: string
  /** Entries merged and verified together (default 4). */
  batchSize?: number
  /** Repairs per entry before a question asks whether to eject it (default 1). */
  maxRepairs?: number
}

/** What verifying one batch tree said. */
export interface TrainVerdict {
  level: 2 | 3
  passed: boolean
  /** Checks: the first that failed and the tail of its output (feedback only under L3). */
  failedCommand?: string
  output?: string
  /** Hidden: the suite and its counts, never names or output. */
  suite?: string
  total?: number
  failed?: number
  enforcement?: 'full' | 'partial'
  refused?: string
}

/**
 * Verify the batch tree checked out at `cwd`, whose commit is `commit`. Throws
 * when the verifier cannot run (retried once), or with `unconfined: true` when
 * it ran a hidden suite it could not confine (never retried).
 */
export type TrainVerify = (cwd: string, commit: string) => Promise<TrainVerdict>

/** An entry as the train's journal names it; commits count past the target's tip. */
export interface TrainEntryRef {
  key: string
  branch: string
  commits: number
}

/** Payloads of the train's journal events, by type. */
export interface TrainEvents {
  'train/enqueued': TrainEntryRef & { version: 1; blockedBy: string[]; priority: number; after?: 'repair' | 'resolve' }
  /** The target's tip verified alone, before anything lands. */
  'train/baseline': TrainVerdict & { version: 1; tip: string }
  /** One speculative merge: a wave's batch, or a half of `parent` while bisecting it. */
  'train/batch': { version: 1; batch: number; parent?: number; tip: string; entries: TrainEntryRef[]; conflicted: string[] }
  'train/verified': TrainVerdict & { version: 1; batch: number; commit: string; entries: string[] }
  /** The verifier could not run on a batch (batch 0: the baseline), twice. */
  'train/unverified': { version: 1; batch: number; commit: string; entries: string[]; error: string }
  /** Batch 0, `unverified`: merged by the sequential queue after a failing baseline, as the owner chose. */
  'train/landed': TrainEntryRef & { version: 1; batch: number; commit: string; unverified?: true }
  'train/ejected': TrainEntryRef & { version: 1; reason: string }
  'train/repair': TrainEntryRef & { version: 1; member: string; attempt: number; failure: string; outcome: 'committed' | 'unchanged' | 'failed'; error?: string }
  'train/resolve': TrainEntryRef & { version: 1; member?: string; tip: string; files: string[]; outcome: 'resolved' | 'gave-up' | 'tamper'; error?: string }
  /** Under L3: signs that a repair or resolver reached for the hidden suite (as `swarm/tamper` is for a gate round). */
  'train/tamper': TrainEntryRef & { version: 1; member: string; step: 'repair' | 'resolve'; severity: 'incident' | 'advisory'; signals: TamperSignal[] }
  /** The train stopped before every entry landed or was ejected. */
  'train/stopped': { version: 1; reason: string; landed: string[]; withheld: string[] }
  /** The reviewer's bundle for an entry that landed or was ejected (B4). */
  'train/evidence': LandingEvidence
}

export interface TrainDeps {
  journal: SwarmJournal
  /** The run's board tasks: each entry's blockers, and its priority (task order). */
  tasks?: readonly Pick<SwarmTaskSnapshot, 'id' | 'blockedBy'>[]
  /**
   * Per task key, the member that first ran in its worktree, which wrote it (a
   * critic, a later pipeline stage or cascade tier runs there after), and the
   * prompt it was given.
   */
  owners: ReadonlyMap<string, { member: MemberSpec; prompt: string }>
  /** The team's members: who repairs or resolves an entry no member ran in (one named as its key, else the first). */
  members?: readonly MemberSpec[]
  /** One member run in the worktree of the key it is given; told which step it is, for its usage. */
  run: RunMember
  /** The run's journal, which each landing's evidence bundle folds (its task, gate, questions and usage). */
  runEvents?: () => readonly SwarmJournalEvent[]
  verify: TrainVerify
  /** Under L3: B1's tamper scan of one agent step on the entry at `key` (a {@link HiddenSuite}'s `scan`). */
  scan?: (key: string, step: Parameters<HiddenSuite['scan']>[0]) => Promise<TamperSignal[]>
  ask?: AskQuestion
  report?: ReportProgress
  signal?: AbortSignal
}

/** The train stopped on an abort or a throw; `outcome` says what landed before it did. */
export class TrainStoppedError extends Error {
  constructor(
    message: string,
    readonly outcome: MergeOutcome,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TrainStoppedError'
  }
}

/** Refuse a train that cannot verify or is misconfigured, before any spend. */
export function validateTrain(config: TrainConfig, worktrees: { autoCommit?: boolean } = {}): void {
  if ((config.checks ?? []).length === 0 && config.suite === undefined) {
    throw new Error('worktrees.train needs checks (L2) or a hidden suite (L3) to verify its batches')
  }
  // Entries are the committed branches, and repairs and resolvers land by auto-commit.
  if (worktrees.autoCommit === false) throw new Error('worktrees.train needs autoCommit: the train lands committed branches and commits its repairs')
  if (config.suite !== undefined && !/^[a-z0-9-]{1,64}$/.test(config.suite)) {
    throw new Error(`worktrees.train names suite "${config.suite}"; a suite name is 1-64 of [a-z0-9-]`)
  }
  if (config.batchSize !== undefined && (!Number.isInteger(config.batchSize) || config.batchSize < 1)) {
    throw new Error('worktrees.train.batchSize must be a positive integer')
  }
  if (config.maxRepairs !== undefined && (!Number.isInteger(config.maxRepairs) || config.maxRepairs < 0)) {
    throw new Error('worktrees.train.maxRepairs must be a non-negative integer')
  }
}

/**
 * The train's verifier: its checks, each until one fails, in the batch tree;
 * then, with a suite, the hidden suite on the batch commit, which decides
 * (B1: the strongest source accepts). A run the verifier could not confine
 * is no L3 evidence, and every batch would be the same, so it throws, marked
 * `unconfined`.
 */
export function trainVerify(config: TrainConfig, hidden?: { session: VerifierSession; envRoot: string }): TrainVerify {
  if (config.suite !== undefined && hidden === undefined) throw new Error('a train with a suite needs the L3 verifier')
  return async (cwd, commit) => {
    let failure: Pick<TrainVerdict, 'failedCommand' | 'output'> = {}
    for (const command of config.checks ?? []) {
      const { ok, output } = await runGateCommand(command, cwd)
      if (!ok) {
        failure = { failedCommand: command, output }
        break
      }
    }
    if (config.suite === undefined || hidden === undefined) return { level: 2, passed: failure.failedCommand === undefined, ...failure }
    const s = await runHiddenSuite(hidden.session, config.suite, cwd, commit, hidden.envRoot)
    if (s.enforcement !== 'full' && !hidden.session.allowPartial) {
      throw Object.assign(new Error(`the verifier could not confine hidden suite ${config.suite} (enforcement ${s.enforcement})`), { unconfined: true })
    }
    return {
      level: 3,
      passed: s.passed,
      suite: config.suite,
      total: s.total,
      failed: s.failed,
      enforcement: s.enforcement,
      ...(s.refused === undefined ? {} : { refused: s.refused }),
      ...failure,
    }
  }
}

/** A verdict in a few words, for the journal's readers and questions. */
export function trainVerdictText(v: TrainVerdict): string {
  if (v.level === 3) {
    const counts = v.refused !== undefined ? 'refused the tree' : v.passed ? `${v.total} of ${v.total} passing` : `${v.failed} of ${v.total} failing`
    return `L3 hidden suite ${v.suite} ${v.passed ? 'passed' : 'not passed'} (${counts})`
  }
  return v.passed ? 'L2 checks passed' : `L2 check failed: ${v.failedCommand}`
}

/** A failed verdict as the repairing member is told it: the check and its output, or the suite's counts. */
function failureText(v: TrainVerdict): string {
  const check =
    v.failedCommand === undefined ? undefined : `\`${v.failedCommand}\` exited non-zero; its output ended with:\n\n${v.output || '(no output captured)'}`
  if (v.level === 2) return check ?? '(no check failed)'
  const suite =
    v.refused !== undefined ? `the hidden suite refused the tree: ${v.refused}` : `a hidden acceptance suite, which you cannot see, has ${v.failed} of ${v.total} failing`
  return [suite, ...(check === undefined ? [] : [`A check also failed: ${check}`])].join('\n\n')
}

/** A verdict as the journal keeps it: the output's tail is enough to read (the repair is told all of it). */
const kept = (v: TrainVerdict): TrainVerdict => (v.output === undefined ? v : { ...v, output: v.output.slice(-1_000) })

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Whether a file still holds a conflict marker line; one the resolver deleted
 * holds none. ponytail: a binary or modify/delete conflict leaves no markers,
 * so it passes on the resolver's word; the batch's verifier still runs on it.
 */
function markers(path: string): boolean {
  try {
    return /^(<{7}|>{7})( |$)/m.test(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
}

type EntryState = 'queued' | 'repair' | 'resolve' | 'landed' | 'ejected'

interface Entry {
  key: string
  worktree: WorktreeInfo
  /** Entries that must land first; a blocker with nothing to land is dropped. */
  blockedBy: string[]
  priority: number
  state: EntryState
  /** Repairs dispatched to its member. */
  repairs: number
  /** Repairs granted past `maxRepairs` by a 'retry' answer. */
  extra: number
  /** The failure that sent it to repair. */
  verdict?: TrainVerdict
}

/**
 * Land every task branch with commits through the train, onto `git`'s target
 * branch in its target worktree, never the user's checkout. Landed worktrees
 * are removed, ejected ones kept with their branches (unless the train
 * stopped); the caller disposes the target and train worktrees.
 */
export async function landTrain(git: SwarmGit, config: TrainConfig, deps: TrainDeps): Promise<MergeOutcome> {
  const batchSize = config.batchSize ?? 4
  const maxRepairs = config.maxRepairs ?? 1
  const ask: AskQuestion = deps.ask ?? (async (question) => question.default)
  const report = deps.report ?? (() => {})
  const target = git.targetBranch
  const tasks = deps.tasks ?? []
  const outcome = {
    targetBranch: target,
    merged: [] as MergeOutcome['merged'],
    conflicts: [] as MergeOutcome['conflicts'],
    empty: [] as MergeOutcome['empty'],
    withheld: [] as MergeOutcome['withheld'],
    landed: [] as NonNullable<MergeOutcome['landed']>,
    ejected: [] as NonNullable<MergeOutcome['ejected']>,
    resolved: [] as NonNullable<MergeOutcome['resolved']>,
    stopped: undefined as string | undefined,
  }
  const entries = new Map<string, Entry>()
  const byPriority = () => [...entries.values()].sort((a, b) => a.priority - b.priority)
  const result = (): MergeOutcome => {
    const { stopped, ...rest } = outcome
    return {
      ...rest,
      repaired: byPriority()
        .filter((e) => e.repairs > 0)
        .map((e) => ({ taskKey: e.key, branch: e.worktree.branch, repairs: e.repairs })),
      ...(stopped === undefined ? {} : { stopped }),
    }
  }
  const record = <K extends keyof TrainEvents>(type: K, data: Omit<TrainEvents[K], 'version'>) =>
    deps.journal.append(type, { version: 1, ...data })
  /** Commits past the target's tip: an entry's own, its repairs and merges, never the tip's. */
  const ref = async (e: Entry): Promise<TrainEntryRef> => ({ key: e.key, branch: e.worktree.branch, commits: await git.commitCount(e.worktree.branch, target) })
  const ownerOf = (e: Entry) => deps.owners.get(e.key)?.member ?? deps.members?.find((m) => m.name === e.key) ?? deps.members?.[0]
  const promptOf = (e: Entry) => {
    const prompt = deps.owners.get(e.key)?.prompt ?? ''
    return prompt === '' ? '' : `${prompt}\n\n`
  }
  /** Checked before landing anything, before and after each agent step, and after each answer: an aborted run takes no further step. */
  const live = () => deps.signal?.throwIfAborted()

  /** Journal an entry's evidence bundle (B4) against the tip it landed on; git that cannot say leaves the diff out. */
  const evidence = async (e: Entry, at: Omit<LandingAt, 'key' | 'branch' | 'at' | 'diff'>) => {
    const diff = await git.diffStat(at.base, e.worktree.branch).catch(() => undefined)
    const landing: LandingAt = { key: e.key, branch: e.worktree.branch, at: Date.now(), ...at, ...(diff === undefined ? {} : { diff }) }
    await deps.journal.append('train/evidence', buildEvidence(landing, deps.runEvents?.() ?? [], deps.journal.events))
  }

  /**
   * Stop early: every entry not landed or ejected is withheld, branch kept;
   * every task worktree goes, as on the run's own abort path.
   */
  const stop = async (reason: string): Promise<void> => {
    outcome.stopped = reason
    for (const e of byPriority()) {
      if (e.state !== 'landed' && e.state !== 'ejected') outcome.withheld.push({ taskKey: e.key, branch: e.worktree.branch })
    }
    await record('train/stopped', { reason, landed: outcome.landed.map((l) => l.taskKey), withheld: outcome.withheld.map((w) => w.taskKey) })
    for (const worktree of git.list()) await git.removeWorktree(worktree)
    report(`train: stopped (${reason}); ${outcome.landed.length} landed, ${outcome.withheld.length} withheld, branches kept`)
  }

  /** One verification, retried once when the verifier cannot run; why it could not, after that. */
  const verifyOnce = async (cwd: string, commit: string): Promise<TrainVerdict | { unavailable: string }> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.verify(cwd, commit)
      } catch (error) {
        if ((error as { unconfined?: boolean })?.unconfined === true) throw error
        live()
        report(`train: the verifier could not run (attempt ${attempt}/2): ${messageOf(error)}`)
        if (attempt === 2) return { unavailable: messageOf(error) }
      }
    }
  }

  /** Eject an entry, keeping its branch, and everything waiting on it. */
  const eject = async (e: Entry, reason: string): Promise<void> => {
    if (e.state === 'ejected' || e.state === 'landed') return
    e.state = 'ejected'
    outcome.ejected.push({ taskKey: e.key, branch: e.worktree.branch, reason })
    await record('train/ejected', { ...(await ref(e)), reason })
    await evidence(e, { outcome: 'ejected', via: 'train', base: await git.targetTip(), reason })
    report(`train: ${e.key} ejected, branch ${e.worktree.branch} kept: ${reason}`)
    for (const dependent of entries.values()) {
      if (dependent.blockedBy.includes(e.key)) await eject(dependent, `blocked by ejected ${e.key}`)
    }
  }

  const enqueue = async (e: Entry, after: 'repair' | 'resolve') => {
    e.state = 'queued'
    await record('train/enqueued', { ...(await ref(e)), blockedBy: e.blockedBy, priority: e.priority, after })
  }

  /** Culprits and conflicts found this wave, awaiting their agent step. */
  const fixes: Entry[] = []
  let batches = 0
  /** Set when the verifier could not run on a batch: nothing more lands. */
  let unavailable: string | undefined

  /** Merge `batch` onto the tip and verify it once; on a failure, land each half in turn (the bisection). */
  const land = async (batch: Entry[], parent?: number): Promise<void> => {
    if (unavailable !== undefined) return
    const id = ++batches
    const tip = await git.targetTip()
    const { cwd, commit, conflicted } = await git.speculate(tip, batch.map((e) => e.worktree.branch))
    const merged = batch.filter((e) => !conflicted.includes(e.worktree.branch))
    await record('train/batch', {
      batch: id,
      ...(parent === undefined ? {} : { parent }),
      tip,
      entries: await Promise.all(batch.map(ref)),
      conflicted: batch.filter((e) => conflicted.includes(e.worktree.branch)).map((e) => e.key),
    })
    for (const e of batch) {
      if (merged.includes(e)) continue
      e.state = 'resolve'
      fixes.push(e)
      report(`train: ${e.key} conflicts with ${target}; to the resolver`)
    }
    if (merged.length === 0) return
    const verdict = await verifyOnce(cwd, commit)
    if ('unavailable' in verdict) {
      unavailable = verdict.unavailable
      await record('train/unverified', { batch: id, commit, entries: merged.map((e) => e.key), error: verdict.unavailable })
      return
    }
    await record('train/verified', { ...kept(verdict), batch: id, commit, entries: merged.map((e) => e.key) })
    report(`train: batch ${id} (${merged.map((e) => e.key).join(', ')}): ${trainVerdictText(verdict)}`)
    if (verdict.passed) {
      const refs = await Promise.all(merged.map(ref))
      live()
      await git.advanceTarget(commit)
      for (const [i, e] of merged.entries()) {
        e.state = 'landed'
        const item = { taskKey: e.key, branch: refs[i]!.branch, commits: refs[i]!.commits }
        outcome.merged.push(item)
        outcome.landed.push(item)
        await record('train/landed', { ...refs[i]!, batch: id, commit })
        await evidence(e, { outcome: 'landed', via: 'train', base: tip, batch: id, commit })
        await git.removeWorktree(e.worktree)
      }
      return
    }
    if (merged.length === 1) {
      merged[0]!.state = 'repair'
      merged[0]!.verdict = verdict
      fixes.push(merged[0]!)
      return
    }
    const half = Math.ceil(merged.length / 2)
    await land(merged.slice(0, half), id)
    await land(merged.slice(half), id)
  }

  /**
   * One agent step on an entry, in its worktree. An aborted step stops the
   * train before anything of it is committed. Under L3 the step is scanned as
   * a gate round is; `incident` holds its signals when it was one.
   */
  const agent = async (e: Entry, member: MemberSpec, step: 'repair' | 'resolve', prompt: string): Promise<{ error?: string; incident?: TamperSignal[] }> => {
    live()
    const before = deps.scan === undefined ? undefined : await snapshotTree(e.worktree.path)
    const startedAt = Date.now()
    let result: MemberRunResult
    let error: string | undefined
    try {
      result = await deps.run(member, prompt, e.key, step)
    } catch (err) {
      error = messageOf(err)
      result = { member: member.name, runId: '', text: '', output: [], stopReason: 'error' }
    }
    live()
    const failed = error === undefined ? {} : { error }
    if (before === undefined || deps.scan === undefined) return failed
    const after = await snapshotTree(e.worktree.path)
    const signals = await deps.scan(e.key, { result, before: before.commit, after: after.commit, startedAt })
    if (signals.length === 0) return failed
    const incident = signals.some((s) => s.severity === 'incident')
    await record('train/tamper', { ...(await ref(e)), member: member.name, step, severity: incident ? 'incident' : 'advisory', signals })
    report(`train: ${step} on ${e.key}: tamper ${incident ? 'incident' : 'advisory'} — ${[...new Set(signals.map((s) => `${s.signal} in ${s.where}`))].join(', ')}`)
    return incident ? { ...failed, incident: signals } : failed
  }

  /** A person decides on an incident, while the entry holds; unless they say continue, it is ejected. */
  const carryOn = async (e: Entry, step: 'repair' | 'resolve', signals: TamperSignal[]): Promise<boolean> => {
    const answer = await ask({
      trigger: 'tamper',
      kind: 'escalation',
      tier: 'high',
      taskId: e.key,
      prompt: `landing ${e.key}: its ${step === 'repair' ? 'repair' : 'resolver'} reached for the hidden suite (${[...new Set(signals.map((s) => `${s.signal} in ${s.where}`))].join(', ')}). Eject it (its branch ${e.worktree.branch} is kept), or continue?`,
      options: ['eject', 'continue'],
      default: 'eject',
    }).catch(() => 'eject')
    live()
    return answer === 'continue'
  }

  /** Merge the target's tip into an entry's branch, a conflict through the resolver. */
  const resolve = async (e: Entry): Promise<'clean' | 'resolved' | 'gave-up' | 'ejected'> => {
    live()
    const tip = await git.targetTip()
    const files = await git.mergeInto(e.worktree, tip)
    if (files.length === 0) return 'clean'
    const member = ownerOf(e)
    const step =
      member === undefined
        ? { error: 'no member to run the resolver' }
        : await agent(
            e,
            member,
            'resolve',
            `${promptOf(e)}## Integrate\n\nLanding this work on ${target} conflicts. The lead has merged ${target}'s tip into this worktree, and these files hold conflicts: ${files.join(', ')}. Resolve every conflict, keeping the intent of both sides, and leave no conflict markers. Do not commit, abort or redo the merge; the lead commits when you stop.`,
          )
    let error = step.error
    let how: 'resolved' | 'gave-up' | 'tamper' = 'gave-up'
    if (step.incident !== undefined && !(await carryOn(e, 'resolve', step.incident))) {
      how = 'tamper'
      error = 'tamper incident'
      await git.abortMerge(e.worktree)
    } else {
      const left = error !== undefined ? files : files.filter((file) => markers(join(e.worktree.path, file)))
      if (left.length === 0) {
        await git.concludeMerge(e.worktree, `swarm: merge ${target} into ${e.worktree.branch} (resolved)`)
        // A resolver that aborted the merge itself left the tip out.
        if (await git.contains(e.worktree.branch, tip)) how = 'resolved'
        else error = `${target}'s tip is not in the branch after the resolver`
      } else {
        error ??= `conflict markers remain in ${left.join(', ')}`
        await git.abortMerge(e.worktree)
      }
    }
    await record('train/resolve', {
      ...(await ref(e)),
      ...(member === undefined ? {} : { member: member.name }),
      tip,
      files,
      outcome: how,
      ...(error === undefined ? {} : { error }),
    })
    report(`train: resolver on ${e.key}: ${how}${error === undefined ? '' : ` (${error})`}`)
    if (how === 'tamper') {
      await eject(e, 'tamper incident in its resolver')
      return 'ejected'
    }
    return how
  }

  /** Bring the tip into an entry's branch; false once it was ejected (over the conflict, or a tamper incident). */
  const integrate = async (e: Entry): Promise<boolean> => {
    for (;;) {
      const how = await resolve(e)
      if (how === 'ejected') return false
      if (how === 'resolved' && !outcome.resolved.some((r) => r.taskKey === e.key)) {
        outcome.resolved.push({ taskKey: e.key, branch: e.worktree.branch })
      }
      if (how !== 'gave-up') return true
      const answer = await ask({
        trigger: 'conflict',
        taskId: e.key,
        prompt: `landing ${e.key} conflicts with ${target}; resolver gave up. Eject it (its branch ${e.worktree.branch} is kept), or retry the resolver?`,
        options: ['eject', 'retry'],
        default: 'eject',
      }).catch(() => 'eject')
      live()
      if (answer !== 'retry') {
        outcome.conflicts.push({ taskKey: e.key, branch: e.worktree.branch })
        await eject(e, `conflicts with ${target}; the resolver gave up`)
        return false
      }
    }
  }

  /** The agent step for one culprit or conflict; whatever it fixes is queued again. */
  const fix = async (e: Entry): Promise<void> => {
    if (e.state === 'resolve') {
      if (await integrate(e)) await enqueue(e, 'resolve')
      return
    }
    const failure = trainVerdictText(e.verdict!)
    if (e.repairs >= maxRepairs + e.extra) {
      const answer = await ask({
        trigger: 'verifier-failure',
        taskId: e.key,
        prompt: `landing ${e.key} on ${target} still fails on the integrated tree (${failure}) after ${e.repairs} repair(s). Eject it (its branch ${e.worktree.branch} is kept), or retry one more repair?`,
        options: ['eject', 'retry'],
        default: 'eject',
      }).catch(() => 'eject')
      live()
      if (answer !== 'retry') return eject(e, `fails on the integrated tree after ${e.repairs} repair(s): ${failure}`)
      e.extra++
    }
    const member = ownerOf(e)
    if (member === undefined) return eject(e, 'no member to repair it')
    // The member repairs the tree that failed: the tip with its work merged in.
    if (!(await integrate(e))) return
    e.repairs++
    const step = await agent(
      e,
      member,
      'repair',
      `${promptOf(e)}## Landing\n\nThe landing check failed on the integrated tree (${target}'s tip with this branch merged in): ${failureText(e.verdict!)}\n\nFix it in this worktree, where ${target}'s tip is now merged in. Change what the fix needs, then stop; the lead commits.`,
    )
    // A tampered repair's edits are left uncommitted in its kept worktree, for a person to look at.
    if (step.incident !== undefined && !(await carryOn(e, 'repair', step.incident))) return eject(e, `tamper incident in repair ${e.repairs}`)
    const committed = await git.autoCommit(e.worktree, `swarm: repair ${e.key} (train)`)
    const how = step.error !== undefined ? 'failed' : committed ? 'committed' : 'unchanged'
    await record('train/repair', { ...(await ref(e)), member: member.name, attempt: e.repairs, failure, outcome: how, ...(step.error === undefined ? {} : { error: step.error }) })
    report(`train: repair ${e.repairs} of ${e.key} by ${member.name}: ${how}`)
    await enqueue(e, 'repair')
  }

  try {
    for (const [i, worktree] of git.list().entries()) {
      if ((await git.commitCount(worktree.branch)) === 0) {
        outcome.empty.push({ taskKey: worktree.taskKey, branch: worktree.branch })
        await git.removeWorktree(worktree)
        continue
      }
      const at = tasks.findIndex((task) => task.id === worktree.taskKey)
      entries.set(worktree.taskKey, {
        key: worktree.taskKey,
        worktree,
        blockedBy: [...(at < 0 ? [] : tasks[at]!.blockedBy)],
        priority: at < 0 ? tasks.length + i : at,
        state: 'queued',
        repairs: 0,
        extra: 0,
      })
    }
    if (entries.size === 0) return result()
    for (const e of entries.values()) e.blockedBy = e.blockedBy.filter((id) => entries.has(id))
    const tip = await git.targetTip()
    for (const e of byPriority()) await record('train/enqueued', { ...(await ref(e)), blockedBy: e.blockedBy, priority: e.priority })

    // The baseline: a target that already fails would make every entry a culprit.
    live()
    const { cwd } = await git.speculate(tip, [])
    const baseline = await verifyOnce(cwd, tip)
    if ('unavailable' in baseline) {
      await record('train/unverified', { batch: 0, commit: tip, entries: [], error: baseline.unavailable })
      await stop(`verifier unavailable: ${baseline.unavailable}`)
      return result()
    }
    await record('train/baseline', { ...kept(baseline), tip })
    if (!baseline.passed) {
      const failing = trainVerdictText(baseline)
      const answer = await ask({
        trigger: 'verifier-failure',
        prompt: `${target} at ${tip.slice(0, 8)} already fails the train's verifier before anything lands (${failing}), so no entry could be told from a culprit. Merge the branches unverified through the sequential queue, or stop with them kept?`,
        options: ['stop', 'merge'],
        default: 'stop',
      }).catch(() => 'stop')
      live()
      if (answer !== 'merge') {
        await stop(`baseline failing: ${failing}`)
        return result()
      }
      // Counted past the tip before the queue moves it.
      const refs = new Map(await Promise.all(byPriority().map(async (e) => [e.key, await ref(e)] as const)))
      const queued = await git.mergeAll()
      const merged = await git.targetTip()
      // Journaled as landings, and given evidence, like any: unverified, which their bundles say.
      for (const m of queued.merged) {
        const e = entries.get(m.taskKey)!
        e.state = 'landed'
        await record('train/landed', { ...refs.get(e.key)!, batch: 0, commit: merged, unverified: true })
        await evidence(e, { outcome: 'landed', via: 'queue', base: tip, unverified: true })
      }
      for (const c of queued.conflicts) await evidence(entries.get(c.taskKey)!, { outcome: 'conflicted', via: 'queue', base: merged, unverified: true })
      const reason = `baseline failing (${failing}): merged unverified through the sequential queue`
      await record('train/stopped', { reason, landed: queued.merged.map((m) => m.taskKey), withheld: queued.conflicts.map((c) => c.taskKey) })
      report(`train: ${reason}`)
      return { ...queued, empty: outcome.empty, stopped: reason }
    }

    for (;;) {
      live()
      const ready = byPriority().filter((e) => e.state === 'queued' && e.blockedBy.every((id) => entries.get(id)!.state === 'landed'))
      if (ready.length > 0) {
        await land(ready.slice(0, batchSize))
        if (unavailable === undefined) continue
        await stop(`verifier unavailable: ${unavailable}`)
        return result()
      }
      // The wave is over: its culprits and conflicts get their agent steps.
      if (fixes.length === 0) break
      for (const e of fixes.splice(0)) await fix(e)
    }
    // Nothing ready and nothing to fix: what is still queued waits on an entry that will never land.
    for (const e of byPriority()) if (e.state === 'queued') await eject(e, 'blocked by an entry that did not land')
    return result()
  } catch (error) {
    // Partial, but true: what landed stays landed; the rest keep their branches.
    if (outcome.stopped === undefined) await stop(deps.signal?.aborted === true ? 'aborted' : messageOf(error)).catch(() => undefined)
    throw new TrainStoppedError(messageOf(error), result(), { cause: error })
  }
}

/**
 * One recap line per train event with seq > `since`, numbered `#t<seq>` by the
 * train journal's own seqs (it is a separate journal from the run's).
 */
export function recapTrain(events: readonly SwarmJournalEvent[], since = -1): string[] {
  const lines: string[] = []
  const first = (text: string) => text.split('\n')[0]!.slice(0, 80)
  for (const { seq, type, data } of events) {
    if (seq <= since) continue
    let line: string | undefined
    if (type === 'train/enqueued') {
      const d = data as TrainEvents['train/enqueued']
      const after = [...(d.blockedBy.length === 0 ? [] : [`after ${d.blockedBy.join(', ')}`]), ...(d.after === undefined ? [] : [`again, after its ${d.after}`])]
      line = `${d.key} enqueued (${d.commits} commit(s)${after.length === 0 ? '' : `; ${after.join('; ')}`})`
    } else if (type === 'train/baseline') {
      const d = data as TrainEvents['train/baseline']
      line = `baseline ${d.tip.slice(0, 8)} ${trainVerdictText(d)}`
    } else if (type === 'train/batch') {
      const d = data as TrainEvents['train/batch']
      const what = d.parent === undefined ? `batch ${d.batch}` : `batch ${d.batch} (bisecting ${d.parent})`
      line = `${what} on ${d.tip.slice(0, 8)}: ${d.entries.map((e) => e.key).join(', ')}${d.conflicted.length === 0 ? '' : `; ${d.conflicted.join(', ')} conflicted`}`
    } else if (type === 'train/verified') {
      const d = data as TrainEvents['train/verified']
      line = `batch ${d.batch} ${trainVerdictText(d)}`
    } else if (type === 'train/unverified') {
      const d = data as TrainEvents['train/unverified']
      line = `${d.batch === 0 ? 'baseline' : `batch ${d.batch}`} unverified: ${first(d.error)}`
    } else if (type === 'train/landed') {
      const d = data as TrainEvents['train/landed']
      line = `${d.key} landed (${d.unverified === true ? 'merged unverified by the queue' : `batch ${d.batch}`}, ${d.commit.slice(0, 8)})`
    } else if (type === 'train/ejected') {
      const d = data as TrainEvents['train/ejected']
      line = `${d.key} ejected, branch ${d.branch} kept: ${d.reason}`
    } else if (type === 'train/repair') {
      const d = data as TrainEvents['train/repair']
      line = `${d.key} repair ${d.attempt} by ${d.member}: ${d.outcome}${d.error === undefined ? '' : ` (${first(d.error)})`}`
    } else if (type === 'train/resolve') {
      const d = data as TrainEvents['train/resolve']
      line = `${d.key} resolver${d.member === undefined ? '' : ` (${d.member})`} on ${d.files.length} file(s): ${d.outcome}${d.error === undefined ? '' : ` (${first(d.error)})`}`
    } else if (type === 'train/tamper') {
      const d = data as TrainEvents['train/tamper']
      line = `${d.key} tamper ${d.severity} in its ${d.step} (${d.member}): ${[...new Set(d.signals.map((s) => `${s.signal} in ${s.where}`))].join(', ')}`
    } else if (type === 'train/stopped') {
      const d = data as TrainEvents['train/stopped']
      line = `stopped: ${first(d.reason)} (${d.landed.length} landed, ${d.withheld.length} withheld)`
    }
    if (line !== undefined) lines.push(`#t${seq} train: ${line}`)
  }
  return lines
}
