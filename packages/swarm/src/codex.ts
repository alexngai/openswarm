/**
 * The `codex` member runtime (docs/05 §5.4 basic conformance, R2): one member
 * run as the user's installed `codex` CLI headless (`codex exec --json`), in
 * the member's cwd, as a `claude-code` member runs Claude Code (R1). It takes
 * the prompt a dsh member gets, returns the final text and a stop reason, and
 * journals the run's usage; Codex reports no dollars, so a pricing table
 * prices them by the member's model.
 *
 * The stream (codex-rs `exec/src/exec_events.rs`): `thread.started` carries
 * the run's id; each `item.completed` whose item is an `agent_message` is the
 * agent speaking, the last one its answer; `turn.completed` ends the run with
 * the thread's usage; `turn.failed` and `error` carry what went wrong. Exec
 * never asks for approval, and the sandbox is pinned with `-s`, since the
 * user's config.toml could otherwise choose it. Codex handles SIGINT (it
 * interrupts the turn and its shell children) but no SIGTERM, so a stop
 * interrupts first. Basic only: one run, `--ephemeral`, no mid-run messages.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { cliEnv, runCli } from './cli-runtime'
import { emptyUsage, type RecordUsage, type Usage, type UsageRole } from './metrics'
import type { CodexSandbox, MemberRunResult, MemberSpec } from './types'

/** The CLI a codex member runs: the configured one, else `OPENSWARM_CODEX_BIN`, else `codex` on PATH. */
export const codexCommandOf = (configured?: string): string => configured ?? process.env['OPENSWARM_CODEX_BIN'] ?? 'codex'

/**
 * The parent's environment without its credentials and the launcher's routes,
 * keeping `CODEX_*`: `CODEX_HOME` (where the user's login is), and
 * `CODEX_API_KEY` or `CODEX_ACCESS_TOKEN` when they log in that way.
 */
export const codexEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => cliEnv((name) => /^CODEX_/i.test(name), env)

/** Before any spend, that `command --version` runs, as {@link preflightClaude} does for Claude Code. */
export async function preflightCodex(command: string): Promise<void> {
  try {
    await promisify(execFile)(command, ['--version'], { env: codexEnv(), timeout: 30_000 })
  } catch (error) {
    throw new Error(
      `codex members need the codex CLI, and "${command} --version" failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); install it, or set worktrees.member.codexCommand or OPENSWARM_CODEX_BIN`,
    )
  }
}

/**
 * `turn.completed`'s usage as a Usage. Codex counts cached input inside
 * `input_tokens`, as the OpenAI API does, so the fresh part is the
 * difference; `output_tokens` already holds reasoning.
 */
const codexUsage = (u: any, calls: number): Usage => {
  const cached = Number(u?.cached_input_tokens ?? 0)
  return { inputTokens: Math.max(0, Number(u?.input_tokens ?? 0) - cached), outputTokens: Number(u?.output_tokens ?? 0), cacheReadTokens: cached, cacheWriteTokens: 0, calls }
}

/**
 * One codex member run in `cwd`. Never rejects: a CLI that cannot start,
 * fails its turn, exits without finishing it or runs past its timeout settles
 * as `error` with a diagnostic as its text; a signal already aborted settles
 * `aborted` without starting it. Its usage is journaled however it ends:
 * Codex reports it only when the turn completes, so a run cut short is
 * journaled as unmeasured.
 */
export async function runCodex(
  member: MemberSpec,
  prompt: string,
  options: {
    cwd: string
    signal?: AbortSignal | undefined
    /** The CLI (default `OPENSWARM_CODEX_BIN`, else `codex` on PATH). */
    command?: string | undefined
    /** When the member names none (default `workspace-write`). */
    sandbox?: CodexSandbox | undefined
    /** When the member names none: the whole run's bound (default none). */
    timeoutMs?: number | undefined
    /** How long the CLI has to exit after its turn ends (default 10s). */
    exitGraceMs?: number | undefined
    usage?: RecordUsage | undefined
    taskKey?: string | undefined
    role?: UsageRole | undefined
  },
): Promise<MemberRunResult> {
  if (options.signal?.aborted === true) return { member: member.name, runId: '', text: '', output: [], stopReason: 'aborted' }
  const command = codexCommandOf(options.command)
  const timeoutMs = member.codexTimeoutMs ?? options.timeoutMs
  const text = member.persona === undefined ? prompt : `${member.persona}\n\n${prompt}`
  const model = member.agentOptions?.model
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--color', 'never',
    '-s', member.codexSandbox ?? options.sandbox ?? 'workspace-write',
    '-C', options.cwd,
    ...(model === undefined ? [] : ['-m', model]),
  ]
  const startedAt = Date.now()

  let threadId: string | undefined
  let said = ''
  let usage: any
  let failure: string | undefined
  /** The last `error` event: not fatal by itself (reconnect warnings send one), only the diagnostic if the turn fails. */
  let warning: string | undefined
  let turns = 0
  const { exit, stderr, spawnError, aborted, timedOut } = await runCli({
    command,
    args,
    cwd: options.cwd,
    env: codexEnv(),
    input: text,
    interrupt: 'SIGINT',
    signal: options.signal,
    timeoutMs,
    exitGraceMs: options.exitGraceMs,
    onLine: (line, done) => {
      let event: any
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event?.type === 'thread.started') threadId = event.thread_id
      else if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') said = event.item.text
      else if (event?.type === 'turn.started') turns++
      else if (event?.type === 'turn.completed') {
        usage = event.usage
        done()
      } else if (event?.type === 'turn.failed') {
        failure = String(event.error?.message ?? 'turn failed')
        done()
      } else if (event?.type === 'error') warning = String(event.message ?? 'error')
    },
  })

  let stopReason: MemberRunResult['stopReason']
  let output = said
  if (aborted) stopReason = 'aborted'
  else if (usage !== undefined) stopReason = 'completed'
  else {
    stopReason = 'error'
    const why =
      spawnError !== undefined
        ? `could not run "${command}" (${spawnError.message}); set worktrees.member.codexCommand or OPENSWARM_CODEX_BIN`
        : failure !== undefined
          ? `failed: ${failure}`
          : timedOut
            ? `timed out after ${timeoutMs}ms before its turn ended`
            : `exited (${exit}) before its turn ended`
    const detail = [said, ...(warning === undefined || warning === failure ? [] : [warning]), stderr.trim()].filter((s) => s !== '')
    output = `codex ${why}${detail.length === 0 ? '' : `\n${detail.join('\n')}`}`
  }

  const runId = threadId ?? `codex-${randomUUID().slice(0, 8)}`
  // A run that started but never completed its turn spent what Codex never
  // reported: journaled as unmeasured, so metrics count it as unreported and a
  // dollar budget treats it as unpriced, rather than as a free run.
  if (usage !== undefined || threadId !== undefined) {
    await options
      .usage?.({
        member: member.name,
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.taskKey === undefined ? {} : { taskKey: options.taskKey }),
        runtime: 'codex',
        provider: 'openai',
        // The model asked for; Codex's stream does not name the one it used.
        ...(model === undefined ? {} : { model }),
        runId,
        usage: usage === undefined ? emptyUsage() : codexUsage(usage, turns),
        ...(usage === undefined ? { unmeasured: true as const } : {}),
        startedAt,
      })
      // The member's own result stands; a journal that cannot append fails the run's record anyway.
      .catch(() => undefined)
  }

  return { member: member.name, runId, text: output, output: output === '' ? [] : [{ type: 'text', text: output }], stopReason }
}
