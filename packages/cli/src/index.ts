/**
 * `openswarm topology cascade` on the dsh-based stack (docs/01 Phase 5).
 *
 * Implements the legacy CLI contract the eval harness (`swarmkit-eval` +
 * legacy/eval CascadeAdapter) drives inside SWE sandboxes, so `CS_BIN` can
 * point here with zero adapter changes:
 *
 *   openswarm topology cascade --spec team.json --output results.jsonl \
 *     --trace-output trace.jsonl --model <m> --permission-mode <m> \
 *     --headless --output-format json
 *
 * - spec: `{ members: [{id, role, prompt, model}], coordination:
 *   { escalationTau, escalationEvaluator: 'command', escalationCommands } }`
 *   — members are ordered cascade tiers, cheap first.
 * - stdout: JSONL for `openSwarmParse` — `text_delta`, `tool_use_start`,
 *   `message_stop {usage}`, `error`.
 * - --output: a `{type:'team_usage', byModel, team}` line (legacy
 *   UsageTotals field names).
 * - --trace-output: a line containing `after N escalation(s)`.
 *
 * Members run in-process (the sandbox IS the isolated workspace) over the
 * real spine; usage folds from `assistant/message` session events per member
 * session, attributed to models via the tier list.
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as LlmOpenAi from 'openswarm-llm-openai'
import * as LlmAnthropic from 'openswarm-llm-anthropic'
import SwarmService, { type CascadeResult, type CoordinatorResult, type MemberSpec } from 'openswarm-swarm'
import * as Spine from '@deepseek-ai/dsh-agent-spine-demo'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Subagent from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'

const plug = (m: unknown): any => (m as any).default ?? m

interface LegacyMember {
  id: string
  role?: string
  prompt: string
  model: string
}

interface LegacySpec {
  name?: string
  topology: string
  members: LegacyMember[]
  coordination?: {
    escalationTau?: number
    escalationEvaluator?: string
    escalationCommand?: string
    escalationCommands?: string[]
  }
}

/** Legacy UsageTotals field names (readTeamUsage contract). */
interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  totalTokens: number
  calls: number
  costUsd: number
}

const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  totalTokens: 0,
  calls: 0,
  costUsd: 0,
})

/**
 * Map an eval model string to an adapter route + wire model.
 * - `azureoai/<m>` → Azure's OpenAI-compatible surface (AZURE_API_BASE/KEY).
 * - Bedrock/Anthropic ids (`us.anthropic.…`, `anthropic.…`, `claude-…`) →
 *   the Anthropic Messages adapter (bedrock backend, bearer token).
 * - anything else → the generic OpenAI-compatible route
 *   (OPENSWARM_LLM_BASE_URL/KEY — LiteLLM, mock, any Bearer endpoint).
 */
interface Route {
  route: string
  model: string
  adapter: 'openai' | 'anthropic'
  baseURL?: string
  apiKeyEnv?: string
}

function routeOf(model: string): Route {
  if (model.startsWith('azureoai/')) {
    const base = process.env['AZURE_API_BASE']
    if (base === undefined || base.length === 0) {
      throw new Error(`model "${model}" needs AZURE_API_BASE in the environment`)
    }
    return {
      route: 'azure',
      model: model.slice('azureoai/'.length),
      adapter: 'openai',
      baseURL: `${base.replace(/\/+$/, '')}/openai/v1`,
      apiKeyEnv: 'AZURE_API_KEY',
    }
  }
  if (/(^|\.)anthropic\.|^claude-/i.test(model)) {
    return { route: 'bedrock', model, adapter: 'anthropic' }
  }
  return { route: 'openai', model, adapter: 'openai', apiKeyEnv: 'OPENSWARM_LLM_API_KEY' }
}

/**
 * Flags that never take a value. Declared rather than inferred: the
 * "next token isn't a flag, so it must be my value" heuristic makes
 * `--single "do the thing"` swallow the prompt, which fails as a missing task
 * rather than as a parse error.
 */
const BOOL_FLAGS = new Set(['headless', 'single', 'team'])

function parseArgs(argv: string[]): Map<string, string> {
  return splitArgv(argv).args
}

/**
 * Flags and positionals from ONE scan.
 *
 * Deriving positionals separately (e.g. "not a flag, and not preceded by one"
 * via indexOf) silently drops a prompt word that happens to repeat an earlier
 * token — the prompt is the task, so that corrupts the run rather than failing it.
 */
function splitArgv(argv: string[]): { args: Map<string, string>; positional: string[] } {
  const args = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const name = a.slice(2)
    if (BOOL_FLAGS.has(name)) {
      args.set(name, '1')
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(name, next)
      i++
    } else {
      args.set(name, '1')
    }
  }
  return { args, positional }
}

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

export async function runCli(argv: string[], io: CliIo = processIo): Promise<number> {
  const [command, sub] = argv
  const isCascade = command === 'topology' && sub === 'cascade'
  // `run` is OPTIONAL, matching bin/openswarm.mjs and the v0.x contract the eval
  // harness was written against: `openswarm <flags> "<task>"` with the prompt
  // positional. openSwarmSpec.flags() emits no verb, so requiring one made every
  // harness cell exit 2 on the usage message — a well-formed run, zero tokens.
  const rest = command === 'run' ? argv.slice(1) : argv
  const isRun = command === 'run' || (!isCascade && command !== 'topology' && rest.some((a) => !a.startsWith('--')))
  if (!isCascade && !isRun) {
    io.err(
      `usage: openswarm topology cascade --spec <file> [--output <file>] [--trace-output <file>]\n` +
        `       openswarm run --output-format json --model <m> [--single|--team] "<prompt>"`,
    )
    return 2
  }
  try {
    if (isRun) return await runHeadless(rest, io)
    return await runTopologyCascade(parseArgs(argv.slice(2)), io)
  } catch (error) {
    io.out(JSON.stringify({ type: 'error', message: String(error instanceof Error ? error.message : error) }))
    io.err(String(error instanceof Error ? (error.stack ?? error.message) : error))
    return 1
  }
}

/** dsh's sandbox policy modes — the vocabulary `--permission-mode` speaks. */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

/**
 * Claude-Code permission vocabulary → dsh sandbox modes.
 *
 * The eval harnesses speak Claude Code's names — `CliHarnessAdapter` even falls
 * back to `bypassPermissions` when no mode is configured — so refusing them
 * would break every caller that sets `permissionMode`. These three have exact
 * counterparts, so translating is not a downgrade.
 *
 * `default` is deliberately absent: it means "ask a human per action", and
 * headless there is nobody to ask. Any mode we picked for it would silently
 * change what the agent is allowed to do, so it is rejected instead.
 */
const MODE_ALIASES: Record<string, string> = {
  bypassPermissions: 'danger-full-access',
  acceptEdits: 'workspace-write',
  plan: 'read-only',
}

/**
 * Validate `--permission-mode`, defaulting to full access.
 *
 * Rejects an unknown mode instead of falling back. A silent downgrade would
 * leave the agent unable to edit, which surfaces as the agent failing the task
 * rather than as a misconfigured run — a wrong number, not an error.
 */
function sandboxModeOf(mode: string | undefined): string {
  if (mode === undefined) return 'danger-full-access'
  const resolved = MODE_ALIASES[mode] ?? mode
  if (!(SANDBOX_MODES as readonly string[]).includes(resolved)) {
    throw new Error(
      `unknown --permission-mode "${mode}" (expected ${SANDBOX_MODES.join(' | ')}` +
        `, or one of ${Object.keys(MODE_ALIASES).join(' | ')})`,
    )
  }
  return resolved
}

/** Everything a headless run needs, booted once. */
export interface HarnessBoot {
  ctx: any
  lead: any
  /** Per-session usage, folded live off `session/event`. */
  usageBySession: Map<string, UsageTotals>
  /** Assistant turns seen so far, across every session. */
  turns: () => number
  dispose: () => Promise<void>
}

export interface BootOptions {
  routes: Route[]
  workspace: string
  io: CliIo
  /** Sandbox policy mode (see `--permission-mode`). */
  permissionMode?: string
  /**
   * Called after each usage fold with the running team total. Return `true` to
   * request a stop — the caller decides what that means (see `--max-tokens`).
   */
  onUsage?: (team: UsageTotals, turns: number) => void
}

/**
 * Mount the harness stack and open a lead agent.
 *
 * This is the ONLY place the plugin list lives. Both entry points — `topology
 * cascade` and the headless `run` — boot through here, so a cell can never be
 * evaluated against a different stack than the one the sibling command uses.
 *
 * NOTE: this path does NOT go through `dsh --profile openswarm`; it mounts
 * in-process. The interactive binary spawns dsh instead, so the two can drift.
 * Unifying them on the profile is deferred (see the scoping discussion).
 */
export async function bootHarness(opts: BootOptions): Promise<HarnessBoot> {
  const { routes, workspace, io } = opts
  const ctx = new Context()
  const mounted = new Set<string>()
  for (const r of routes) {
    if (mounted.has(r.route)) continue
    mounted.add(r.route)
    const models = routes
      .filter((x) => x.route === r.route)
      .map((x) => ({ id: x.model, contextWindow: 200_000 }))
    if (r.adapter === 'anthropic') {
      ctx.plugin(plug(LlmAnthropic), { routes: [r.route], backend: 'bedrock', models })
    } else {
      ctx.plugin(plug(LlmOpenAi), {
        routes: [r.route],
        ...(r.baseURL === undefined ? {} : { baseURL: r.baseURL }),
        apiKeyEnv: r.apiKeyEnv,
        models,
      })
    }
  }
  ctx.plugin(plug(Spine), {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona:
      'You are a coding agent working in the current directory. Use your tools to complete the task; verify your work by running commands.',
    workspaceContext: false,
    skills: { enabled: false },
    toolBash: false,
    toolJobs: false,
  })
  // Persistent bash + editor: the member does real work in the sandbox cwd.
  const SandboxLocal = await import('@deepseek-ai/dsh-sandbox-local')
  const SandboxPolicy = await import('@deepseek-ai/dsh-sandbox-policy')
  const SubprocessLocal = await import('@deepseek-ai/dsh-subprocess-local')
  const Terminal = await import('@deepseek-ai/dsh-terminal')
  const TerminalBash = await import('@deepseek-ai/dsh-terminal-bash')
  const FsLocal = await import('@deepseek-ai/dsh-fs-local')
  const ToolBashPersistent = await import('@deepseek-ai/dsh-tool-bash-persistent')
  const ToolStrReplace = await import('@deepseek-ai/dsh-tool-str-replace-editor')
  ctx.plugin(plug(SandboxLocal))
  ctx.plugin(plug(SandboxPolicy), { mode: sandboxModeOf(opts.permissionMode), workspaceRoot: workspace })
  ctx.plugin(plug(SubprocessLocal))
  ctx.plugin(plug(Terminal))
  ctx.plugin(plug(TerminalBash), { timeoutMs: 300_000 })
  ctx.plugin(plug(FsLocal), { cwd: workspace })
  ctx.plugin(plug(ToolBashPersistent), { timeoutMs: 300_000 })
  ctx.plugin(plug(ToolStrReplace), { maxOutputChars: 16_000 })
  const sessionRoot = mkdtempSync(join(tmpdir(), 'openswarm-cli-sessions-'))
  ctx.plugin(plug(SessionPersistenceJsonl), { root: sessionRoot, compression: 'none' })
  ctx.plugin(plug(Subagent))
  ctx.plugin(plug(SpawnInProcess), { providerName: 'spawn' })
  ctx.plugin(SwarmService, {})

  await new Promise<void>((resolve) =>
    ctx.inject(['agents', 'subagents', 'swarm', 'sessionPersistence'], () => resolve()),
  )

  // Usage + trajectory: fold assistant/message usage per session, attribute
  // sessions to models after the run; stream tool_use_start live.
  let turnCount = 0
  const usageBySession = new Map<string, UsageTotals>()
  ctx.on('session/event', (session: any, event: any) => {
    if (event.type === 'tool/call') {
      io.out(JSON.stringify({ type: 'tool_use_start', name: event.data?.name ?? 'tool' }))
      return
    }
    if (event.type !== 'assistant/message') return
    turnCount += 1
    const usage = event.data?.usage
    if (usage === undefined) return
    let totals = usageBySession.get(session.id)
    if (totals === undefined) {
      totals = emptyUsage()
      usageBySession.set(session.id, totals)
    }
    totals.inputTokens += usage.inputTokens ?? 0
    totals.outputTokens += usage.outputTokens ?? 0
    totals.cacheReadInputTokens += usage.cacheReadTokens ?? 0
    totals.cacheWriteInputTokens += usage.cacheWriteTokens ?? 0
    totals.calls += 1
    totals.totalTokens =
      totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheWriteInputTokens
    opts.onUsage?.(foldTeam(usageBySession), turnCount)
  })

  const first = routes[0]!
  const lead = await ctx.agents.create({
    sessionId: SessionId(`openswarm-cli-${process.pid}-${Date.now()}`),
    meta: { cwd: workspace },
    agentOptions: { provider: first.route, model: first.model },
  })

  return {
    ctx,
    lead,
    usageBySession,
    turns: () => turnCount,
    async dispose() {
      await lead.dispose().catch(() => undefined)
      await (ctx as any).fiber?.dispose?.().catch(() => undefined)
    },
  }
}


/** Text of a member's content blocks — mirrors SwarmService's private `textOf`. */
function textBlocksOf(output: readonly any[]): string {
  return output
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

/** Fold every session's usage into one team total. */
function foldTeam(usageBySession: Map<string, UsageTotals>): UsageTotals {
  const team = emptyUsage()
  for (const totals of usageBySession.values()) {
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheWriteInputTokens',
      'totalTokens',
      'calls',
    ] as const) {
      team[key] += totals[key]
    }
  }
  return team
}

/**
 * `openswarm run --output-format json --model <m> [--single|--team] "<prompt>"`
 *
 * The eval entry point: one task, headless, JSONL on stdout for the harness
 * adapter's `openSwarmParse`. `--single` (the default) runs one agent over the
 * tool stack; `--team` runs the coordinator topology.
 *
 * Every terminating path emits `message_stop` — the parser sets its `sawResult`
 * flag ONLY from that line, so a run that exits without one is indistinguishable
 * from a crash no matter what else it printed.
 */
export async function runHeadless(argv: string[], io: CliIo): Promise<number> {
  const { args, positional } = splitArgv(argv)
  const prompt = positional.join(' ').trim()
  if (prompt.length === 0) throw new Error('a task prompt is required')
  const model = args.get('model')
  if (model === undefined) throw new Error('--model is required')

  const route = routeOf(model)
  const workspace = process.cwd()
  const controller = new AbortController()
  if (args.has('max-cost-usd')) {
    // Silently ignoring a spend cap is the one failure mode worse than refusing
    // the run: the caller believes spending is bounded when it is not.
    throw new Error('--max-cost-usd is not supported yet; cap with --max-tokens instead')
  }
  const maxTokens = numericArg(args, 'max-tokens')
  const maxTurns = numericArg(args, 'max-turns')

  /** Set once a cap trips; also the flag that turns the exit into a 3. */
  let exceeded: string | undefined
  const harness = await bootHarness({
    routes: [route],
    workspace,
    io,
    ...(args.get('permission-mode') === undefined ? {} : { permissionMode: args.get('permission-mode')! }),
    onUsage: (team, turns) => {
      if (exceeded !== undefined) return
      if (maxTokens !== undefined && team.totalTokens > maxTokens) {
        exceeded = `max-tokens (${team.totalTokens} > ${maxTokens})`
      } else if (maxTurns !== undefined && turns > maxTurns) {
        exceeded = `max-turns (${turns} > ${maxTurns})`
      }
      if (exceeded !== undefined) controller.abort()
    },
  })
  const { ctx, lead, usageBySession } = harness

  const emitStop = (): void => {
    const team = foldTeam(usageBySession)
    io.out(
      JSON.stringify({
        type: 'message_stop',
        usage: {
          inputTokens: team.inputTokens,
          outputTokens: team.outputTokens,
          cacheReadInputTokens: team.cacheReadInputTokens,
        },
      }),
    )
  }

  try {
    const agentOptions = { provider: route.route, model: route.model }
    let text: string
    let completed: boolean
    if (args.has('team')) {
      const workers = Number(args.get('workers') ?? '2')
      const result = (await (ctx as any).swarm.runTeam(
        {
          topology: 'coordinator',
          coordinator: { name: 'coordinator', agentOptions },
          workers: Array.from({ length: workers }, (_, i) => ({ name: `worker-${i}`, agentOptions })),
          task: prompt,
        },
        { parent: lead.agent, signal: controller.signal },
      )) as CoordinatorResult
      text = result.synthesis.text
      completed = result.synthesis.stopReason === 'completed'
    } else {
      const run = await (ctx as any).subagents.start('spawn', {
        label: 'agent',
        prompt: [{ type: 'text', text: prompt }],
        parent: lead.agent,
        signal: controller.signal,
        agentOptions,
      })
      const result = await run.result
      text = textBlocksOf(result.output)
      completed = result.stopReason === 'completed'
    }
    if (exceeded !== undefined) return stopForBudget()
    // Zero usage means no model call was ever billed — auth or routing failed,
    // not "the agent tried and produced nothing". Without an `error` line this
    // reads to the harness as a legitimate empty answer and grades as a real
    // zero, so the run is scored instead of being flagged as broken.
    const spent = foldTeam(usageBySession)
    if (spent.totalTokens === 0) {
      io.out(
        JSON.stringify({
          type: 'error',
          message: `no model call was made for "${model}" — check the provider route and credentials`,
        }),
      )
      emitStop()
      return 1
    }
    io.out(JSON.stringify({ type: 'text_delta', text }))
    emitStop()
    return completed ? 0 : 1
  } catch (error) {
    // An aborted run rejects; that is a budget stop, not a failure.
    if (exceeded !== undefined) return stopForBudget()
    throw error
  } finally {
    await harness.dispose()
  }

  /**
   * Terminate on a tripped cap: `budget_exceeded` for the operator, then
   * `message_stop` so the harness still sees a result with the usage actually
   * spent. Skipping the stop line would make this indistinguishable from a
   * crash — `openSwarmParse` sets `sawResult` from `message_stop` alone.
   */
  function stopForBudget(): number {
    io.out(JSON.stringify({ type: 'budget_exceeded', limit: exceeded }))
    emitStop()
    return 3
  }
}

/** Parse a numeric flag, rejecting junk rather than silently ignoring the cap. */
function numericArg(args: Map<string, string>, name: string): number | undefined {
  const raw = args.get(name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number (got "${raw}")`)
  return n
}

async function runTopologyCascade(args: Map<string, string>, io: CliIo): Promise<number> {
  const specPath = args.get('spec')
  if (specPath === undefined) throw new Error('--spec is required')
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as LegacySpec
  if (spec.members.length === 0) throw new Error('spec has no members')

  // Resolve adapter routes; mount one adapter config per distinct base.
  const routes = spec.members.map((m) => routeOf(m.model))
  const workspace = process.cwd()

  const harness = await bootHarness({ routes, workspace, io })
  const { ctx, lead, usageBySession } = harness

  try {
    const coordination = spec.coordination ?? {}
    const commands =
      coordination.escalationCommands ??
      (coordination.escalationCommand === undefined ? undefined : [coordination.escalationCommand])
    const tiers: MemberSpec[] = spec.members.map((m, i) => {
      const r = routes[i]!
      return {
        name: m.id ?? `tier-${i}`,
        agentOptions: { provider: r.route, model: r.model },
      }
    })
    // Tier prompts differ per member in the legacy spec; the cascade task is
    // the first tier's prompt (later tiers receive it plus gate feedback).
    const task = spec.members[0]!.prompt

    const result = (await (ctx as any).swarm.runTeam(
      {
        topology: 'cascade',
        tiers,
        task,
        ...(commands !== undefined && coordination.escalationTau !== undefined
          ? { confidence: { commands, tau: coordination.escalationTau } }
          : {}),
      },
      { parent: lead.agent, confidenceCwd: workspace },
    )) as CascadeResult

    // Attribute member sessions to models via attempt runIds (child session ids).
    const byModel: Record<string, UsageTotals> = {}
    const team = emptyUsage()
    for (const attempt of result.attempts) {
      const totals = usageBySession.get(attempt.result.runId)
      if (totals === undefined) continue
      const model = spec.members[attempt.tier]!.model
      const bucket = (byModel[model] ??= emptyUsage())
      for (const key of [
        'inputTokens',
        'outputTokens',
        'cacheReadInputTokens',
        'cacheWriteInputTokens',
        'totalTokens',
        'calls',
      ] as const) {
        bucket[key] += totals[key]
        team[key] += totals[key]
      }
    }

    const escalations = result.attempts.length - 1
    const outputPath = args.get('output')
    if (outputPath !== undefined) {
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, `${JSON.stringify({ type: 'team_usage', byModel, team })}\n`)
    }
    const tracePath = args.get('trace-output')
    if (tracePath !== undefined) {
      mkdirSync(dirname(tracePath), { recursive: true })
      writeFileSync(
        tracePath,
        `${JSON.stringify({ type: 'team_note', text: `cascade ${result.accepted ? 'accepted' : 'exhausted'} at tier ${result.tier} after ${escalations} escalation(s)` })}\n`,
      )
    }

    io.out(JSON.stringify({ type: 'text_delta', text: result.final.text }))
    io.out(
      JSON.stringify({
        type: 'message_stop',
        usage: {
          inputTokens: team.inputTokens,
          outputTokens: team.outputTokens,
          cacheReadInputTokens: team.cacheReadInputTokens,
        },
      }),
    )
    return result.final.stopReason === 'completed' ? 0 : 1
  } finally {
    await harness.dispose()
  }
}
