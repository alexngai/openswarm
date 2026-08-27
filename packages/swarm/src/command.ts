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
 * ponytail: the handler awaits the whole team before returning, because a
 * CommandResult is the only channel the registry gives it. Long runs block the
 * command for their whole duration; streaming progress needs the team to write
 * into the session log, which is its own design.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
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

async function execute(
  ctx: Context,
  invocation: CommandInvocation,
  defaults: { workers: number; maxWorkers: number },
): Promise<CommandResult> {
  const parsed = parseSwarmLine(invocation.rawInput, defaults)
  if ('error' in parsed) return { kind: 'error', text: parsed.error }

  const workers: MemberSpec[] = Array.from({ length: parsed.workers }, (_, i) => ({
    name: `worker-${i + 1}`,
  }))
  const spec: CoordinatorSpec = {
    topology: 'coordinator',
    coordinator: { name: 'coordinator' },
    workers,
    task: parsed.task,
  }
  try {
    const result = await ctx.swarm.runTeam(spec, {
      parent: invocation.agent,
      signal: invocation.signal,
    })
    /* v8 ignore next -- the dispatcher returns the spec's own topology */
    if (result.topology !== 'coordinator') throw new TypeError(`unexpected result ${result.topology}`)
    return { kind: 'success', text: renderCoordinatorResult(result) }
  } catch (error) {
    return {
      kind: 'error',
      text: `swarm run failed: ${error instanceof Error ? error.message : String(error)}`,
    }
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
