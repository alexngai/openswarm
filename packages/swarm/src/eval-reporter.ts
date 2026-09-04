/**
 * `openswarm-swarm/eval-reporter` — JSONL telemetry for eval harnesses, mounted
 * into the REAL profile.
 *
 * ## Why this exists
 *
 * The eval path used to hand-mount its own ~14-plugin context in
 * `packages/cli`, because the dsh headless runner prints only the final
 * assistant message — no usage, no tool trajectory. That made every number we
 * measured a property of that hand-rolled stack rather than of openswarm: the
 * real `openswarm` profile composes 83 plugins, including `agent-instructions`,
 * `plan-mode`, `compaction-basic`, `tool-result-pruner`, `tool-fs-search`, the
 * skill system and the subagent tools — none of which the eval stack had.
 *
 * So instead of reimplementing the harness to make it observable, this makes
 * the real harness observable: one plugin, mounted via a patch layer, that
 * folds `session/event` into the JSONL contract `openSwarmParse` reads.
 *
 * ## Output contract (must match swarmkit-eval's `openSwarmParse`)
 *
 *   {"type":"tool_use_start","name":…}          per tool call, live
 *   {"type":"text_delta","text":…}              the final assistant text
 *   {"type":"message_stop","usage":{inputTokens,outputTokens,cacheReadInputTokens}}
 *
 * `message_stop` is emitted on EVERY exit path. The parser sets its `sawResult`
 * flag from that line alone, so a run that omits it is indistinguishable from a
 * crash regardless of what else it printed.
 *
 * Non-JSON lines are ignored by the parser, so the headless runner's own
 * plain-text final message passes through harmlessly.
 *
 * ## Off unless asked
 *
 * Gated on `OPENSWARM_JSONL=1`. The profile is shared with interactive use, and
 * an always-on reporter would spray JSONL into a human's terminal.
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'openswarm-eval-reporter'

interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
}

export function apply(ctx: Context): void {
  if (process.env['OPENSWARM_JSONL'] !== '1') return

  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }
  let finalText = ''
  let stopped = false

  const emit = (o: unknown): void => {
    process.stdout.write(`${JSON.stringify(o)}\n`)
  }

  /**
   * Emit the terminator exactly once. Registered on several exit paths because
   * whichever fires first must still produce a result line — a budget stop, a
   * clean finish and a fatal error all have to be distinguishable from a crash.
   */
  const stop = (): void => {
    if (stopped) return
    stopped = true
    emit({ type: 'text_delta', text: finalText })
    emit({ type: 'message_stop', usage })
  }

  ctx.on('session/event' as never, ((_session: unknown, event: any) => {
    if (event?.type === 'tool/call') {
      emit({ type: 'tool_use_start', name: event.data?.name ?? 'tool' })
      return
    }
    if (event?.type !== 'assistant/message') return
    // Same shape remote-peer.ts:95 reads: the blocks live under `message`.
    const text = textOf(event.data?.message?.content ?? event.data?.content)
    if (text.length > 0) finalText = text
    const u = event.data?.usage
    if (u === undefined) return
    usage.inputTokens += u.inputTokens ?? 0
    usage.outputTokens += u.outputTokens ?? 0
    usage.cacheReadInputTokens += u.cacheReadTokens ?? 0
  }) as never)

  process.on('beforeExit', stop)
  process.on('exit', stop)
}

/** Final text from a message's content blocks, tolerating either shape. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('')
}
