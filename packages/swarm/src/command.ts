/**
 * `/swarm` — the human entry point to `ctx.swarm` from any dsh UI surface
 * (the browser UI, a TUI), closing the docs/01 ledger's `ctx.commands` row.
 *
 * The line is one free-form task: a coordinator decomposes it into numbered
 * subtasks, N workers run them concurrently, and the coordinator synthesizes.
 * Members inherit the receiving agent's model route, so the command needs no
 * provider configuration of its own.
 *
 * Mounted as its own bundle row (`openswarm-swarm/command`) rather than from
 * SwarmService, so contexts without a command registry — the eval CLI, the
 * test boots — still load the service.
 *
 * Progress is reported by registering the run with `ctx.jobs`, so dsh's jobs
 * popover carries a live row (label, status, ticking elapsed clock) for the
 * whole run and a `detail` summary once it settles — the feedback a blocking
 * command otherwise denies. Killing that row cancels the team.
 *
 * The command still AWAITS the team and returns the rendered synthesis
 * inline. That is deliberate: `JobView` carries no output, and
 * `dsh-client-ui-jobs` documents its rows as read-only ("a job's streamed
 * output and a human-initiated cancellation are separate phases"), so
 * returning early would leave the result somewhere no human surface can read.
 * Progress lines still feed `readOutput()`, whose consumer is the
 * model-facing `job_read` tool.
 *
 * Where no registry is present, or no controller serves the agent, tracking
 * is skipped and the run proceeds untracked.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { CoordinatorResult, CoordinatorSpec, MemberSpec } from './types'

export const name = 'openswarm-swarm-command'
export const inject = ['commands', 'swarm']

export interface SwarmCommandConfig {
  /** Workers used when the line does not ask for a count. Default 3. */
  workers?: number
  /** Largest worker count a line may ask for. Default 8. */
  maxWorkers?: number
}

const USAGE = 'Usage: /swarm [--workers <n>] <task>'

interface SwarmLine {
  workers: number
  task: string
}

/** Split an optional leading `--workers N` off the line; the rest is the task. */
export function parseSwarmLine(
  rawInput: string,
  defaults: { workers: number; maxWorkers: number },
): SwarmLine | { error: string } {
  let workers = defaults.workers
  let rest = rawInput.trim()
  const flag = /^--workers(?:=|\s+)(\S+)\s*/u.exec(rest)
  if (flag !== null) {
    const n = Number(flag[1])
    if (!Number.isInteger(n) || n < 1 || n > defaults.maxWorkers) {
      return { error: `--workers takes an integer 1-${defaults.maxWorkers}. ${USAGE}` }
    }
    workers = n
    rest = rest.slice(flag[0].length).trim()
  }
  if (rest.length === 0) return { error: `No task given. ${USAGE}` }
  return { workers, task: rest }
}

/** One settled coordinator run as the text a UI renders under the command. */
export function renderCoordinatorResult(result: CoordinatorResult): string {
  const workers = new Set(result.subtasks.map((s) => s.worker))
  return [
    `Swarm finished: ${result.subtasks.length} subtask(s) across ${workers.size} worker(s).`,
    ...result.subtasks.map((s, i) => `  ${i + 1}. [${s.worker}] ${s.prompt}`),
    '',
    result.synthesis.text,
  ].join('\n')
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The team as a coordinator spec over N anonymous workers. */
function specFor(task: string, workerCount: number): CoordinatorSpec {
  return {
    topology: 'coordinator',
    coordinator: { name: 'coordinator' },
    workers: Array.from({ length: workerCount }, (_, i) => ({ name: `worker-${i + 1}` })),
    task,
  }
}

function asCoordinator(result: { topology: string }): CoordinatorResult {
  /* v8 ignore next -- the dispatcher returns the spec's own topology */
  if (result.topology !== 'coordinator') throw new TypeError(`unexpected result ${result.topology}`)
  return result as CoordinatorResult
}

/** A live job row standing in for the run, plus the signal that cancels it. */
interface Tracker {
  report: (line: string) => void
  finish: (outcome: JobOutcome) => void
  signal: AbortSignal
}

/**
 * Put a live row in the surface's job list for the duration of the run.
 * Returns `undefined` when no registry is present or it refuses the start
 * (no controller serves this agent) — the run then proceeds untracked.
 *
 * The row is the progress surface: status plus a ticking elapsed clock while
 * live, and the producer `detail` once settled. `readOutput` drains the
 * progress buffer for `job_read`.
 */
function track(
  ctx: Context,
  invocation: CommandInvocation,
  label: string,
): Tracker | undefined {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return undefined

  const pending: string[] = []
  // Killing the job must cancel the team, so the run rides this controller
  // rather than the invocation signal directly; the surface's own abort is
  // chained into it.
  const abort = new AbortController()
  if (invocation.signal.aborted) abort.abort()
  else invocation.signal.addEventListener('abort', () => abort.abort(), { once: true })

  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => (settle = resolve))
  try {
    jobs.start({
      // `subagent`, not a bespoke kind: JobKindMap is re-exported rather than
      // declared by the entry module, so it cannot be merged from here — and a
      // swarm IS subagent work. The label carries the real identity.
      kind: 'subagent',
      label,
      owner: invocation.agent,
      run: () => ({
        cancel: () => abort.abort(),
        done,
        readOutput: () => pending.splice(0).map((l) => `${l}\n`).join(''),
      }),
    })
  } catch {
    return undefined
  }
  return { report: (line) => pending.push(line), finish: settle, signal: abort.signal }
}

async function execute(
  ctx: Context,
  invocation: CommandInvocation,
  defaults: { workers: number; maxWorkers: number },
): Promise<CommandResult> {
  const parsed = parseSwarmLine(invocation.rawInput, defaults)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  const spec = specFor(parsed.task, parsed.workers)
  const tracker = track(ctx, invocation, `/swarm ${invocation.rawInput.trim()}`)

  try {
    const result = asCoordinator(
      await ctx.swarm.runTeam(spec, {
        parent: invocation.agent,
        signal: tracker?.signal ?? invocation.signal,
        ...(tracker === undefined ? {} : { onProgress: tracker.report }),
      }),
    )
    // `detail` replaces the generic status word on the settled row, so it is
    // the one place a shape summary is legible after the fact.
    tracker?.finish({
      status: 'completed',
      detail: `${result.subtasks.length} subtask(s) across ${parsed.workers} worker(s)`,
    })
    return { kind: 'success', text: renderCoordinatorResult(result) }
  } catch (error) {
    tracker?.finish({
      status: tracker.signal.aborted ? 'killed' : 'failed',
      detail: errText(error),
    })
    return { kind: 'error', text: `swarm run failed: ${errText(error)}` }
  }
}

export function apply(ctx: Context, config: SwarmCommandConfig = {}): void {
  const defaults = { workers: config.workers ?? 3, maxWorkers: config.maxWorkers ?? 8 }
  ctx.commands.register({
    name: 'swarm',
    description: 'run a coordinator-led team of agents on one task',
    input: { hint: '[--workers <n>] <task>' },
    handler: (invocation) => execute(ctx, invocation, defaults),
  })
}
