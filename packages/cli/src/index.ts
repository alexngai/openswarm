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
import SwarmService, { type CascadeResult, type MemberSpec } from 'openswarm-swarm'
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

function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(a.slice(2), next)
      i++
    } else {
      args.set(a.slice(2), '1')
    }
  }
  return args
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
  if (command !== 'topology' || sub !== 'cascade') {
    io.err(`usage: openswarm topology cascade --spec <file> [--output <file>] [--trace-output <file>]`)
    return 2
  }
  try {
    return await runTopologyCascade(parseArgs(argv.slice(2)), io)
  } catch (error) {
    io.out(JSON.stringify({ type: 'error', message: String(error instanceof Error ? error.message : error) }))
    io.err(String(error instanceof Error ? (error.stack ?? error.message) : error))
    return 1
  }
}

async function runTopologyCascade(args: Map<string, string>, io: CliIo): Promise<number> {
  const specPath = args.get('spec')
  if (specPath === undefined) throw new Error('--spec is required')
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as LegacySpec
  if (spec.members.length === 0) throw new Error('spec has no members')

  // Resolve adapter routes; mount one adapter config per distinct base.
  const routes = spec.members.map((m) => routeOf(m.model))
  const workspace = process.cwd()

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
  ctx.plugin(plug(SandboxPolicy), { mode: 'danger-full-access', workspaceRoot: workspace })
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
  const usageBySession = new Map<string, UsageTotals>()
  ctx.on('session/event', (session: any, event: any) => {
    if (event.type === 'tool/call') {
      io.out(JSON.stringify({ type: 'tool_use_start', name: event.data?.name ?? 'tool' }))
      return
    }
    if (event.type !== 'assistant/message') return
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
  })

  const first = routes[0]!
  const lead = await ctx.agents.create({
    sessionId: SessionId(`openswarm-cli-${process.pid}-${Date.now()}`),
    meta: { cwd: workspace },
    agentOptions: { provider: first.route, model: first.model },
  })

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
    await lead.dispose().catch(() => undefined)
    await (ctx as any).fiber?.dispose?.().catch(() => undefined)
  }
}
