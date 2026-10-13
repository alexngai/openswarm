/**
 * `openswarm maintain` (docs/05 C7b): the maintenance program.
 *
 * A survey member reads the repository's principles and the repository, in
 * a disposable clone of HEAD (as the gate's reviewer does, so whatever it
 * changes goes away with the clone), and proposes small independent tasks.
 * They run as a gated peer-team with worktrees and the train, the `--spec`
 * path, each under a task budget and all under a run budget; every task's
 * gate and the train check the `--check` commands. The result is the landed
 * target branch, the checkout fast-forwarded to it when it can be, and with
 * `--summary` a markdown body for a pull request. Scheduling is cron or CI.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { withSnapshotClone } from 'openswarm-git'
import { defaultRunsDir, landingText, memberEnvOf, reviewMemberConfig, runJournalPath, runLandings, runMemberProcess, type Pricing } from 'openswarm-swarm'
import { pricingOf } from './control'
import { bootHarness, foldSessionLogs, memberRouteOf, routeOf, runHeadless, sandboxUnavailable, splitArgv, type CliIo } from './index'

export const MAINTAIN_USAGE =
  'usage: openswarm maintain --model <m> --principles <file> --check <cmd> [--check <cmd>]... [--tasks 5] [--members 2] [--rounds 3] ' +
  '[--budget-usd <n> --task-budget-usd <n> --pricing <file>] [--max-cost-usd <n>] [--summary <file>]'

export interface SurveyTask {
  subject: string
  prompt: string
  checks?: string[]
}

export function surveyPrompt(principles: string, max: number): string {
  return `You are surveying this repository for maintenance work against the principles below. Find where it falls short of them and propose up to ${max} tasks. Each task must be small enough for one engineer to finish and verify alone, independent of the others (no task may need another's change), and touch as few files as it can. Prefer clear violations over speculative ones; propose fewer tasks, or none, rather than weak ones. Do not fix anything: whatever you create or change here is discarded.

## Principles

${principles.trim()}

## Reply

End your reply with one JSON object, nothing after it:
{"tasks": [{"subject": "<short title>", "prompt": "<what to change, in which files, and why: enough for an engineer who has not read this survey>", "checks": ["<optional: a shell command that exits 0 once this task is done>"]}]}`
}

/** The survey's tasks: the last `{"tasks": [...]}` object in its reply, validated, at most `max`. */
export function surveyTasks(text: string, max: number): SurveyTask[] {
  const starts = [...text.matchAll(/\{\s*"tasks"\s*:/g)].map((m) => m.index!).reverse()
  for (const start of starts) {
    const body = text.slice(start)
    // The object ends at some closing brace; try the last first, so trailing prose or a fence is cut.
    for (let end = body.lastIndexOf('}'); end > 0; end = body.lastIndexOf('}', end - 1)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.slice(0, end + 1))
      } catch {
        continue
      }
      return validTasks((parsed as { tasks?: unknown }).tasks, max)
    }
  }
  throw new Error('the survey ended without a {"tasks": [...]} object')
}

function validTasks(tasks: unknown, max: number): SurveyTask[] {
  if (!Array.isArray(tasks)) throw new Error('the survey\'s "tasks" is not a list')
  const text = (v: unknown) => typeof v === 'string' && v.trim() !== ''
  return tasks.slice(0, max).map((t, i) => {
    if (!text(t?.subject) || !text(t?.prompt)) throw new Error(`survey task ${i} needs a subject and a prompt`)
    if (t.checks !== undefined && !(Array.isArray(t.checks) && t.checks.every(text))) throw new Error(`survey task ${i}: checks must be a list of commands`)
    return { subject: t.subject.trim(), prompt: t.prompt.trim(), ...(t.checks?.length ? { checks: t.checks as string[] } : {}) }
  })
}

/** The markdown a pull request carries: what landed, what did not and why, and the cost. */
export function summaryMarkdown(note: any, principles: string, runDir: string, pricing?: Pricing): string {
  const landings = runLandings(runDir)
  const block = (l: (typeof landings)[number]) => {
    const [head, ...rest] = landingText(l, pricing)
    return [`- ${head!.trim()}`, ...rest.map((line) => `  - ${line}`)].join('\n')
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
    '',
    `Cost: ${note.metrics?.tokens?.total ?? '?'} tokens${typeof dollars === 'number' ? `, $${dollars.toFixed(2)}` : ''} (the survey's own is in its \`survey_note\`).`,
    '',
  ].join('\n')
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
  const max = count(args, 'tasks', 5)
  const members = count(args, 'members', 2)
  const rounds = count(args, 'rounds', 3)
  const budgetUsd = amount(args, 'budget-usd')
  const taskBudgetUsd = amount(args, 'task-budget-usd')
  const pricing = pricingOf(args.get('pricing'))
  const route = routeOf(model)
  // An unpriced dollar budget stops at its first check when unattended; refuse it instead.
  if ((budgetUsd !== undefined || taskBudgetUsd !== undefined) && pricing?.[route.model] === undefined) {
    throw new Error(`--budget-usd and --task-budget-usd need --pricing <file> with a price for ${route.model}`)
  }
  const principles = readFileSync(principlesPath, 'utf8')
  const workspace = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim()

  // The survey: a subprocess member in a disposable clone of HEAD, as the gate's reviewer runs.
  const memberRoute = memberRouteOf(route)
  const sessions = mkdtempSync(join(tmpdir(), 'openswarm-survey-sessions-'))
  const harness = await bootHarness({ routes: [route], workspace, io })
  let tasks: SurveyTask[]
  try {
    const unsandboxable = sandboxUnavailable(harness.ctx)
    if (unsandboxable !== undefined) throw new Error(`the survey runs under the workspace-write sandbox, which this host cannot provide (${unsandboxable})`)
    const result = await withSnapshotClone(workspace, head, (cwd) =>
      runMemberProcess(harness.ctx, { name: 'survey', agentOptions: memberRoute.agentOptions }, surveyPrompt(principles, max), {
        cwd,
        env: memberEnvOf({ env: { ...memberRoute.env, DSH_SESSION_ROOT: sessions, OPENSWARM_MEMBER_SANDBOX: 'workspace-write' } }, `survey-${process.pid}`),
        parent: harness.lead.agent,
        config: { configPath: reviewMemberConfig() },
      }),
    )
    tasks = surveyTasks(result.text, max)
  } finally {
    io.out(JSON.stringify({ type: 'survey_note', usage: foldSessionLogs(sessions) }))
    await harness.dispose()
  }
  io.out(JSON.stringify({ type: 'survey', tasks }))
  if (tasks.length === 0) {
    io.out(JSON.stringify({ type: 'team_note', landed: [], note: 'the survey proposed nothing' }))
    return 0
  }

  const spec = {
    topology: 'peer-team',
    intent: { purpose: `bring the repository closer to its principles (${principlesPath})`, endState: `every check passes on the landed tree: ${checks.join('; ')}` },
    members: Array.from({ length: members }, (_, i) => ({ name: `maintainer-${i + 1}` })),
    // One attempt: a task that does not pass in its rounds is abandoned, and what passed lands (C7a).
    maxTaskAttempts: 1,
    gate: { rounds, checks },
    tasks: tasks.map((t) => ({
      subject: t.subject,
      prompt: t.prompt,
      // A task's checks replace the team's, so the survey's add to them rather than weaken the gate.
      ...(t.checks === undefined ? {} : { checks: [...checks, ...t.checks] }),
      ...(taskBudgetUsd === undefined ? {} : { budget: { usd: taskBudgetUsd } }),
    })),
    ...(budgetUsd === undefined ? {} : { budget: { usd: budgetUsd } }),
    worktrees: { train: { checks }, member: { sandbox: 'workspace-write' } },
  }
  const specPath = join(mkdtempSync(join(tmpdir(), 'openswarm-maintain-')), 'team.json')
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
  const passthrough = ['pricing', 'max-cost-usd', 'max-tokens', 'permission-mode'].flatMap((flag) => (args.has(flag) ? [`--${flag}`, args.get(flag)!] : []))
  const code = await runHeadless(
    ['--output-format', 'json', '--model', model, '--spec', specPath, ...passthrough, `Maintain this repository against its principles (${principlesPath}). Do only this task; leave everything else as it is.`],
    tap,
  )
  const summary = args.get('summary')
  if (summary !== undefined && note?.runId !== undefined) {
    writeFileSync(summary, summaryMarkdown(note, principlesPath, dirname(runJournalPath(defaultRunsDir(), note.runId)), pricing))
  }
  return code
}
