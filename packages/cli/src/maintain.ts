/**
 * `openswarm maintain` (docs/05 C7b): the maintenance program.
 *
 * A survey member reads the repository's principles and the repository, in
 * a disposable clone of HEAD (as the gate's reviewer does, so whatever it
 * changes goes away with the clone), and proposes small independent tasks.
 * They run as a gated peer-team with worktrees and the train, the `--spec`
 * path, each under a task budget and all under a run budget; every task's
 * gate and the train check the operator's `--check` commands, and only
 * those: what the survey suggests for verifying a task goes into its prompt,
 * never into anything the harness executes (the gate runs checks in the lead's
 * environment, outside the member sandbox). The caps and the run budget the
 * team gets are what the survey left of them. The result is the landed
 * target branch, the checkout fast-forwarded to it when it can be, and with
 * `--summary` a markdown body for a pull request. Scheduling is cron or CI.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withSnapshotClone } from 'openswarm-git'
import { defaultRunsDir, landingText, memberEnvOf, reviewMemberConfig, runJournalPath, runLandings, runMemberProcess, type Pricing } from 'openswarm-swarm'
import { pricingOf } from './control'
import { bootHarness, foldSessionLogs, memberRouteOf, routeOf, runHeadless, sandboxUnavailable, splitArgv, type CliIo } from './index'

/**
 * The sign-off reviewer's brief (`gate.signoff`): the dogfood run's one bad
 * landing passed every check while weakening what a test verified, so a
 * maintenance task lands only once a reviewer has read its change and judged
 * it does the task, stays inside it, and weakens nothing.
 */
export const MAINTAIN_SIGNOFF = `You are signing off another engineer's maintenance change to this repository before it lands. Do not fix anything: your job is to judge. Read the task below and the change, and look at the files it touches. Accept only if the change does what the task asks, stays inside it, and removes or weakens nothing the repository relies on: no test made to check less than it did or something other than what it was for, no coverage deleted, no valid path, link or reference broken, no behavior changed beyond the task. The repository's checks already pass; that is not your question.

End your reply with exactly one line of JSON and nothing after it:
{"accept": true or false, "reasons": "<one or two sentences: what is wrong, or why it is fine>"}`

/** How long the survey may run before it is stopped. */
const SURVEY_TIMEOUT_MS = 20 * 60_000

export const MAINTAIN_USAGE =
  'usage: openswarm maintain --model <m> --principles <file> --check <cmd> [--check <cmd>]... [--tasks 5] [--members 2] [--rounds 3] ' +
  '[--budget-usd <n> --task-budget-usd <n> --pricing <file>] [--max-cost-usd <n>] [--max-tokens <n>] [--max-turns <n>] [--summary <file>] [--sandbox danger-full-access] [--no-review]'

export interface SurveyTask {
  subject: string
  prompt: string
  /** How to confirm it is done, as the survey suggests: told to the member, never run by the harness. */
  verify?: string[]
}

export function surveyPrompt(principles: string, max: number): string {
  return `You are surveying this repository for maintenance work against the principles below. Find where it falls short of them and propose up to ${max} tasks. Each task must be small enough for one engineer to finish and verify alone, independent of the others (no task may need another's change), and touch as few files as it can. Prefer clear violations over speculative ones; propose fewer tasks, or none, rather than weak ones. Do not fix anything: whatever you create or change here is discarded.

## Principles

${principles.trim()}

## Reply

End your reply with one JSON object, nothing after it:
{"tasks": [{"subject": "<short title>", "prompt": "<what to change, in which files, and why: enough for an engineer who has not read this survey>", "verify": ["<optional: a command the engineer can run to confirm it is done>"]}]}`
}

/**
 * The survey's tasks from its reply: the LAST `{"tasks": [...]}` object only
 * (an earlier draft, or the template the prompt echoes, never stands in for a
 * malformed final one), at most `max`. A task without a subject and a prompt
 * is dropped, and said so, rather than failing a survey already paid for.
 */
export function surveyTasks(text: string, max: number): { tasks: SurveyTask[]; dropped: string[] } {
  const start = [...text.matchAll(/\{\s*"tasks"\s*:/g)].at(-1)?.index
  if (start === undefined) throw new Error('the survey ended without a {"tasks": [...]} object')
  const body = text.slice(start)
  // It ends at some closing brace; the last first, so trailing prose or a fence is cut.
  for (let end = body.lastIndexOf('}'); end > 0; end = body.lastIndexOf('}', end - 1)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body.slice(0, end + 1))
    } catch {
      continue
    }
    const tasks = (parsed as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks)) throw new Error('the survey\'s "tasks" is not a list')
    return validTasks(tasks.slice(0, max))
  }
  throw new Error('the survey\'s final {"tasks": [...]} object is not valid JSON')
}

function validTasks(tasks: unknown[]): { tasks: SurveyTask[]; dropped: string[] } {
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
  const valid: SurveyTask[] = []
  const dropped: string[] = []
  tasks.forEach((t: any, i) => {
    if (!text(t?.subject) || !text(t?.prompt)) return void dropped.push(`task ${i}: needs a subject and a prompt`)
    const verify = Array.isArray(t.verify) ? t.verify.filter(text).map((v: string) => v.trim()) : []
    valid.push({ subject: t.subject.trim(), prompt: t.prompt.trim(), ...(verify.length === 0 ? {} : { verify }) })
  })
  return { tasks: valid, dropped }
}

/** The markdown a pull request carries: what landed, what did not and why, and the cost. */
export function summaryMarkdown(note: any, principles: string, runDir: string, survey: string, pricing?: Pricing): string {
  const landings = runLandings(runDir)
  const block = (l: (typeof landings)[number]) => {
    const [head, ...rest] = landingText(l, pricing)
    return [`- ${head!.trim()}`, ...rest.map((line) => `  - ${line.trim()}`)].join('\n')
  }
  const landed = landings.filter((l) => l.outcome === 'landed')
  const other = landings.filter((l) => l.outcome !== 'landed')
  const abandoned = Object.entries((note.abandoned ?? {}) as Record<string, string>)
  const dollars = note.metrics?.dollars?.total
  return [
    `# Maintenance: ${landed.length} task(s) landed`,
    '',
    `Against \`${principles}\`; run \`${note.runId}\`, target branch \`${note.targetBranch}\`. Every landed task passed its gate and the train's checks on the integrated tree.`,
    '',
    '## Landed',
    '',
    landed.length === 0 ? 'Nothing.' : landed.map(block).join('\n'),
    ...(other.length === 0 ? [] : ['', '## Not landed', '', other.map(block).join('\n')]),
    ...(abandoned.length === 0 ? [] : ['', '## Abandoned', '', abandoned.map(([id, why]) => `- ${id}: ${why}`).join('\n')]),
    ...(note.stopped === undefined ? [] : ['', `The train stopped early: ${note.stopped}.`]),
    '',
    `Checkout: ${note.workspace ?? 'not reported'}.`,
    '',
    `Cost: the team ${note.metrics?.tokens?.total ?? '?'} tokens${typeof dollars === 'number' ? `, $${dollars.toFixed(2)}` : ''}; the survey ${survey}.`,
    '',
  ].join('\n')
}

/** The summary when nothing reached the team's landing: why, so a stale file never stands in for it. */
function failureSummary(principles: string, why: string): string {
  return `# Maintenance: nothing landed\n\nAgainst \`${principles}\`: ${why}\n`
}

/** Every value of a flag given more than once, e.g. `--check a --check b`. */
const valuesOf = (argv: string[], flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] !== undefined ? [argv[i + 1]!] : []))

function count(args: Map<string, string>, name: string, fallback: number): number {
  const raw = args.get(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
  return n
}

function amount(args: Map<string, string>, name: string): number | undefined {
  const raw = args.get(name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`)
  return n
}

export async function runMaintain(argv: string[], io: CliIo): Promise<number> {
  const { args } = splitArgv(argv)
  const model = args.get('model')
  const principlesPath = args.get('principles')
  const checks = valuesOf(argv, '--check')
  if (model === undefined || principlesPath === undefined) throw new Error(`--model and --principles are required\n${MAINTAIN_USAGE}`)
  // It lands unattended, so the landed tree must pass something.
  if (checks.length === 0) throw new Error(`a maintenance run needs at least one --check its landed tree must pass\n${MAINTAIN_USAGE}`)
  // Every flag checked before the survey spends anything.
  const max = count(args, 'tasks', 5)
  const members = count(args, 'members', 2)
  const rounds = count(args, 'rounds', 3)
  const budgetUsd = amount(args, 'budget-usd')
  const taskBudgetUsd = amount(args, 'task-budget-usd')
  const maxCostUsd = amount(args, 'max-cost-usd')
  const maxTokens = args.has('max-tokens') ? count(args, 'max-tokens', 0) : undefined
  const maxTurns = args.has('max-turns') ? count(args, 'max-turns', 0) : undefined
  const pricing = pricingOf(args.get('pricing'))
  const route = routeOf(model)
  const rate = pricing?.[route.model]
  // An unpriced dollar limit stops at its first check when unattended, or cannot be checked at all; refuse it.
  if ((budgetUsd !== undefined || taskBudgetUsd !== undefined || maxCostUsd !== undefined) && rate === undefined) {
    throw new Error(`--budget-usd, --task-budget-usd and --max-cost-usd need --pricing <file> with a price for ${route.model}`)
  }
  // The survey and the members run confined unless the operator says otherwise: a
  // host that cannot confine (Ubuntu 24.04 restricts unprivileged user namespaces)
  // runs them unfenced only on an explicit `--sandbox danger-full-access`.
  const sandbox = args.get('sandbox') ?? 'workspace-write'
  if (sandbox !== 'workspace-write' && sandbox !== 'danger-full-access') throw new Error(`--sandbox must be workspace-write or danger-full-access, not ${sandbox}`)
  const summary = args.get('summary')
  // Never a stale summary from an earlier run standing in for this one's.
  if (summary !== undefined) rmSync(summary, { force: true })
  const fail = (why: string, code: number) => {
    if (summary !== undefined) writeFileSync(summary, failureSummary(principlesPath, why))
    return code
  }
  const principles = readFileSync(principlesPath, 'utf8')
  const workspace = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()
  const temp = mkdtempSync(join(tmpdir(), 'openswarm-maintain-'))
  try {
    // The survey: a subprocess member in a disposable clone of HEAD, as the gate's reviewer runs,
    // stopped past SURVEY_TIMEOUT_MS.
    const memberRoute = memberRouteOf(route)
    const sessions = join(temp, 'survey-sessions')
    const harness = await bootHarness({ routes: [route], workspace, io })
    let survey: { tasks: SurveyTask[]; dropped: string[] }
    let spent: ReturnType<typeof foldSessionLogs>
    try {
      const unsandboxable = sandbox === 'workspace-write' ? sandboxUnavailable(harness.ctx) : undefined
      if (unsandboxable !== undefined) {
        throw new Error(`the survey and the members run under the workspace-write sandbox, which this host cannot provide (${unsandboxable}); pass --sandbox danger-full-access to run them unfenced`)
      }
      const result = await withSnapshotClone(workspace, head, (cwd) =>
        runMemberProcess(harness.ctx, { name: 'survey', agentOptions: memberRoute.agentOptions }, surveyPrompt(principles, max), {
          cwd,
          env: memberEnvOf({ env: { ...memberRoute.env, DSH_SESSION_ROOT: sessions, OPENSWARM_MEMBER_SANDBOX: sandbox } }, `survey-${process.pid}`),
          parent: harness.lead.agent,
          signal: AbortSignal.timeout(SURVEY_TIMEOUT_MS),
          config: { configPath: reviewMemberConfig() },
        }),
      )
      survey = surveyTasks(result.text, max)
    } catch (error) {
      fail(`the survey failed: ${error instanceof Error ? error.message : String(error)}`, 1)
      throw error
    } finally {
      spent = foldSessionLogs(sessions)
      await harness.dispose()
    }
    const surveyUsd = rate === undefined ? undefined : (spent.inputTokens * rate.input + spent.outputTokens * rate.output + spent.cacheReadInputTokens * (rate.cacheRead ?? rate.input) + spent.cacheWriteInputTokens * (rate.cacheWrite ?? rate.input)) / 1e6
    const surveyCost = `${spent.totalTokens} tokens${surveyUsd === undefined ? '' : `, $${surveyUsd.toFixed(2)}`}`
    io.out(JSON.stringify({ type: 'survey_note', usage: spent, ...(surveyUsd === undefined ? {} : { usd: surveyUsd }), dropped: survey.dropped }))
    io.out(JSON.stringify({ type: 'survey', tasks: survey.tasks }))
    if (survey.tasks.length === 0) {
      io.out(JSON.stringify({ type: 'team_note', landed: [], note: 'the survey proposed nothing' }))
      return fail(`the survey proposed nothing (${surveyCost}).`, 0)
    }

    // The caps and the run budget cover the survey too: the team gets what it left.
    const left = (cap: number | undefined, used: number) => (cap === undefined ? undefined : cap - used)
    const costLeft = left(maxCostUsd, surveyUsd ?? 0)
    const tokensLeft = left(maxTokens, spent.totalTokens)
    const turnsLeft = left(maxTurns, spent.calls)
    const budgetLeft = left(budgetUsd, surveyUsd ?? 0)
    const out = [costLeft !== undefined && costLeft <= 0 && 'max-cost-usd', tokensLeft !== undefined && tokensLeft <= 0 && 'max-tokens', turnsLeft !== undefined && turnsLeft <= 0 && 'max-turns'].find(Boolean)
    if (out) {
      io.out(JSON.stringify({ type: 'budget_exceeded', limit: `${out} (spent by the survey: ${surveyCost})` }))
      return fail(`the survey alone spent the ${out} cap (${surveyCost}).`, 3)
    }
    if (budgetLeft !== undefined && budgetLeft <= 0) return fail(`the survey alone spent the $${budgetUsd} run budget (${surveyCost}).`, 1)

    const spec = {
      topology: 'peer-team',
      intent: { purpose: `bring the repository closer to its principles (${principlesPath})`, endState: `every check passes on the landed tree: ${checks.join('; ')}` },
      members: Array.from({ length: members }, (_, i) => ({ name: `maintainer-${i + 1}` })),
      // One attempt: a task that does not pass in its rounds is abandoned, and what passed lands (C7a).
      maxTaskAttempts: 1,
      // A reviewer signs off each task's change once its checks pass, unless --no-review.
      gate: { rounds, checks, ...(args.has('no-review') ? {} : { signoff: MAINTAIN_SIGNOFF }) },
      tasks: survey.tasks.map((t) => ({
        subject: t.subject,
        prompt: t.verify === undefined ? t.prompt : `${t.prompt}\n\nThe survey suggests confirming it with: ${t.verify.join('; ')}`,
        ...(taskBudgetUsd === undefined ? {} : { budget: { usd: taskBudgetUsd } }),
      })),
      ...(budgetLeft === undefined ? {} : { budget: { usd: budgetLeft } }),
      worktrees: { train: { checks }, member: { sandbox } },
    }
    const specPath = join(temp, 'team.json')
    writeFileSync(specPath, JSON.stringify(spec, null, 1))
    let note: any
    const tap: CliIo = {
      out: (line) => {
        try {
          const event = JSON.parse(line)
          if (event?.type === 'team_note') note = event
        } catch {}
        io.out(line)
      },
      err: io.err,
    }
    const caps = [
      ...(costLeft === undefined ? [] : ['--max-cost-usd', String(costLeft)]),
      ...(tokensLeft === undefined ? [] : ['--max-tokens', String(tokensLeft)]),
      ...(turnsLeft === undefined ? [] : ['--max-turns', String(turnsLeft)]),
      ...(['pricing', 'permission-mode'] as const).flatMap((flag) => (args.has(flag) ? [`--${flag}`, args.get(flag)!] : [])),
    ]
    // The sign-off reviewer runs under the members' sandbox, for this run.
    const reviewerSandbox = process.env['OPENSWARM_GATE_REVIEWER_SANDBOX']
    process.env['OPENSWARM_GATE_REVIEWER_SANDBOX'] = sandbox
    let code: number
    try {
      code = await runHeadless(
        ['--output-format', 'json', '--model', model, '--spec', specPath, ...caps, `Maintain this repository against its principles (${principlesPath}). Do only this task; leave everything else as it is.`],
        tap,
      )
    } catch (error) {
      fail(`the team run failed before landing anything it could report: ${error instanceof Error ? error.message : String(error)}`, 1)
      throw error
    } finally {
      if (reviewerSandbox === undefined) delete process.env['OPENSWARM_GATE_REVIEWER_SANDBOX']
      else process.env['OPENSWARM_GATE_REVIEWER_SANDBOX'] = reviewerSandbox
    }
    if (note?.runId === undefined) return fail(`the team run ended without a landing report (exit ${code}${code === 3 ? ', a cap tripped' : ''}).`, code)
    if (summary !== undefined) writeFileSync(summary, summaryMarkdown(note, principlesPath, dirname(runJournalPath(defaultRunsDir(), note.runId)), surveyCost, pricing))
    return code
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
