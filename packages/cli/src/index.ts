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
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as LlmOpenAi from 'openswarm-llm-openai'
import * as LlmAnthropic from 'openswarm-llm-anthropic'
import SwarmService, {
  hiddenSuite,
  memberEnvOf,
  openVerifier,
  recordToolEvents,
  refuseRootForL3,
  reviewMemberConfig,
  runGate,
  runMemberProcess,
  targetStatuses,
  activeVerifier,
  type CascadeResult,
  type CoordinatorResult,
  type FanoutSpec,
  type GateEvidence,
  type GateResult,
  type GateRound,
  type MemberSpec,
  type PeerTeamSpec,
  type RunHandle,
  type SwarmUsageEvent,
  type WorktreeTeamOptions,
} from 'openswarm-swarm'
import { withSnapshotClone } from 'openswarm-git'
import * as PluginAuthoring from 'openswarm-plugin-authoring'
import * as Spine from '@deepseek-ai/dsh-agent-spine-demo'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Subagent from '@deepseek-ai/dsh-subagent'
import * as SpawnInProcess from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { ARMS, loadPlan, runPilot, type Arm, type Plan } from './pilot'

export { runControl } from './control'

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
const BOOL_FLAGS = new Set(['headless', 'single', 'team', 'self-modify', 'gate'])

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
        `       openswarm run --output-format json --model <m> [--single|--team|--spec <file>] "<prompt>"`,
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
  /**
   * Mount F3 plugin authoring, giving the agent `swarm_author_plugin` — the
   * self-modification arm of the experiment.
   *
   * Only `self` scope is reachable here. `lead` scope needs an approval gate
   * (`ctx.approval`), which this context does not compose, so it is refused
   * rather than silently granted: a headless run cannot change the harness for
   * anyone but itself.
   */
  selfModify?: boolean
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
  if (opts.selfModify === true) ctx.plugin(plug(PluginAuthoring), {})

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
    addUsage(totals, usage)
    opts.onUsage?.(foldTeam(usageBySession.values()), turnCount)
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

/** Add one `assistant/message` usage record (dsh field names) to a running total. */
function addUsage(totals: UsageTotals, usage: any): void {
  totals.inputTokens += usage.inputTokens ?? 0
  totals.outputTokens += usage.outputTokens ?? 0
  totals.cacheReadInputTokens += usage.cacheReadTokens ?? 0
  totals.cacheWriteInputTokens += usage.cacheWriteTokens ?? 0
  totals.calls += 1
  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheWriteInputTokens
}

/**
 * Fold token usage out of worktree members' session logs (ported from
 * eval/adapter.mjs, c1299b2).
 *
 * A worktree member is a SUBPROCESS: its `assistant/message` events go to the
 * child's own session, so `session/event` in this context never sees them and
 * the live fold reports zero for a run that plainly called the model. We choose
 * the members' session root, so read it back. It is disjoint from the lead's
 * in-process root, so the two sums never double count.
 */
function foldSessionLogs(root: string): UsageTotals {
  const totals = emptyUsage()
  let files: string[]
  try {
    files = readdirSync(root, { recursive: true, encoding: 'utf8' })
  } catch {
    return totals
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    let raw: string
    try {
      raw = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      let event: any
      try {
        event = JSON.parse(line)
      } catch {
        continue // blank, or a torn final frame from a killed member
      }
      if (event?.type === 'assistant/message' && event.data?.usage !== undefined) addUsage(totals, event.data.usage)
    }
  }
  return totals
}

/** Fold per-session usage into one team total. */
function foldTeam(sessions: Iterable<UsageTotals>): UsageTotals {
  const team = emptyUsage()
  for (const totals of sessions) {
    for (const key of [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheWriteInputTokens',
      'totalTokens',
      'calls',
      'costUsd',
    ] as const) {
      team[key] += totals[key]
    }
  }
  return team
}

/** The coordinator team `--team` runs; plan mode runs one per thread. */
function coordinatorSpec(task: string, agentOptions: { provider: string; model: string }, workers: number) {
  return {
    topology: 'coordinator' as const,
    coordinator: { name: 'coordinator', agentOptions },
    workers: Array.from({ length: workers }, (_, i) => ({ name: `worker-${i}`, agentOptions })),
    task,
  }
}

/**
 * Plan mode (docs/05 pilot): `--plan <file> --arm <name>`, or the env pair for
 * the reason OPENSWARM_SELF_MODIFY exists. swarmkit's `openSwarmSpec.flags()`
 * always emits `--single` or `--team`, so an env-selected plan supersedes them;
 * only the explicit flags conflict.
 */
function pilotOf(args: Map<string, string>, selfModify: boolean): { plan: Plan; arm: Arm } | undefined {
  const planPath = args.get('plan') ?? (process.env['OPENSWARM_PILOT_PLAN'] || undefined)
  const arm = args.get('arm') ?? (process.env['OPENSWARM_PILOT_ARM'] || undefined)
  if (planPath === undefined && arm === undefined) return undefined
  if ((args.has('plan') || args.has('arm')) && (args.has('team') || args.has('single'))) {
    throw new Error('--plan/--arm cannot be combined with --team or --single')
  }
  if (planPath === undefined || arm === undefined) {
    throw new Error('plan mode needs both a plan (--plan or OPENSWARM_PILOT_PLAN) and an arm (--arm or OPENSWARM_PILOT_ARM)')
  }
  if (!(ARMS as readonly string[]).includes(arm)) throw new Error(`unknown arm "${arm}" (expected ${ARMS.join(' | ')})`)
  // The authoring plugin mounts in THIS process; plan-mode members are subprocesses it never reaches.
  if (selfModify) throw new Error('--self-modify has no effect on plan-mode members; refusing a no-op arm')
  return { plan: loadPlan(planPath), arm: arm as Arm }
}

/** A team spec file: a peer-team or fanout spec plus its run's worktree options. */
interface TeamSpecFile {
  spec: PeerTeamSpec | FanoutSpec
  worktrees: Partial<WorktreeTeamOptions>
}

/**
 * A headless team (docs/05 B2 exit criterion 1): `--spec <file>`, or
 * OPENSWARM_TEAM_SPEC for the reason OPENSWARM_SELF_MODIFY exists. The file is
 * a `peer-team` or `fanout` TeamSpec with its run's `worktrees` options beside
 * it (`train`, `member`, …; the repo is always the workspace). An env-selected
 * spec supersedes the `--single`/`--team` swarmkit always emits; only the
 * explicit flags conflict.
 */
function teamSpecOf(args: Map<string, string>, selfModify: boolean, planned: boolean): TeamSpecFile | undefined {
  const path = args.get('spec') ?? (process.env['OPENSWARM_TEAM_SPEC'] || undefined)
  if (path === undefined) return undefined
  if (args.has('spec') && (args.has('team') || args.has('single'))) throw new Error('--spec cannot be combined with --team or --single')
  if (planned) throw new Error('a team spec (--spec / OPENSWARM_TEAM_SPEC) cannot be combined with plan mode')
  // As in plan mode: the authoring plugin mounts in THIS process, and the members are subprocesses.
  if (selfModify) throw new Error('--self-modify has no effect on team-spec members; refusing a no-op arm')
  const { worktrees = {}, ...spec } = JSON.parse(readFileSync(path, 'utf8'))
  if (spec.topology !== 'peer-team' && spec.topology !== 'fanout') {
    throw new Error(`team spec ${path}: topology must be peer-team or fanout (got ${JSON.stringify(spec.topology)})`)
  }
  if (!Array.isArray(spec.members) || spec.members.length === 0 || !Array.isArray(spec.tasks)) {
    throw new Error(`team spec ${path}: needs members and tasks`)
  }
  return { spec, worktrees }
}

/** Whether a team spec runs anything on dsh: a dsh member, or a gate's reviewer (a claude-code member's takes the dsh route too). */
function needsDshRoute({ spec }: TeamSpecFile): boolean {
  return spec.members.some((m) => m.runtime !== 'claude-code') || (spec.topology === 'peer-team' && spec.gate !== undefined && spec.gate.review !== false)
}

/** The branch checked out (`''` on a detached HEAD) and its commit. */
export interface CheckoutState {
  branch: string
  head: string
}

export function checkoutState(workspace: string): CheckoutState {
  return {
    branch: spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).stdout.trim(),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
  }
}

/**
 * Bring a team's landed result into the workspace: fast-forward the branch
 * that was checked out when the run started to the target branch, only when
 * that branch is still checked out at the commit it was on (never a detached
 * HEAD or another branch), the workspace is clean, and nothing the
 * fast-forward writes is an ignored file there (git would overwrite it
 * without a word). Says what happened, a refusal included; the landed result
 * stays on the target branch either way.
 */
export function fastForward(workspace: string, target: string, start: CheckoutState): string {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${target}`], { cwd: workspace }).status !== 0) return 'nothing landed'
  const refuse = (why: string) => `refused to fast-forward: ${why}; the landed result is on ${target}`
  if (start.branch === '') return refuse('the workspace was on a detached HEAD')
  const now = checkoutState(workspace)
  if (now.branch !== start.branch) return refuse(`${start.branch} is no longer checked out`)
  if (now.head !== start.head) return refuse(`${start.branch} moved during the run`)
  if (git(workspace, 'status', '--porcelain').trim() !== '') return refuse('the workspace is not clean')
  // Paths from the top, where ls-files lists the whole checkout's ignored files (collapsed to their directories).
  const top = git(workspace, 'rev-parse', '--show-toplevel').trim()
  const changed = git(top, 'diff', '-z', '--name-only', '--no-renames', 'HEAD', target).split('\0').filter(Boolean)
  const ignored = git(top, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory').split('\0').filter(Boolean).map((e) => e.replace(/\/$/, ''))
  const clobbered = changed.find((path) => ignored.some((e) => path === e || path.startsWith(`${e}/`) || e.startsWith(`${path}/`)))
  if (clobbered !== undefined) return refuse(`it would overwrite ${clobbered}, which is ignored in the workspace`)
  try {
    git(workspace, 'merge', '--ff-only', '-q', target)
    return 'fast-forwarded'
  } catch (error) {
    return refuse(`not a fast-forward (${oneLine(String((error as any)?.stderr || (error as Error).message))})`)
  }
}

/**
 * The completion gate (docs/05 B6): `--gate [--gate-rounds N] [--gate-check
 * "<cmd>"]... [--gate-level N] [--gate-suite <name>]`, or the OPENSWARM_GATE*
 * env for the reason OPENSWARM_SELF_MODIFY exists. Checks make it L2; without
 * any an independent reviewer measures each round (L1), under the
 * workspace-write sandbox unless OPENSWARM_GATE_REVIEWER_SANDBOX=
 * danger-full-access says otherwise (for hosts that cannot sandbox). A suite
 * makes it L3 (docs/05 B1): the verifier's hidden suite accepts, and the
 * checks or the reviewer give feedback only. `--gate-level` declares the
 * minimum, refused when nothing configured reaches it. B6a gates the
 * single-agent path only, and only in a git work tree, since the gate
 * snapshots through git.
 */
function gateOf(
  argv: string[],
  args: Map<string, string>,
  workspace: string,
  planned: boolean,
  io: CliIo,
): { maxRounds?: number; commands?: string[]; minLevel?: 1 | 2 | 3; suite?: string; reviewerSandbox: string } | undefined {
  const GATE_FLAGS = ['gate-rounds', 'gate-check', 'gate-level', 'gate-suite']
  if (!args.has('gate') && process.env['OPENSWARM_GATE'] !== '1') {
    // A gate option that silently does nothing is the no-op arm again.
    if (GATE_FLAGS.some((flag) => args.has(flag))) throw new Error(`${GATE_FLAGS.map((f) => `--${f}`).join(', ')} need --gate`)
    // Env may be shared across arms, so only warn: an arm that set these but
    // not OPENSWARM_GATE=1 would otherwise run ungated without a word.
    const stray = ['OPENSWARM_GATE_ROUNDS', 'OPENSWARM_GATE_CHECK', 'OPENSWARM_GATE_LEVEL', 'OPENSWARM_GATE_SUITE'].filter((name) => process.env[name])
    if (stray.length > 0) io.err(`openswarm: ${stray.join(' and ')} set without OPENSWARM_GATE=1; this run is not gated`)
    return undefined
  }
  if (args.has('team') || planned) {
    throw new Error(
      "the gate (--gate / OPENSWARM_GATE=1) covers only the single-agent path; it cannot be combined with --team, plan mode or a team spec (gate a spec's peer-team with its own `gate`)",
    )
  }
  const rounds = args.get('gate-rounds') ?? (process.env['OPENSWARM_GATE_ROUNDS'] || undefined)
  if (rounds !== undefined && !/^[1-9]\d*$/.test(rounds)) {
    throw new Error(`--gate-rounds must be a positive integer (got "${rounds}")`)
  }
  // Every --gate-check, not just the last (splitArgv keeps one value per
  // flag): several checks are what make the regression guard reachable. Read
  // with splitArgv's rule, so a following flag is no value. The env form is
  // one check per line.
  const flagged = argv.flatMap((a, i) => {
    const next = argv[i + 1]
    return a !== '--gate-check' ? [] : [next === undefined || next.startsWith('--') ? '' : next]
  })
  const listed = process.env['OPENSWARM_GATE_CHECK']?.trim()
  const checks = flagged.length > 0 ? flagged : listed ? listed.split('\n') : []
  if (checks.some((check) => check.trim() === '')) {
    throw new Error('an empty --gate-check (or blank line in OPENSWARM_GATE_CHECK) checks nothing; give each a command')
  }
  const reviewerSandbox = process.env['OPENSWARM_GATE_REVIEWER_SANDBOX'] || 'workspace-write'
  if (reviewerSandbox !== 'workspace-write' && reviewerSandbox !== 'danger-full-access') {
    throw new Error(`OPENSWARM_GATE_REVIEWER_SANDBOX must be workspace-write or danger-full-access, not "${reviewerSandbox}"`)
  }
  const suite = args.get('gate-suite') ?? (process.env['OPENSWARM_GATE_SUITE'] || undefined)
  if (suite !== undefined && !/^[a-z0-9-]{1,64}$/.test(suite)) throw new Error(`--gate-suite takes a suite name, 1-64 of [a-z0-9-] (got "${suite}")`)
  const level = args.get('gate-level') ?? (process.env['OPENSWARM_GATE_LEVEL'] || undefined)
  if (level !== undefined && !/^[123]$/.test(level)) {
    throw new Error(`--gate-level is 1 (reviewer), 2 (checks) or 3 (hidden suite); L4, external CI, is not built (got "${level}")`)
  }
  if (level === '3' && suite === undefined) throw new Error('--gate-level 3 needs the hidden suite to run: --gate-suite <name>')
  if (level === '2' && checks.length === 0 && suite === undefined) throw new Error('--gate-level 2 needs checks: --gate-check "<cmd>"')
  // Fail before any spend: root reads the store, so a hidden suite hides nothing from it.
  if (suite !== undefined) refuseRootForL3()
  let inside = false
  try {
    inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspace, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() === 'true'
  } catch {}
  if (!inside) throw new Error(`the gate needs a git work tree to snapshot, and ${workspace} is not in one`)
  return {
    ...(rounds === undefined ? {} : { maxRounds: Number(rounds) }),
    ...(checks.length === 0 ? {} : { commands: checks }),
    ...(level === undefined ? {} : { minLevel: Number(level) as 1 | 2 | 3 }),
    ...(suite === undefined ? {} : { suite }),
    reviewerSandbox,
  }
}

/**
 * What one piece of gate evidence told the agent, as `gate_round` fields: the
 * reviewer's per-target verdicts (with what it could not run) and regressions
 * as given, the checks that failed, or the hidden suite's counts.
 */
function verdictJson(e: GateEvidence) {
  return {
    ...(e.targets === undefined ? {} : { targets: targetStatuses(e.targets) }),
    ...(e.regressions === undefined ? {} : { regressions: e.regressions }),
    ...(e.failedCommands === undefined ? {} : { failed: e.failedCommands }),
    ...(e.kind !== 'hidden' ? {} : { suite: e.suite, enforcement: e.enforcement }),
    ...(e.kind !== 'hidden' || e.total === undefined ? {} : { total: e.total, failedTests: e.failed }),
    ...(e.refused === undefined ? {} : { refused: e.refused }),
    ...(e.error === undefined ? {} : { error: e.error }),
  }
}

/** A text's whitespace-collapsed head, for a one-line progress report. */
const oneLine = (text: string, max = 160): string => text.replace(/\s+/g, ' ').trim().slice(0, max)

/** Target statuses in the order a reader wants them counted. */
const STATUSES = ['done', 'unverifiable', 'partial', 'missing', 'broken']

/**
 * One gate round as a human-readable line, for stderr. The harness keeps only
 * the head of stdout, which tool_use_start lines fill, so live runs lost the
 * gate_round JSONL; this line carries what the agent was told.
 */
function gateRoundLine(round: GateRound): string {
  const e = round.evidence
  if (e.tamper !== undefined) {
    return `gate: round ${round.round} L3 tamper incident — not measured (${[...new Set(e.tamper.map((t) => `${t.signal} in ${t.where}`))].join(', ')})`
  }
  if (round.round > 1 && !round.changed) return `gate: round ${round.round} changed nothing — stopping`
  if (e.error !== undefined) return `gate: round ${round.round} ${e.kind === 'hidden' ? 'hidden suite' : 'review'} unavailable — ${oneLine(e.error)}`
  if (e.kind === 'hidden' && e.total === undefined && e.enforcement !== undefined) {
    return `gate: round ${round.round} L3 hidden suite ${e.suite} — not run as L3 (enforcement ${e.enforcement}: the verifier could not confine it)`
  }
  if (e.kind === 'hidden') {
    const counts = e.refused !== undefined ? `snapshot refused: ${oneLine(e.refused, 120)}` : e.passed ? `${e.total} of ${e.total} passing` : `${e.failed} of ${e.total} failing`
    const f = round.feedback
    const fed = f === undefined ? '' : f.error !== undefined ? '; feedback review unavailable' : `; feedback ${evidenceLine(f)}`
    return `gate: round ${round.round} L3 hidden suite ${e.suite} — ${e.passed ? 'passed' : 'not passed'} (${counts}, enforcement ${e.enforcement}${fed})`
  }
  return `gate: round ${round.round} ${evidenceLine(e)}${round.rolledBack === true ? ' (rolled back)' : ''}`
}

/** L1 or L2 evidence in a few words: what accepted below L3, or the feedback at it. */
function evidenceLine(e: GateEvidence): string {
  const details: string[] = []
  if (e.kind === 'review') {
    const statuses = (e.targets ?? []).map((t) => String(t?.status))
    const counted = [...STATUSES, ...new Set(statuses.filter((s) => !STATUSES.includes(s)))]
      .map((status) => [status, statuses.filter((s) => s === status).length] as const)
      .filter(([, n]) => n > 0)
    if (counted.length > 0) details.push(counted.map(([status, n]) => `${n} ${status}`).join(', '))
    // What the reviewer could not run here, which a pass on unverifiable targets rests on.
    for (const t of e.targets ?? []) {
      if (t?.status === 'unverifiable') details.push(`${t.target} unverifiable: ${oneLine(t.notes ?? '', 80)}`)
    }
    const regressions = typeof e.regressions === 'string' ? e.regressions : JSON.stringify(e.regressions)
    if (regressions !== undefined && !/^\s*none\.?\s*$/i.test(regressions)) details.push(`regressions: ${oneLine(regressions, 120)}`)
  } else if (e.failedCommands !== undefined) {
    details.push(`failed: ${e.failedCommands.map((c) => oneLine(c, 80)).join(', ')}`)
  }
  const what = e.kind === 'review' ? `review score ${e.score ?? 'unparsed'}` : 'checks'
  return `L${e.level} ${what} — ${e.passed ? 'passed' : 'not passed'}${details.length === 0 ? '' : ` (${details.join('; ')})`}`
}

/** The gate's outcome as a human-readable line, for stderr. */
function gateResultLine(result: GateResult): string {
  const n = result.rounds.length
  const rounds = `${n} round${n === 1 ? '' : 's'}`
  if (result.accepted) return `gate: accepted at L${result.level} after ${rounds}`
  if (result.reason === 'tamper') return `gate: stopped — a tamper incident in round ${n}`
  if (result.reason === 'hidden suite unconfined') return `gate: stopped — the verifier could not confine the hidden suite (OPENSWARM_VERIFIER_ALLOW_PARTIAL=1 runs it as L2)`
  if (result.reason !== undefined) return `gate: stopped — ${result.reason}: ${oneLine(result.rounds.at(-1)?.evidence.error ?? '')}`
  return `gate: not accepted at L${result.level} after ${rounds}`
}

/**
 * Why this host cannot confine a process under workspace-write, or undefined
 * when it can: the harness's own sandbox provider confines `true` once, as a
 * member's would (no Seatbelt, bwrap or Landlock, e.g. in plain Docker).
 */
function sandboxUnavailable(ctx: any): string | undefined {
  try {
    const { argv } = ctx.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: tmpdir() })
    const probe = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' })
    return probe.status === 0 ? undefined : probe.stderr || probe.error?.message || `exit ${probe.status}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * How plan-mode members reach the model. They are worktree subprocesses booted
 * from member.cordis.yml, not this stack: one OpenAI-compatible route named
 * `openai` (hence that provider name even for Azure), configured by env. The
 * SDK spawner scrubs KEY/TOKEN/DSH_* names from the inherited env, so the key
 * and model travel explicitly.
 */
function memberRouteOf(route: Route): { agentOptions: { provider: string; model: string }; env: Record<string, string> } {
  if (route.adapter !== 'openai') {
    throw new Error(
      `"${route.model}" cannot run as a worktree member (plan mode, the gate's reviewer): members only speak the OpenAI-compatible route`,
    )
  }
  const baseURL = route.baseURL ?? process.env['OPENSWARM_LLM_BASE_URL']
  const key = route.apiKeyEnv === undefined ? undefined : process.env[route.apiKeyEnv]
  return {
    agentOptions: { provider: 'openai', model: route.model },
    env: {
      ...(baseURL === undefined ? {} : { OPENSWARM_LLM_BASE_URL: baseURL }),
      ...(key === undefined ? {} : { OPENSWARM_LLM_API_KEY: key }),
      DSH_MODEL: route.model,
    },
  }
}

/** How often plan mode re-reads member logs to enforce `--max-tokens`/`--max-turns`. */
const CAP_POLL_MS = 5_000

/**
 * `openswarm run --output-format json --model <m> [--single|--team] "<prompt>"`
 *
 * The eval entry point: one task, headless, JSONL on stdout for the harness
 * adapter's `openSwarmParse`. `--single` (the default) runs one agent over the
 * tool stack, and with the gate (`gateOf`) only closes on passing evidence,
 * one `gate_round` line per round; `--team` runs the coordinator topology;
 * plan mode (`pilotOf`) runs a plan's threads as coordinator teams in
 * worktrees (./pilot.ts); a team spec (`teamSpecOf`) runs a peer-team or
 * fanout as worktree members, lands it (through the train when its
 * `worktrees.train` says so), fast-forwards a clean workspace to the result,
 * and reports it in a `team_note` line with the run's metrics.
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
  // Arms select this via the flag or the env var. The env path exists because an
  // eval Arm carries `scaffold.env` but cannot add a CLI flag — the harness
  // spec's `flags()` is fixed across arms.
  const selfModify = args.has('self-modify') || process.env['OPENSWARM_SELF_MODIFY'] === '1'
  if (args.has('max-cost-usd')) {
    // Silently ignoring a spend cap is the one failure mode worse than refusing
    // the run: the caller believes spending is bounded when it is not.
    throw new Error('--max-cost-usd is not supported yet; cap with --max-tokens instead')
  }
  const maxTokens = numericArg(args, 'max-tokens')
  const maxTurns = numericArg(args, 'max-turns')
  const pilot = pilotOf(args, selfModify)
  const team = teamSpecOf(args, selfModify, pilot !== undefined)
  const gate = gateOf(argv, args, workspace, pilot !== undefined || team !== undefined, io)
  // Plan-mode members, a team spec's dsh members and the gate's reviewer are worktree subprocesses.
  const memberRoute =
    pilot !== undefined || (team !== undefined && needsDshRoute(team)) || (gate !== undefined && gate.commands === undefined) ? memberRouteOf(route) : undefined

  /** Set once a cap trips; also the flag that turns the exit into a 3. */
  let exceeded: string | undefined
  const checkCaps = (team: UsageTotals, turns: number): void => {
    if (exceeded !== undefined) return
    if (maxTokens !== undefined && team.totalTokens > maxTokens) {
      exceeded = `max-tokens (${team.totalTokens} > ${maxTokens})`
    } else if (maxTurns !== undefined && turns > maxTurns) {
      exceeded = `max-turns (${turns} > ${maxTurns})`
    }
    if (exceeded !== undefined) controller.abort()
  }
  const harness = await bootHarness({
    routes: [route],
    workspace,
    io,
    ...(args.get('permission-mode') === undefined ? {} : { permissionMode: args.get('permission-mode')! }),
    selfModify,
    onUsage: checkCaps,
  })
  const { ctx, lead, usageBySession } = harness
  // Ours to choose, so subprocess members' usage (plan mode's, a team's, the
  // gate reviewer's) can be read back (foldSessionLogs).
  const memberRoot = memberRoute === undefined && team === undefined ? undefined : mkdtempSync(join(tmpdir(), 'openswarm-member-sessions-'))
  const memberUsage = (): UsageTotals => (memberRoot === undefined ? emptyUsage() : foldSessionLogs(memberRoot))
  /** A team spec's claude-code members, which write no dsh session logs: their usage and dollars as the run journals them. */
  let claudeUsage = emptyUsage
  const spentNow = (): UsageTotals => foldTeam([...usageBySession.values(), memberUsage(), claudeUsage()])
  // Member usage never reaches `onUsage`, so caps over subprocess members poll
  // their logs and the journal. ponytail: rereads every log per tick and trips
  // up to one tick late, and a claude-code run counts only once it settles
  // (its usage is journaled then); tail by byte offset, or stream claude-code
  // usage, if either ever matters.
  const capPoll =
    memberRoot !== undefined && (maxTokens !== undefined || maxTurns !== undefined)
      ? setInterval(() => {
          const members = foldTeam([memberUsage(), claudeUsage()])
          checkCaps(foldTeam([...usageBySession.values(), members]), harness.turns() + members.calls)
        }, CAP_POLL_MS)
      : undefined

  const emitStop = (): void => {
    const team = spentNow()
    io.out(
      JSON.stringify({
        type: 'message_stop',
        // openSwarmParse reads the first three; the rest ride along for other readers.
        usage: {
          inputTokens: team.inputTokens,
          outputTokens: team.outputTokens,
          cacheReadInputTokens: team.cacheReadInputTokens,
          cacheWriteInputTokens: team.cacheWriteInputTokens,
          // What claude-code members reported themselves; dsh members report no dollars.
          ...(team.costUsd === 0 ? {} : { claudeCodeCostUsd: team.costUsd }),
        },
      }),
    )
  }

  try {
    const agentOptions = { provider: route.route, model: route.model }
    let text: string
    let completed: boolean
    if (pilot !== undefined && memberRoute !== undefined && memberRoot !== undefined) {
      const threads = await runPilot({
        ...pilot,
        workspace,
        signal: controller.signal,
        runThread: async (thread, baseSha) => {
          try {
            const result = (await (ctx as any).swarm.runTeam(
              coordinatorSpec(
                `${prompt}\n\n## Your thread: ${thread.id}\n${thread.assignment}\nOther threads own the rest of the roadmap; stay within your assignment.`,
                memberRoute.agentOptions,
                pilot.plan.workers,
              ),
              {
                parent: lead.agent,
                signal: controller.signal,
                worktrees: {
                  repoRoot: workspace,
                  baseRef: baseSha,
                  targetBranch: `pilot/${thread.id}`,
                  member: { env: { ...memberRoute.env, DSH_SESSION_ROOT: memberRoot } },
                },
              },
            )) as CoordinatorResult & { git?: { merged: unknown[]; conflicts: unknown[] } }
            io.out(
              JSON.stringify({
                type: 'team_note',
                thread: thread.id,
                stopReason: result.synthesis.stopReason,
                merged: result.git?.merged.length ?? 0,
                conflicts: result.git?.conflicts.length ?? 0,
                text: result.synthesis.text,
              }),
            )
          } catch (error) {
            io.out(JSON.stringify({ type: 'team_note', thread: thread.id, error: String(error instanceof Error ? error.message : error) }))
            throw error
          }
        },
      })
      io.out(JSON.stringify({ type: 'pilot', arm: pilot.arm, threads }))
      text = `pilot ${pilot.arm}: ${threads.map((t) => `${t.id} ${t.landed}${t.error === undefined ? '' : ` (${t.error})`}`).join('; ')}`
      // Conflicts are data about the arm; only a thread that did not run fails the run.
      completed = threads.every((t) => t.landed !== 'failed')
    } else if (team !== undefined && memberRoot !== undefined) {
      // dsh members take the CLI's route, as plan-mode members do; a claude-code member's model is Claude Code's.
      const members = team.spec.members.map((m) =>
        m.runtime === 'claude-code' || memberRoute === undefined ? m : { ...m, agentOptions: { ...memberRoute.agentOptions, ...m.agentOptions } },
      )
      // The prompt is the whole task; each task's own prompt is its part of it.
      const tasks = team.spec.tasks.map((t) => ({ ...t, prompt: `${prompt}\n\n${t.prompt}` }))
      const { member } = team.worktrees
      // What the landed result may fast-forward: this branch, at this commit.
      const start = checkoutState(workspace)
      const handle: RunHandle = await (ctx as any).swarm.start({ ...team.spec, members, tasks }, {
        parent: lead.agent,
        signal: controller.signal,
        onProgress: (line: string) => io.err(line),
        worktrees: {
          ...team.worktrees,
          repoRoot: workspace,
          // Every member run's logs (tasks, reviews, repairs, resolvers) under memberRoot, which message_stop folds.
          member: { ...member, env: { ...memberRoute?.env, ...member?.env, DSH_SESSION_ROOT: memberRoot } },
        },
      })
      claudeUsage = () => {
        const totals = emptyUsage()
        for (const { type, data } of handle.journal.events) {
          const run = data as SwarmUsageEvent
          if (type !== 'swarm/usage' || run.runtime !== 'claude-code') continue
          totals.inputTokens += run.usage.inputTokens
          totals.outputTokens += run.usage.outputTokens
          totals.cacheReadInputTokens += run.usage.cacheReadTokens
          totals.cacheWriteInputTokens += run.usage.cacheWriteTokens
          totals.calls += run.usage.calls
          totals.costUsd += run.costUsd ?? 0
        }
        totals.totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadInputTokens + totals.cacheWriteInputTokens
        return totals
      }
      const result = await handle.result
      const git = result.git
      const landed = (git?.landed ?? git?.merged ?? []).map((l) => l.taskKey)
      const ejected = (git?.ejected ?? []).map(({ taskKey, reason }) => ({ taskKey, reason }))
      const withheld = (git?.withheld ?? []).map((w) => w.taskKey)
      const workspaceNote = git === undefined ? 'nothing landed' : fastForward(workspace, git.targetBranch, start)
      if (workspaceNote !== 'fast-forwarded') io.err(`openswarm: workspace ${workspaceNote}`)
      io.out(
        JSON.stringify({
          type: 'team_note',
          runId: handle.id,
          topology: team.spec.topology,
          targetBranch: git?.targetBranch ?? null,
          landed,
          ejected,
          withheld,
          conflicts: (git?.conflicts ?? []).map((c) => c.taskKey),
          ...(git?.stopped === undefined ? {} : { stopped: git.stopped }),
          workspace: workspaceNote,
          metrics: result.metrics ?? null,
        }),
      )
      text =
        `team ${team.spec.topology} (${handle.id}): ${landed.length} landed, ${ejected.length} ejected, ${withheld.length} withheld` +
        `${git?.stopped === undefined ? '' : ` (train stopped: ${git.stopped})`}; workspace ${workspaceNote}`
      // Ejections are data about the run; only a train that stopped short fails it.
      completed = git?.stopped === undefined
    } else if (args.has('team')) {
      const result = (await (ctx as any).swarm.runTeam(
        coordinatorSpec(prompt, agentOptions, Number(args.get('workers') ?? '2')),
        { parent: lead.agent, signal: controller.signal },
      )) as CoordinatorResult
      text = result.synthesis.text
      completed = result.synthesis.stopReason === 'completed'
    } else if (gate !== undefined) {
      const { reviewerSandbox, suite, ...limits } = gate
      // Fail before any spend, and say how to proceed, rather than let every
      // review fail inside a sandbox the host cannot provide.
      const unsandboxable = memberRoute === undefined || reviewerSandbox !== 'workspace-write' ? undefined : sandboxUnavailable(ctx)
      if (unsandboxable !== undefined) {
        throw new Error(
          `the gate's reviewer runs under the workspace-write sandbox, which this host cannot provide (${unsandboxable}); ` +
            'set OPENSWARM_GATE_REVIEWER_SANDBOX=danger-full-access to run it unsandboxed',
        )
      }
      // L3 (docs/05 B1): the verifier must hold the suite before any spend.
      // The agent's tool calls and outputs are recorded for the tamper scan.
      const verifier = suite === undefined ? undefined : await openVerifier(activeVerifier(), [suite])
      const toolEvents = verifier === undefined ? undefined : recordToolEvents(ctx)
      const result = await runGate(
        { task: prompt, member: { name: 'agent', agentOptions }, ...limits },
        {
          cwd: workspace,
          signal: controller.signal,
          ...(verifier === undefined || suite === undefined
            ? {}
            : {
                hidden: hiddenSuite(verifier, {
                  suite,
                  cwd: async () => workspace,
                  envRoot: execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: workspace, encoding: 'utf8' }).trim(),
                  transcript: (round) => toolEvents!.take(round.runId),
                }),
              }),
          // A fresh child of the lead per round and per review, so every one's
          // usage folds into usageBySession: the harness bills the reviews too.
          run: async (member, text) => {
            // Past a budget stop no new run starts; the throw ends the gate as one.
            controller.signal.throwIfAborted()
            const run = await (ctx as any).subagents.start('spawn', {
              label: member.name,
              prompt: [{ type: 'text', text }],
              parent: lead.agent,
              signal: controller.signal,
              agentOptions: member.agentOptions ?? agentOptions,
            })
            const result = await run.result
            return {
              member: member.name,
              runId: run.id,
              text: textBlocksOf(result.output),
              output: result.output,
              stopReason: result.stopReason,
            }
          },
          // The reviewer is a subprocess member in a disposable clone of the
          // round's snapshot, never this checkout: what it changes is thrown
          // away with the clone, as its prompt promises, and its sandbox fences
          // writes outside it. It runs as the measured reviewer did
          // (review.cordis.yml). Its usage is read back from its session logs
          // under memberRoot.
          ...(memberRoute === undefined || memberRoot === undefined
            ? {}
            : {
                review: (text: string, commit: string) =>
                  withSnapshotClone(workspace, commit, (cwd) => {
                    controller.signal.throwIfAborted()
                    return runMemberProcess(ctx, { name: 'reviewer', agentOptions: memberRoute.agentOptions }, text, {
                      cwd,
                      env: memberEnvOf(
                        { env: { ...memberRoute.env, DSH_SESSION_ROOT: memberRoot, OPENSWARM_MEMBER_SANDBOX: reviewerSandbox } },
                        `review-${process.pid}`,
                      ),
                      parent: lead.agent,
                      signal: controller.signal,
                      config: { configPath: reviewMemberConfig() },
                    })
                  }),
              }),
          record: (round) => {
            const e = round.evidence
            io.out(
              JSON.stringify({
                type: 'gate_round',
                round: round.round,
                changed: round.changed,
                passed: e.passed,
                kind: e.kind,
                level: e.level,
                score: e.score ?? null,
                rolledBack: round.rolledBack === true,
                ...verdictJson(e),
                // Under L3, what the weaker source said, which the agent was told too.
                ...(round.feedback === undefined ? {} : { feedback: { kind: round.feedback.kind, level: round.feedback.level, passed: round.feedback.passed, ...verdictJson(round.feedback) } }),
              }),
            )
            // What matched, never the content around it (docs/05 §6.4). An
            // incident ended the gate; advisory signs came with a measured round.
            const signals = e.tamper ?? round.advisory
            if (signals !== undefined) {
              const severity = e.tamper === undefined ? 'advisory' : 'incident'
              io.out(JSON.stringify({ type: 'tamper', round: round.round, suite: e.suite, severity, signals }))
              if (severity === 'advisory') io.err(`gate: round ${round.round} advisory — ${[...new Set(signals.map((t) => `${t.signal} in ${t.where}`))].join(', ')}`)
            }
            io.err(gateRoundLine(round))
          },
        },
      ).finally(() => toolEvents?.dispose())
      io.out(
        JSON.stringify({
          type: 'gate',
          accepted: result.accepted,
          level: result.level,
          rounds: result.rounds.length,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        }),
      )
      io.err(gateResultLine(result))
      text = result.final.text
      completed = result.accepted
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
    const spent = spentNow()
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
    if (pilot === undefined && gate === undefined && team === undefined) throw error
    // Plan mode, a team spec and the gate have spent real tokens by now (a
    // failed landing, a snapshot or review that failed after a round); report
    // them rather than exiting like a crash.
    io.out(JSON.stringify({ type: 'error', message: String(error instanceof Error ? error.message : error) }))
    io.err(String(error instanceof Error ? (error.stack ?? error.message) : error))
    emitStop()
    return 1
  } finally {
    if (capPoll !== undefined) clearInterval(capPoll)
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
