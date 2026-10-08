/**
 * The `claude-code` member runtime (docs/05 §5.4 basic conformance, R1): one
 * member run as the user's installed `claude` CLI in headless mode
 * (`-p --output-format stream-json --verbose`), in the member's cwd: its task
 * worktree under worktree execution. It takes the prompt a dsh member gets
 * (persona, intent header, task), returns the final text and a stop reason,
 * journals the run's usage and the dollars the CLI reports, and is cancelled
 * by signalling the CLI's process group and the descendants it had started.
 *
 * Not dsh's `dsh-subagent-claude-code`: that provider always runs in its
 * parent session's cwd, so never in a member's worktree, and reports no
 * usage, which the contract requires (docs/01 ledger). Basic only: no
 * mid-run messages and no session across runs, so messaging teams refuse it.
 * Claude Code's own permission mode and settings govern what it may do;
 * OpenSwarm's member sandbox (§5.5) covers dsh members only.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { addUsage, emptyUsage, type RecordUsage, type Usage, type UsageRole } from './metrics'
import type { ClaudePermissionMode, ClaudeSettingSource, MemberRunResult, MemberSpec } from './types'

declare module '@deepseek-ai/dsh-subagent' {
  interface SubagentStopReasonMap {
    /** A claude-code member hit Claude Code's turn limit (`error_max_turns`). */
    'max-turns': 'max-turns'
  }
}

/** Credential-shaped names, as dsh's spawner scrubs them (`@deepseek-ai/dsh-subprocess`'s `SENSITIVE_ENV_PATTERN`). */
const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i
/** The launcher's own routes: OpenSwarm's, dsh's, and the providers its dsh members speak. */
const ROUTES = /^(OPENSWARM_|DSH_|DEEPSEEK_|OPENAI_|AZURE_API_)/i

/** How long a stopped CLI's processes have between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 5_000
/** How long the CLI has to exit once it has sent its result. */
const EXIT_GRACE_MS = 10_000

/** The CLI a claude-code member runs: the configured one, else `OPENSWARM_CLAUDE_BIN`, else `claude` on PATH. */
export const claudeCommandOf = (configured?: string): string => configured ?? process.env['OPENSWARM_CLAUDE_BIN'] ?? 'claude'

/**
 * The parent's environment without its credentials and the launcher's routes,
 * keeping what Claude Code itself reads: `ANTHROPIC_*` and `CLAUDE_*` (an API
 * key, an OAuth token), and `AWS_*` when it is set to use Bedrock.
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const bedrock = env['CLAUDE_CODE_USE_BEDROCK'] !== undefined && env['CLAUDE_CODE_USE_BEDROCK'] !== '' && env['CLAUDE_CODE_USE_BEDROCK'] !== '0'
  const kept = (name: string) => /^(ANTHROPIC_|CLAUDE_)/i.test(name) || (bedrock && /^AWS_/i.test(name))
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && (kept(entry[0]) || !(SENSITIVE.test(entry[0]) || ROUTES.test(entry[0])))),
  )
}

/**
 * Before any spend, that `command --version` runs: a run with claude-code
 * members fails up front, not on its first member, when the CLI is missing.
 */
export async function preflightClaude(command: string): Promise<void> {
  try {
    await promisify(execFile)(command, ['--version'], { env: claudeEnv(), timeout: 30_000 })
  } catch (error) {
    throw new Error(
      `claude-code members need the claude CLI, and "${command} --version" failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); install it, or set worktrees.member.claudeCommand or OPENSWARM_CLAUDE_BIN`,
    )
  }
}

/** A Messages API usage record (snake_case) as a Usage of one call. */
const apiUsage = (u: any): Usage => ({
  inputTokens: u?.input_tokens ?? 0,
  outputTokens: u?.output_tokens ?? 0,
  cacheReadTokens: u?.cache_read_input_tokens ?? 0,
  cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  calls: 1,
})

/** Every process descending from `pid` now, by walking `ps`'s parent links. */
function descendants(pid: number): number[] {
  let table: string
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child !== undefined && parent !== undefined && !Number.isNaN(parent)) children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  for (const queue = [pid]; queue.length > 0; ) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * One claude-code member run in `cwd`. Never rejects: a CLI that cannot
 * start, exits without a result, runs past its timeout or reports an error
 * settles as `error` with a diagnostic as its text; a signal already aborted
 * settles `aborted` without starting it. Its usage is journaled through
 * `usage` however it ends: the CLI's own totals and `total_cost_usd`, else
 * (a cancelled or crashed run) the sum of the assistant messages it streamed.
 */
export async function runClaudeCode(
  member: MemberSpec,
  prompt: string,
  options: {
    cwd: string
    signal?: AbortSignal | undefined
    /** The CLI (default `OPENSWARM_CLAUDE_BIN`, else `claude` on PATH). */
    command?: string | undefined
    /** When the member names none (default `acceptEdits`). */
    permissionMode?: ClaudePermissionMode | undefined
    /** When the member names none (default: the CLI's own, every source). */
    settingSources?: ClaudeSettingSource[] | undefined
    /** When the member names none: the whole run's bound (default none). */
    timeoutMs?: number | undefined
    /** How long the CLI has to exit after its result (default 10s). */
    exitGraceMs?: number | undefined
    usage?: RecordUsage | undefined
    taskKey?: string | undefined
    role?: UsageRole | undefined
  },
): Promise<MemberRunResult> {
  if (options.signal?.aborted === true) return { member: member.name, runId: '', text: '', output: [], stopReason: 'aborted' }
  const command = claudeCommandOf(options.command)
  const sources = member.claudeSettingSources ?? options.settingSources
  const timeoutMs = member.claudeTimeoutMs ?? options.timeoutMs
  const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
  const requested = member.agentOptions?.model
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--permission-mode', member.permissionMode ?? options.permissionMode ?? 'acceptEdits',
    ...(requested === undefined ? [] : ['--model', requested]),
    ...(sources === undefined ? [] : ['--setting-sources', sources.join(',')]),
  ]
  const startedAt = Date.now()

  let init: any
  let result: any
  let stderr = ''
  let spawnError: Error | undefined
  let aborted = false
  let timedOut = false
  /** Streamed assistant usage by message id (one API call may stream as several messages). */
  const calls = new Map<string, Usage>()
  let lingering: ReturnType<typeof setTimeout> | undefined

  // Its own process group, so a stop reaches what it starts there. The prompt
  // goes on stdin: no ARG_MAX, and a prompt starting with `-` is not a flag.
  const child = spawn(command, args, { cwd: options.cwd, env: claudeEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const group = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  let stopping = false
  /**
   * SIGTERM, then SIGKILL after a grace, to the CLI's process group and every
   * descendant it has now. Claude Code starts its Bash tool and hooks in
   * sessions of their own, outside its group, so they are found by parent
   * link while the CLI is alive. ponytail: one `ps` walk at the stop; what
   * they spawn after it, or detach from them, outlives the member until
   * Claude's own shutdown reaps it.
   */
  const stop = () => {
    if (stopping || child.pid === undefined) return
    stopping = true
    const tree = descendants(child.pid)
    const signal = (sig: NodeJS.Signals) => {
      group(sig)
      for (const pid of tree) {
        try {
          process.kill(pid, sig)
        } catch {}
      }
    }
    signal('SIGTERM')
    // Never cleared: a tool process outside its group may outlast the CLI.
    setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref()
  }
  const cancel = () => {
    aborted = true
    stop()
  }
  options.signal?.addEventListener('abort', cancel, { once: true })
  const bounded = timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), stop()), timeoutMs)

  const take = (line: string) => {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg?.type === 'system' && msg.subtype === 'init') init = msg
    else if (msg?.type === 'assistant' && msg.message?.usage !== undefined) calls.set(String(msg.message.id ?? calls.size), apiUsage(msg.message.usage))
    else if (msg?.type === 'result' && result === undefined) {
      result = msg
      // Its answer is in; a CLI that lingers past the grace is stopped.
      lingering = setTimeout(stop, options.exitGraceMs ?? EXIT_GRACE_MS)
    }
  }
  let pending = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n')
    pending = lines.pop()!
    lines.forEach(take)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr = (stderr + chunk).slice(-4_000)))
  // A CLI that exits before reading its prompt closes the pipe under us.
  child.stdin.on('error', () => undefined)
  child.stdin.end(text)
  const exit = await new Promise<string>((resolve) => {
    child.once('error', (error) => {
      spawnError = error
      resolve(error.message)
    })
    // Reap what it left running in its group, so its pipes close and `close` comes.
    child.once('exit', () => group('SIGKILL'))
    child.once('close', (code, signal) => resolve(signal ?? `code ${code}`))
  })
  take(pending)
  clearTimeout(bounded)
  clearTimeout(lingering)
  options.signal?.removeEventListener('abort', cancel)

  const said = typeof result?.result === 'string' ? (result.result as string) : ''
  let stopReason: MemberRunResult['stopReason']
  let output = said
  if (aborted) stopReason = 'aborted'
  else if (result?.subtype === 'success' && result.is_error !== true) stopReason = 'completed'
  else if (result?.subtype === 'error_max_turns') {
    stopReason = 'max-turns'
    output = said || `claude-code stopped at its turn limit after ${result.num_turns ?? '?'} turn(s)`
  } else {
    stopReason = 'error'
    const why =
      spawnError !== undefined
        ? `could not run "${command}" (${spawnError.message}); set worktrees.member.claudeCommand or OPENSWARM_CLAUDE_BIN`
        : result !== undefined
          ? `failed (${result.subtype}${result.is_error === true ? ', is_error' : ''})`
          : timedOut
            ? `timed out after ${timeoutMs}ms without a result`
            : `exited (${exit}) without a result`
    const detail = [said, ...(Array.isArray(result?.errors) ? result.errors.map(String) : []), stderr.trim()].filter((s) => s !== '')
    output = `claude-code ${why}${detail.length === 0 ? '' : `: ${detail.join('\n')}`}`
  }

  // ponytail: one record per run under the session's model, from the result's
  // `usage`; `modelUsage` splits side calls (a small model's) out, so read it
  // if per-model tokens must be exact. The dollars already cover them.
  const usage = result?.usage !== undefined ? { ...apiUsage(result.usage), calls: calls.size } : [...calls.values()].reduce(addUsage, emptyUsage())
  const model: string | undefined = init?.model ?? requested
  const runId: string = init?.session_id ?? result?.session_id ?? `claude-code-${randomUUID().slice(0, 8)}`
  await options
    .usage?.({
      member: member.name,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.taskKey === undefined ? {} : { taskKey: options.taskKey }),
      runtime: 'claude-code',
      provider: 'anthropic',
      ...(model === undefined ? {} : { model }),
      runId,
      usage,
      ...(typeof result?.total_cost_usd === 'number' ? { costUsd: result.total_cost_usd as number } : {}),
      startedAt,
    })
    // The member's own result stands; a journal that cannot append fails the run's record anyway.
    .catch(() => undefined)

  return { member: member.name, runId, text: output, output: output === '' ? [] : [{ type: 'text', text: output }], stopReason }
}
