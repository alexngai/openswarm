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
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { cliEnv, runCli } from './cli-runtime'
import { addUsage, emptyUsage, type RecordUsage, type Usage, type UsageRole } from './metrics'
import type { ClaudePermissionMode, ClaudeSettingSource, MemberRunResult, MemberSpec } from './types'

declare module '@deepseek-ai/dsh-subagent' {
  interface SubagentStopReasonMap {
    /** A claude-code member hit Claude Code's turn limit (`error_max_turns`). */
    'max-turns': 'max-turns'
  }
}

/** The CLI a claude-code member runs: the configured one, else `OPENSWARM_CLAUDE_BIN`, else `claude` on PATH. */
export const claudeCommandOf = (configured?: string): string => configured ?? process.env['OPENSWARM_CLAUDE_BIN'] ?? 'claude'

/**
 * The parent's environment without its credentials and the launcher's routes,
 * keeping what Claude Code itself reads: `ANTHROPIC_*` and `CLAUDE_*` (an API
 * key, an OAuth token), and `AWS_*` when it is set to use Bedrock.
 */
export function claudeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const bedrock = env['CLAUDE_CODE_USE_BEDROCK'] !== undefined && env['CLAUDE_CODE_USE_BEDROCK'] !== '' && env['CLAUDE_CODE_USE_BEDROCK'] !== '0'
  return cliEnv((name) => /^(ANTHROPIC_|CLAUDE_)/i.test(name) || (bedrock && /^AWS_/i.test(name)), env)
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
  /** Streamed assistant usage by message id (one API call may stream as several messages). */
  const calls = new Map<string, Usage>()
  const { exit, stderr, spawnError, aborted, timedOut } = await runCli({
    command,
    args,
    cwd: options.cwd,
    env: claudeEnv(),
    input: text,
    interrupt: 'SIGTERM',
    signal: options.signal,
    timeoutMs,
    exitGraceMs: options.exitGraceMs,
    onLine: (line, done) => {
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
        done()
      }
    },
  })

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
