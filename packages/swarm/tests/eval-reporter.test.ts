/**
 * The eval-reporter's output contract, tested against a faithful copy of
 * swarmkit-eval's `openSwarmParse`.
 *
 * This plugin is now the ONLY way an eval sees a run, so its contract is the
 * whole measurement surface. The budget caps moved here from packages/cli
 * because this is where the usage they measure is folded.
 */
import { afterEach, expect, it, vi } from 'vitest'
import * as Reporter from '../src/eval-reporter'

/** Verbatim port of swarmkit-eval's `openSwarmParse` (cli-adapter.ts:379). */
function openSwarmParse(stdout: string) {
  let output = ''
  let isError = false
  let sawResult = false
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  const trajectory: string[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o: any
    try { o = JSON.parse(t) } catch { continue }
    if (o.type === 'text_delta' && typeof o.text === 'string') output += o.text
    else if (o.type === 'tool_use_start') trajectory.push(o.name ?? 'tool')
    else if (o.type === 'error') isError = true
    else if (o.type === 'message_stop') {
      sawResult = true
      usage.inputTokens += o.usage?.inputTokens ?? 0
      usage.outputTokens += o.usage?.outputTokens ?? 0
      usage.cacheReadTokens += o.usage?.cacheReadInputTokens ?? 0
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
  return { output, usage, trajectory, isError, sawResult }
}

const ENV = ['OPENSWARM_JSONL', 'OPENSWARM_MAX_TOKENS', 'OPENSWARM_MAX_TURNS']
const saved = new Map(ENV.map((k) => [k, process.env[k]]))
const mounted: (() => void)[] = []
afterEach(() => {
  mounted.splice(0).forEach((d) => d())
  for (const k of ENV) {
    const v = saved.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.restoreAllMocks()
})

/**
 * Drive `apply()` with a recording stub rather than a real Context.
 *
 * A bare cordis Context does not deliver `session/event` to a plugin-scoped
 * listener, so mounting one here tested the framework rather than the reporter.
 * Capturing the handler directly exercises the fold and the caps, which is the
 * logic that lives in this file; the end-to-end JSONL contract is covered by
 * running the real profile.
 */
function mount(): { fire: (event: unknown) => void; dispose: () => void; lines: () => string } {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => { chunks.push(String(c)); return true }) as never)
  const handlers: Record<string, Function[]> = {}
  const ctx = { on: (name: string, fn: Function) => { (handlers[name] ??= []).push(fn) } }
  ;(Reporter as any).apply(ctx)
  const dispose = () => (handlers['dispose'] ?? []).forEach((h) => h())
  mounted.push(dispose)
  return {
    fire: (event) => (handlers['session/event'] ?? []).forEach((h) => h({}, event)),
    dispose,
    lines: () => chunks.join(''),
  }
}

const assistant = (text: string, usage?: Record<string, number>) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] }, ...(usage ? { usage } : {}) },
})

it('emits a parseable run: tool calls, final text and usage', () => {
  process.env['OPENSWARM_JSONL'] = '1'
  const { fire, lines } = mount()
  fire({ type: 'tool/call', data: { name: 'write' } })
  fire(assistant('all done', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 }))
  process.emit('beforeExit', 0)

  const p = openSwarmParse(lines())
  expect(p.sawResult).toBe(true)
  expect(p.trajectory).toContain('write')
  expect(p.output).toContain('all done')
  expect(p.usage.inputTokens).toBe(100)
  expect(p.usage.cacheReadTokens).toBe(5)
})

it('stays silent unless OPENSWARM_JSONL=1', () => {
  delete process.env['OPENSWARM_JSONL']
  const { fire, lines } = mount()
  fire(assistant('hi', { inputTokens: 5 }))
  process.emit('beforeExit', 0)
  // The profile is shared with interactive use; an always-on reporter would
  // spray JSONL into a human's terminal.
  expect(lines()).toBe('')
})

it('--max-tokens stops the run AND still reports a usable result', () => {
  process.env['OPENSWARM_JSONL'] = '1'
  process.env['OPENSWARM_MAX_TOKENS'] = '50'
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const { fire, lines } = mount()
  fire(assistant('partial', { inputTokens: 60, outputTokens: 10 }))

  expect(exit).toHaveBeenCalledWith(3)
  const raw = lines()
  expect(raw).toContain('budget_exceeded')
  // Load-bearing: openSwarmParse sets sawResult from message_stop ALONE, so a
  // capped run that omitted it is indistinguishable from a crash.
  const p = openSwarmParse(raw)
  expect(p.sawResult).toBe(true)
  expect(p.usage.totalTokens).toBeGreaterThan(0)
})

it('--max-turns counts assistant turns, not tool calls', () => {
  process.env['OPENSWARM_JSONL'] = '1'
  process.env['OPENSWARM_MAX_TURNS'] = '2'
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const { fire, lines } = mount()
  for (let i = 0; i < 3; i++) {
    fire({ type: 'tool/call', data: { name: 'bash' } })
    fire(assistant(`turn ${i}`, { inputTokens: 1 }))
  }
  expect(exit).toHaveBeenCalledWith(3)
  expect(lines()).toContain('max-turns')
})

it('ignores a junk cap rather than treating it as zero', () => {
  process.env['OPENSWARM_JSONL'] = '1'
  process.env['OPENSWARM_MAX_TOKENS'] = 'not-a-number'
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const { fire } = mount()
  fire(assistant('fine', { inputTokens: 999 }))
  // A cap parsed as 0 would abort every run on its first turn.
  expect(exit).not.toHaveBeenCalled()
})
