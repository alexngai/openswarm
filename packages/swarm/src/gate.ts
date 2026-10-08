/**
 * The completion gate (docs/05 B6, D17): a task closes only with passing
 * evidence. The member works in rounds; after each, the task's checkers run
 * (commands mode) or, with none, an independent reviewer measures the tree,
 * and a failing check sends the work back with the report, up to a round cap.
 *
 * This is the pilot prototype's `rounds` mode (eval/pilot/gate.mjs, arm b:
 * 0.712 at $17.52 a task, docs/07 §7.1), with what the product adds: evidence
 * after the last round too (the prototype skipped that review, so it could
 * close on an unmeasured round), and a regression guard for checkers (docs/07
 * §7.1 finding 4: later rounds can break working code).
 *
 * Levels (docs/05 §6.4, B1): the gate accepts on the strongest source it is
 * given (L3 a hidden suite, L2 the task's checkers, L1 the reviewer); a weaker
 * one configured alongside still runs, for the member's feedback only. At L3
 * every round is first scanned for the member reaching for the hidden suite:
 * a corroborated sign makes it an incident, never measured; a bare mention of
 * the verifier is advisory, recorded and measured (`HiddenSuite.scan`). A run
 * the verifier could not fully confine is not L3 unless the operator allows it.
 *
 * On the single-agent path this runs in the user's real checkout, so the gate
 * never writes to that tree: rounds are captured with non-intrusive snapshots
 * (no commit on a branch, HEAD and the index untouched), the reviewer measures
 * a snapshot somewhere else (`deps.review`, a disposable worktree), and a
 * regression is only rolled back where the caller owns the tree and says how
 * (`deps.rollback`).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { snapshotTree, type TreeSnapshot } from 'openswarm-git'
import type { ReportProgress, RunMember } from './topologies'
import type { MemberRunResult, MemberSpec } from './types'

const execFileAsync = promisify(execFile)

/** Keep the tail: a failing build's useful part is at the end, not the top. */
const OUTPUT_TAIL = 4_000

/**
 * The environment the gate's commands run in: the driver's, minus the npm
 * invocation that launched the driver. `npx`/`npm run` export `npm_*` and
 * `INIT_CWD` describing THAT invocation, and the graded repo's own npm then
 * reads them as its config — an inherited `npm_config_allow_scripts` makes
 * `npm ci` fail with EALLOWSCRIPTS, scoring a correct change 0.
 */
export function gateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_/i.test(key) && key !== 'INIT_CWD'))
}

/** One check under bash in `cwd`: ok when it exits 0, else the tail of its combined output. */
export async function runGateCommand(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    await execFileAsync('bash', ['-c', command], { cwd, env: gateEnv(), maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, output: '' }
  } catch (error) {
    const combined = `${(error as any)?.stdout ?? ''}${(error as any)?.stderr ?? ''}`
    return { ok: false, output: combined.length > OUTPUT_TAIL ? combined.slice(-OUTPUT_TAIL) : combined }
  }
}

/** Four rounds: docs/07 §7.4 found eight bought nothing more. */
const DEFAULT_GATE_ROUNDS = 4

/**
 * The verifier hierarchy (docs/05 §6.4): L0 the member's own word (no gate),
 * L1 a reviewer, L2 declared commands, L3 a hidden suite, L4 external CI on
 * the train (reserved; nothing produces it yet).
 */
export type VerifierLevel = 0 | 1 | 2 | 3 | 4

/** What the L3 verifier says of one run of a hidden suite: counts, never names, output or source. */
export interface HiddenSummary {
  passed: boolean
  total: number
  failed: number
  durationMs: number
  /** `full`: no network, writes only in the run's directory, the store hidden; `partial`: less than that. */
  enforcement: 'full' | 'partial'
  /** The snapshot itself was refused (a malformed archive): the member's failure, with why. */
  refused?: string
}

/**
 * One sign that a member reached for the hidden suite (docs/05 §6.4). An
 * `incident` is corroborated (a canary, a helper call the gate did not make,
 * a denied access by the member's own command, sudo aimed at the verifier);
 * a bare mention of a verifier path or the user is `advisory`, which text
 * a sibling planted, or a repository naming the verifier, can produce.
 */
export interface TamperSignal {
  signal: 'store-path' | 'helper-path' | 'verifier-user' | 'sudo' | 'permission-denied' | 'canary' | 'helper-log'
  severity: 'incident' | 'advisory'
  where: 'transcript' | 'diff' | 'helper log'
  /** What matched: a path, the user's name, a canary, a log entry's command and caller; never the text around it. */
  match: string
}

/** The L3 source (docs/05 B1): a hidden suite the member cannot read, and the scan that guards it. */
export interface HiddenSuite {
  suite: string
  /** Count a `partial` run as passing (the operator allowed it); it is still recorded as such. */
  allowPartial?: boolean
  /** Run the suite on a snapshot commit. */
  run(commit: string): Promise<HiddenSummary>
  /** Signs, in the round that went from `before` to `after`, of the member reaching for the suite. */
  scan(round: { result: MemberRunResult; before: string; after: string; startedAt: number }): Promise<TamperSignal[]>
}

export interface GateSpec {
  task: string
  member: MemberSpec
  /** Agent rounds before the gate gives up (default 4). */
  maxRounds?: number
  /** The task's checkers, each run on its own. Non-empty → L2 (or feedback under L3); else `deps.review`. */
  commands?: string[]
  /** The level the task must reach; the gate refuses to start when its sources cannot. */
  minLevel?: VerifierLevel
}

export interface GateDeps {
  run: RunMember
  /** The tree the member edits; a function for a worktree that exists only once asked for. */
  cwd: string | (() => Promise<string>)
  /**
   * Review mode's reviewer: a fresh session given `prompt`, measuring the tree
   * of `snapshotCommit` somewhere it may change freely — never `cwd`.
   */
  review?: (prompt: string, snapshotCommit: string) => Promise<MemberRunResult>
  /**
   * Put the tree at `cwd` back to a snapshot commit. Only for a tree the gate
   * owns (a gate worktree); without it a regression is reported, not undone.
   */
  rollback?: (commit: string) => Promise<void>
  /** L3: the hidden suite, which accepts in place of commands or the reviewer (those then give feedback only). */
  hidden?: HiddenSuite
  /** Default {@link runGateCommand}. */
  runCommand?: (command: string, cwd: string) => Promise<{ ok: boolean; output: string }>
  report?: ReportProgress
  /** Receives each round as it completes; awaited, so a journal write lands before the next round. */
  record?: (round: GateRound) => unknown
  /** Passed on every member run. */
  taskKey?: string
  /** The run's abort signal: checked before every round, and a review that fails once it is aborted ends the gate. */
  signal?: AbortSignal
}

export interface GateTarget {
  target: number
  /** `unverifiable`: appears implemented, but this environment cannot run what would verify it (notes say what). */
  status: 'done' | 'partial' | 'missing' | 'broken' | 'unverifiable'
  notes?: string
}

/**
 * Targets as a record keeps them: each status, plus the notes of an
 * unverifiable one, which say what the reviewer could not run. Defensive: the
 * reviewer's JSON is whatever it wrote.
 */
export function targetStatuses(targets: readonly GateTarget[]): { target: number; status: string; notes?: string }[] {
  return targets.map((t) => ({
    target: t?.target,
    status: String(t?.status),
    ...(t?.status === 'unverifiable' && typeof t.notes === 'string' ? { notes: t.notes } : {}),
  }))
}

export interface GateEvidence {
  kind: 'commands' | 'review' | 'hidden'
  level: 1 | 2 | 3
  passed: boolean
  /** Review: the reviewer's 0–100 estimate; null when its verdict did not parse. */
  score?: number | null
  targets?: GateTarget[]
  /** Review: whatever the reviewer said (models often give a list), passed on as the prototype did. */
  regressions?: unknown
  /** Commands: every check that failed, in order. */
  failedCommands?: string[]
  /** Commands: the first check that failed, and the tail of its output. */
  failedCommand?: string
  output?: string
  /** Why the review or the hidden suite could not run (no copy of the tree, a reviewer that would not start). */
  error?: string
  /** Hidden: the suite, its counts and how its run was confined. */
  suite?: string
  total?: number
  failed?: number
  enforcement?: HiddenSummary['enforcement']
  /** Hidden: the round was a tamper incident, so nothing was measured. */
  tamper?: TamperSignal[]
  /** Hidden: the member's snapshot was refused, and why. */
  refused?: string
}

export interface GateRound {
  round: number
  result: MemberRunResult
  /** The snapshot commit of the tree the round left. */
  snapshot: string
  /** Whether the round changed the tree it started from. */
  changed: boolean
  evidence: GateEvidence
  /** Commands mode with a rollback: the round broke a check the round before passed, so it was undone. */
  rolledBack?: boolean
  /** Under L3: what the weaker source said, which the member was told too. */
  feedback?: GateEvidence
  /** Under L3: advisory tamper signs; the round was measured all the same. */
  advisory?: TamperSignal[]
}

export interface GateResult {
  accepted: boolean
  /** The level of the evidence it accepts on. */
  level: 1 | 2 | 3
  /** The snapshot commit taken before round 1. */
  base: string
  rounds: GateRound[]
  /** The last snapshot whose evidence passed, if any: the commit a `verifies` record is about. */
  lastPassing?: string
  /**
   * Why the gate stopped without a verdict, when it did: the review or the
   * hidden suite could not run, twice; a round was a tamper incident; or the
   * verifier could not confine the suite's run and that is not allowed.
   */
  reason?: 'review unavailable' | 'hidden suite unavailable' | 'tamper' | 'hidden suite unconfined'
  /** The last agent round's result. */
  final: MemberRunResult
}

/**
 * The prototype's reviewer prompt, verbatim ("roadmap" included) but for one
 * departure (docs/05 B6b): the `unverifiable` status and its definition. Live,
 * 8 of 12 tasks ended unaccepted mostly because the reviewer would not call
 * done a target its environment could not test (MySQL-backed tests with no
 * database), so it was scored "partial", indistinguishable from half-built.
 */
const REVIEW = `You are reviewing another engineer's implementation of the roadmap below, in this repository's working tree. Do not fix anything: your job is to measure.

For each target in the roadmap, decide whether it works as specified: check that the specified exports, signatures and behaviors exist, and run the repository's existing tests for the code involved plus small tests or scripts you write from the requirements. Everything you create or change in the repository is discarded after your review. A target is "unverifiable" when it appears implemented but this environment cannot run what would verify it (a database or service it needs is missing, say); its notes must say what you could not run.

End your reply with exactly one line of JSON and nothing after it:
{"targets":[{"target":<number>,"status":"done"|"partial"|"missing"|"broken"|"unverifiable","notes":"<one sentence: what fails or is missing>"}],"regressions":"<existing tests that fail because of the change, or none>","score":<0-100, your estimate of the share of the roadmap's requirements that work as specified>}

# Roadmap

`

/**
 * The prototype's continuation, verbatim for the reviewer but for one change:
 * the diff names both ends. The prototype's `git diff <base>` compared a
 * commit with the working tree, which is only right when the index tracks
 * every file; here base holds untracked files the real index never sees, so
 * the diff is snapshot to snapshot. Commands mode also swaps the sentence
 * that says who checked the work.
 */
const continuation = (task: string, base: string, round: string, checked: string, report: string) => `${task}

## Continue

You have already worked on this roadmap: your changes are in this working tree (\`git diff ${base} ${round}\` shows them all). ${checked} Finish what is missing or partial, fix what is broken, then stop.

${report}`

const REVIEWED = 'A reviewer then checked the result against the roadmap; its report follows.'
const CHECKED = "The task's checks then ran on the result; their report follows."
const HIDDEN = 'A hidden acceptance suite, which you cannot see, then ran on the result; the report follows.'

/** The cascade's feedback wording: the command and its output are what the next round can act on. */
const failure = (command: string, output: string) =>
  `Verification failed. This command exited non-zero:\n\n  ${command}\n\nIts output ended with:\n\n${output || '(no output captured)'}`

/**
 * A reviewer's reply as evidence, parsed as the prototype did: the last line
 * that opens a JSON object. It passes when every target is done or
 * unverifiable and at least as many are done as unverifiable. "Unverifiable
 * here" is not "partial", but it counts only with notes saying what could not
 * run, and a verdict mostly of unverifiable targets measured too little to
 * close on. A status outside the five fails, as anything but done did before.
 */
function verdictOf(text: string): GateEvidence {
  const line = text.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'))
  let verdict: any = null
  try {
    verdict = JSON.parse(line ?? '')
  } catch {}
  const targets: GateTarget[] | undefined = Array.isArray(verdict?.targets) ? verdict.targets : undefined
  return {
    kind: 'review',
    level: 1,
    passed: targets !== undefined && targets.length > 0 && passes(targets),
    score: typeof verdict?.score === 'number' ? verdict.score : null,
    ...(targets === undefined ? {} : { targets }),
    ...(verdict?.regressions === undefined ? {} : { regressions: verdict.regressions }),
  }
}

function passes(targets: GateTarget[]): boolean {
  const unverifiable = (t: GateTarget) => t?.status === 'unverifiable' && typeof t.notes === 'string' && t.notes.trim() !== ''
  if (!targets.every((t) => t?.status === 'done' || unverifiable(t))) return false
  return targets.filter((t) => t.status === 'done').length >= targets.filter(unverifiable).length
}

export async function runGate(spec: GateSpec, deps: GateDeps): Promise<GateResult> {
  const maxRounds = spec.maxRounds ?? DEFAULT_GATE_ROUNDS
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error('maxRounds must be a positive integer')
  const commands = spec.commands ?? []
  const { review, hidden } = deps
  if (commands.length === 0 && review === undefined && hidden === undefined) {
    throw new Error('the gate needs checks (spec.commands), a reviewer (deps.review) or a hidden suite (deps.hidden)')
  }
  // The strongest source accepts; any weaker one configured gives feedback.
  const level = hidden !== undefined ? 3 : commands.length > 0 ? 2 : 1
  if ((spec.minLevel ?? 0) > level) {
    throw new Error(`the gate must reach L${spec.minLevel}, but its strongest source is L${level} (L2 needs checks, L3 a hidden suite)`)
  }
  const runCommand = deps.runCommand ?? runGateCommand
  const report = deps.report ?? (() => {})
  const cwd = typeof deps.cwd === 'string' ? deps.cwd : await deps.cwd()

  const base = await snapshotTree(cwd)
  const rounds: GateRound[] = []
  /** The tree in place, and the evidence that describes it. */
  let tree = base
  let inPlace: GateEvidence | undefined
  /** Commands mode: the last round kept, and the checks it passed — what a regression is measured against. */
  let kept: { round: number; snapshot: TreeSnapshot; evidence: GateEvidence; passing: Set<string> } | undefined
  let prompt = spec.task
  let lastPassing: string | undefined
  let reason: GateResult['reason']
  /** Record a round that ends the gate without a verdict. */
  const stop = async (round: GateRound, why: NonNullable<GateResult['reason']>) => {
    rounds.push(round)
    await deps.record?.(round)
    reason = why
  }
  for (let n = 1; n <= maxRounds; n++) {
    // A cancelled run starts no round: an aborted member settles as a result,
    // not a rejection, so without this the gate would go on checking it.
    deps.signal?.throwIfAborted()
    report(`gate round ${n}/${maxRounds}: ${spec.member.name} working…`)
    const startedAt = Date.now()
    const result = await deps.run(spec.member, prompt, deps.taskKey)
    // Nor is a round the cancel cut short measured: its checks could pass and
    // close a task the run was told to stop.
    deps.signal?.throwIfAborted()
    const snapshot = await snapshotTree(cwd)
    const changed = snapshot.tree !== tree.tree
    const before = tree.commit
    tree = snapshot
    let advisory: TamperSignal[] = []
    if (hidden !== undefined) {
      // First, and even for a round that changed nothing: reading is not editing.
      // A round that reached for the suite is measured by nothing, so it tells
      // the member nothing, and the gate ends (docs/05 §6.4: a tamper incident).
      // Advisory signs alone are recorded with a round measured as usual.
      const tamper = await hidden.scan({ result, before, after: snapshot.commit, startedAt })
      advisory = tamper
      if (tamper.some((t) => t.severity === 'incident')) {
        report(`gate round ${n}: tamper — ${tamper.map((t) => `${t.signal} in ${t.where}`).join(', ')}`)
        await stop(
          { round: n, result, snapshot: snapshot.commit, changed, evidence: { kind: 'hidden', level: 3, passed: false, suite: hidden.suite, tamper } },
          'tamper',
        )
        break
      }
    }
    if (n > 1 && !changed) {
      // Nothing new to measure, and nothing more coming: the member has stopped.
      const round: GateRound = { round: n, result, snapshot: snapshot.commit, changed, evidence: inPlace!, ...(advisory.length === 0 ? {} : { advisory }) }
      rounds.push(round)
      await deps.record?.(round)
      report(`gate round ${n}: no change — stopping`)
      break
    }

    /** The commands' or the reviewer's evidence: what accepts below L3, feedback at it. */
    let evidence: GateEvidence | undefined
    let feedback = ''
    let rolledBack = false
    if (commands.length > 0) {
      report(`gate round ${n}: running ${commands.length} check(s)…`)
      // Every check, not just up to the first failure: the guard needs to know
      // which of them pass now.
      const outcomes: { command: string; ok: boolean; output: string }[] = []
      for (const command of commands) outcomes.push({ command, ...(await runCommand(command, cwd)) })
      const failed = outcomes.find((o) => !o.ok)
      evidence = {
        kind: 'commands',
        level: 2,
        passed: failed === undefined,
        ...(failed === undefined
          ? {}
          : { failedCommands: outcomes.filter((o) => !o.ok).map((o) => o.command), failedCommand: failed.command, output: failed.output }),
      }
      // Only checkers decide a regression; a reviewer's score ranks work on one
      // task too poorly to act on (docs/05 B6). Only when they accept: under L3
      // they are feedback, and the suite measures the tree as the member left it.
      const broke = outcomes.find((o) => !o.ok && kept?.passing.has(o.command))
      if (level === 2 && kept !== undefined && broke !== undefined && deps.rollback !== undefined) {
        await deps.rollback(kept.snapshot.commit)
        rolledBack = true
        tree = kept.snapshot
        inPlace = kept.evidence
        feedback = [
          'Your last round was rolled back: it broke a check that passed before it.',
          failure(broke.command, broke.output),
          'The working tree is back as it was before that round, where a check still fails.',
          failure(kept.evidence.failedCommand ?? '', kept.evidence.output ?? ''),
        ].join('\n\n')
        report(`gate round ${n}: broke ${broke.command}, which passed before — rolled back`)
      } else {
        // With no rollback (the user's own checkout) a regression stays in the
        // tree; the next round is told which check it broke.
        const regression =
          kept === undefined || broke === undefined ? undefined : `Round ${n} broke ${broke.command}, which passed in round ${kept.round}.`
        feedback =
          failed === undefined && regression === undefined
            ? ''
            : [
                ...(regression === undefined ? [] : [regression]),
                failure(failed?.command ?? '', failed?.output ?? ''),
                ...(broke === undefined || broke === failed ? [] : [failure(broke.command, broke.output)]),
              ].join('\n\n')
        kept = { round: n, snapshot, evidence, passing: new Set(outcomes.filter((o) => o.ok).map((o) => o.command)) }
        inPlace = evidence
        report(`gate round ${n}: ${regression ?? (failed === undefined ? 'checks passed' : `failed: ${failed.command}`)}`)
      }
    } else if (review !== undefined) {
      report(`gate round ${n}: reviewing…`)
      // A review that cannot run (no copy of the tree, a reviewer that will not
      // start) is infrastructure, not a verdict: one retry, then the gate stops.
      // Sending the agent another paid round with an empty report is what the
      // prototype did, and live it bought nothing. An abort is the run ending.
      let unavailable: string | undefined
      evidence = { kind: 'review', level: 1, passed: false, score: null }
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          evidence = verdictOf((await review(REVIEW + spec.task, snapshot.commit)).text)
          unavailable = undefined
          break
        } catch (error) {
          if (deps.signal?.aborted || (error as Error)?.name === 'AbortError') throw error
          unavailable = error instanceof Error ? error.message : String(error)
          report(`gate round ${n}: review could not run (attempt ${attempt}/2): ${unavailable}`)
        }
      }
      if (unavailable !== undefined) {
        evidence = { kind: 'review', level: 1, passed: false, score: null, error: unavailable }
        if (level === 1) {
          await stop({ round: n, result, snapshot: snapshot.commit, changed, evidence }, 'review unavailable')
          break
        }
        // Feedback only: the suite still measures this round.
      } else {
        inPlace = evidence
        feedback = JSON.stringify(
          { targets: evidence.targets ?? null, regressions: evidence.regressions ?? null, score: evidence.score ?? null },
          null,
          1,
        )
        report(`gate round ${n}: ${evidence.passed ? 'passed' : `not done (score ${evidence.score ?? 'unparsed'})`}`)
      }
    }

    let lower: GateEvidence | undefined
    if (hidden !== undefined) {
      report(`gate round ${n}: running the hidden suite…`)
      lower = evidence
      // A suite that cannot run (the verifier not reachable, a missing suite)
      // is infrastructure, like a review that cannot: one retry, then stop.
      let summary: HiddenSummary | undefined
      let unavailable = ''
      for (let attempt = 1; attempt <= 2 && summary === undefined; attempt++) {
        try {
          summary = await hidden.run(snapshot.commit)
        } catch (error) {
          if (deps.signal?.aborted) throw error
          unavailable = error instanceof Error ? error.message : String(error)
          report(`gate round ${n}: hidden suite could not run (attempt ${attempt}/2): ${unavailable}`)
        }
      }
      const extra = { ...(lower === undefined ? {} : { feedback: lower }), ...(advisory.length === 0 ? {} : { advisory }) }
      if (summary === undefined) {
        const evidence: GateEvidence = { kind: 'hidden', level: 3, passed: false, suite: hidden.suite, error: unavailable }
        await stop({ round: n, result, snapshot: snapshot.commit, changed, evidence, ...extra }, 'hidden suite unavailable')
        break
      }
      if (summary.enforcement !== 'full' && hidden.allowPartial !== true) {
        // A run that could write the suite where a member reads it is no L3
        // evidence; every run on this host would be the same, so the gate ends.
        const evidence: GateEvidence = { kind: 'hidden', level: 3, passed: false, suite: hidden.suite, enforcement: summary.enforcement }
        report(`gate round ${n}: the verifier could not confine the hidden suite (enforcement ${summary.enforcement})`)
        await stop({ round: n, result, snapshot: snapshot.commit, changed, evidence, ...extra }, 'hidden suite unconfined')
        break
      }
      evidence = {
        kind: 'hidden',
        level: 3,
        passed: summary.passed,
        suite: hidden.suite,
        total: summary.total,
        failed: summary.failed,
        enforcement: summary.enforcement,
        ...(summary.refused === undefined ? {} : { refused: summary.refused }),
      }
      inPlace = evidence
      // Counts only: names, output and source never leave the verifier. A
      // refused snapshot's reason names the member's own paths.
      const told = summary.refused === undefined ? `hidden acceptance suite: ${summary.failed} of ${summary.total} failing` : `hidden suite: snapshot refused: ${summary.refused}`
      feedback = [told, ...(feedback === '' ? [] : [feedback])].join('\n\n')
      report(`gate round ${n}: ${summary.passed ? 'hidden suite passed' : told}`)
    }

    const round: GateRound = {
      round: n,
      result,
      snapshot: snapshot.commit,
      changed,
      evidence: evidence!,
      ...(rolledBack ? { rolledBack } : {}),
      ...(lower === undefined ? {} : { feedback: lower }),
      ...(advisory.length === 0 ? {} : { advisory }),
    }
    rounds.push(round)
    await deps.record?.(round)
    if (evidence!.passed) {
      lastPassing = snapshot.commit
      break
    }
    prompt = continuation(spec.task, base.commit, tree.commit, level === 3 ? HIDDEN : level === 2 ? CHECKED : REVIEWED, feedback)
  }
  return {
    accepted: lastPassing !== undefined,
    level,
    base: base.commit,
    rounds,
    ...(lastPassing === undefined ? {} : { lastPassing }),
    ...(reason === undefined ? {} : { reason }),
    final: rounds.at(-1)!.result,
  }
}
