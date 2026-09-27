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
 * whole run and a `detail` summary once it settles. Killing that row cancels
 * the run.
 *
 * By default the command does not block (docs/05 A7): it starts the run and
 * returns its id at once. It used to await the team, because `JobView`
 * carries no output and a result returned early had nowhere a person could
 * read it. It has now: the run's journal, the Swarm tab (which shows a
 * finished run's result) and `openswarm attach`. When the run settles its
 * outcome is also injected into the invoking session as context for the next
 * turn; `inject` never wakes the driver, so that costs no lead model call.
 * `--wait` keeps the blocking form, returning the synthesis inline, for
 * surfaces that show only the command's own text.
 *
 * Where no registry is present, or no controller serves the agent, tracking
 * is skipped and the run proceeds untracked.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { coordinatorSpec } from './topologies'
import type { CoordinatorResult, MemberSpec } from './types'

export const name = 'openswarm-swarm-command'
export const inject = ['commands', 'swarm']

export interface SwarmCommandConfig {
  /** Workers used when the line does not ask for a count. Default 3. */
  workers?: number
  /** Largest worker count a line may ask for. Default 8. */
  maxWorkers?: number
}

const USAGE = 'Usage: /swarm [--wait] [--workers <n>] <task>'

interface SwarmLine {
  workers: number
  task: string
  /** Block until the run settles and return its synthesis inline. */
  wait?: true
}

/** Split optional leading `--workers N` and `--wait` flags off the line; the rest is the task. */
export function parseSwarmLine(
  rawInput: string,
  defaults: { workers: number; maxWorkers: number },
): SwarmLine | { error: string } {
  let workers = defaults.workers
  let wait = false
  let rest = rawInput.trim()
  let flag: RegExpExecArray | null
  while ((flag = /^--(?:(wait)|workers(?:=|\s+)(\S+))(?:\s+|$)/u.exec(rest)) !== null) {
    rest = rest.slice(flag[0].length)
    if (flag[1] !== undefined) {
      wait = true
      continue
    }
    const n = Number(flag[2])
    if (!Number.isInteger(n) || n < 1 || n > defaults.maxWorkers) {
      return { error: `--workers takes an integer 1-${defaults.maxWorkers}. ${USAGE}` }
    }
    workers = n
  }
  if (rest.length === 0) return { error: `No task given. ${USAGE}` }
  return { workers, task: rest, ...(wait ? { wait: true } : {}) }
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
  follow: AbortSignal | undefined,
): Tracker | undefined {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return undefined

  const pending: string[] = []
  // Killing the job must cancel the team, so the run rides this controller;
  // `follow`, the surface's own abort under `--wait`, is chained into it.
  const abort = new AbortController()
  if (follow?.aborted) abort.abort()
  else follow?.addEventListener('abort', () => abort.abort(), { once: true })

  let settle!: (outcome: JobOutcome) => void
  const done = new Promise<JobOutcome>((resolve) => (settle = resolve))
  let id: JobId
  try {
    id = jobs.start({
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
  // This command delivers the outcome itself, so it waits on its own job; a
  // pending wait marks the job reported at settlement, which keeps tool-jobs'
  // completion notice from opening a lead model turn just to say it finished.
  jobs.wait(id, 2 ** 31 - 1, invocation.agent).catch(() => undefined)
  return { report: (line) => pending.push(line), finish: settle, signal: abort.signal }
}

/**
 * A session is "blank" until something opens a turn, and command lifecycle
 * records deliberately never do — upstream's own fold says so: "Standalone
 * plugin events … never open a turn, so running `/plan` or `/goal` on a fresh
 * session keeps it blank (list-hidden, reusable)."
 *
 * That is fine for commands whose effect you read somewhere else (a goal bar,
 * a mode switch), but for `/swarm` the returned text IS the deliverable, and a
 * blank session leaves the composer on its landing screen so nothing renders.
 */
function isBlank(agent: Agent): boolean {
  return !agent.session.events.some((event) => event.type === 'turn/start')
}

/**
 * Put the command's reply (the started run, or under `--wait` its outcome)
 * into the conversation when the session would otherwise stay blank.
 * `followup` queues it as its own turn and wakes the driver, which both makes
 * the session non-blank — so the surface navigates in, the already-logged
 * `command/done` finally renders, and the Swarm tab appears — and leaves the
 * lead holding the reply, which is what a follow-up instruction needs.
 *
 * Only on a blank session: an established conversation already renders the
 * command result inline, and doing this there would spend a lead model round
 * to display something the user can already see.
 */
export function surfaceOnBlankSession(agent: Agent, text: string): void {
  if (!isBlank(agent)) return
  agent.followup(
    createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  )
}

/**
 * Hand a detached run's outcome to the session that started it, as context
 * for its next turn: `inject` queues it for the next step without waking the
 * driver. The live agent is looked up, as the invoking one may have been
 * replaced since; with none live, the journal still holds the result.
 */
function injectOutcome(ctx: Context, invoker: Agent, runId: string, text: string): void {
  ctx.get('agents')?.get(invoker.id)?.inject(
    createUserMessage({
      content: [{ type: 'text', text: `/swarm run ${runId} settled.\n\n${text}` }],
      source: { kind: 'plugin', plugin: 'openswarm-swarm', form: 'notice', summary: `/swarm ${runId} settled` },
    }),
  )
}

async function execute(
  ctx: Context,
  invocation: CommandInvocation,
  defaults: { workers: number; maxWorkers: number },
): Promise<CommandResult> {
  const parsed = parseSwarmLine(invocation.rawInput, defaults)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }
  const spec = coordinatorSpec(parsed.task, parsed.workers)
  // A detached run outlives the invocation, whose signal belongs to the UI
  // request, so only `--wait` rides it.
  const follow = parsed.wait ? invocation.signal : undefined
  const tracker = track(ctx, invocation, `/swarm ${invocation.rawInput.trim()}`, follow)
  const signal = tracker?.signal ?? follow
  const started = ctx.swarm.start(spec, {
    parent: invocation.agent,
    ...(signal === undefined ? {} : { signal }),
    ...(tracker === undefined ? {} : { onProgress: tracker.report }),
  })
  // The row settles, and the outcome renders, when the run does.
  const settled = started
    .then((run) => run.result)
    .then(asCoordinator)
    .then(
      (result) => {
        // `detail` replaces the generic status word on the settled row, so it
        // is the one place a shape summary is legible after the fact.
        tracker?.finish({
          status: 'completed',
          detail: `${result.subtasks.length} subtask(s) across ${parsed.workers} worker(s)`,
        })
        return { kind: 'success', text: renderCoordinatorResult(result) } as const
      },
      (error: unknown) => {
        tracker?.finish({
          status: tracker.signal.aborted ? 'killed' : 'failed',
          detail: errText(error),
        })
        return { kind: 'error', text: `swarm run failed: ${errText(error)}` } as const
      },
    )

  const run = parsed.wait ? undefined : await started.catch(() => undefined)
  if (run === undefined) {
    // `--wait`, or a run that never started: the outcome is the reply. A
    // blank session shows it only as a turn, failure or success alike.
    const outcome = await settled
    surfaceOnBlankSession(invocation.agent, outcome.text)
    return outcome
  }
  // ponytail: a failed inject only loses the notice; the journal, the Swarm
  // tab and `openswarm attach` still carry the result.
  void settled.then((outcome) => injectOutcome(ctx, invocation.agent, run.id, outcome.text)).catch(() => undefined)
  const text = `Started ${run.id}: coordinator with ${parsed.workers} worker(s). Follow it in the Swarm tab, or \`openswarm attach ${run.id}\`.`
  surfaceOnBlankSession(invocation.agent, text)
  return { kind: 'success', text }
}

export function apply(ctx: Context, config: SwarmCommandConfig = {}): void {
  const defaults = { workers: config.workers ?? 3, maxWorkers: config.maxWorkers ?? 8 }
  ctx.commands.register({
    name: 'swarm',
    description: 'start a coordinator-led team of agents on one task',
    input: { hint: '[--wait] [--workers <n>] <task>' },
    handler: (invocation) => execute(ctx, invocation, defaults),
  })
}
