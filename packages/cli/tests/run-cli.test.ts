/**
 * Keyless contract test for `openswarm run` — the headless eval entry point.
 *
 * The assertions run our real stdout through a faithful copy of swarmkit-eval's
 * `openSwarmParse` (`adapters/harness/cli-adapter.ts`), because "we emit JSONL"
 * and "the harness can read what we emit" are different claims and only the
 * second one matters. swarmkit-eval is not a dependency here, so the parser is
 * vendored; if it drifts upstream this test goes stale silently, which is the
 * cost of not having the package on hand.
 *
 * The budget case is the load-bearing one. `sawResult` is set by `message_stop`
 * ALONE, so a capped run that exits without one reads to the adapter exactly
 * like a crash — same usage (zero), same missing result. Asserting `sawResult`
 * only on the happy path would be a guard that cannot fail where it matters.
 */
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { runCli } from '../src/index'

let mock: MockLlmServer | undefined
const originalCwd = process.cwd()
afterEach(async () => {
  process.chdir(originalCwd)
  await mock?.close()
  mock = undefined
})

/** Verbatim port of swarmkit-eval's `openSwarmParse` (cli-adapter.ts:379). */
function openSwarmParse(stdout: string) {
  let output = ''
  let isError = false
  let sawResult = false
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0 }
  const trajectory: { type: string; ts: number; name: string }[] = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    let o: { type?: string; text?: string; name?: string; usage?: Record<string, number> }
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o.type === 'text_delta' && typeof o.text === 'string') output += o.text
    else if (o.type === 'tool_use_start') trajectory.push({ type: 'tool', ts: trajectory.length, name: o.name ?? 'tool' })
    else if (o.type === 'error') isError = true
    else if (o.type === 'message_stop') {
      sawResult = true
      const u = o.usage ?? {}
      usage.inputTokens += u['inputTokens'] ?? 0
      usage.outputTokens += u['outputTokens'] ?? 0
      usage.cacheReadTokens += u['cacheReadInputTokens'] ?? 0
    }
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens
  return { output: output.slice(0, 4000), usage, trajectory, isError, sawResult }
}

async function startMock(overrides: Parameters<typeof startMockLlmServer>[0]): Promise<void> {
  mock = await startMockLlmServer(overrides)
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  process.env['OPENSWARM_LLM_BASE_URL'] = base
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'
}

it('run --single: the harness parser reads output, tools and usage back', async () => {
  await startMock({
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'the task is done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo hi' }),
  })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const errs: string[] = []
  const code = await runCli(
    ['run', '--headless', '--output-format', 'json', '--model', 'mock-small', '--single', 'do the thing'],
    { out: (l) => lines.push(l), err: (l) => errs.push(l) },
  )
  expect(errs.join('\n')).toBe('')
  expect(code).toBe(0)

  const parsed = openSwarmParse(lines.join('\n'))
  expect(parsed.sawResult).toBe(true)
  expect(parsed.isError).toBe(false)
  expect(parsed.output).toContain('the task is done')
  expect(parsed.trajectory.map((t) => t.name)).toContain('bash')
  expect(parsed.usage.inputTokens).toBeGreaterThan(0)
  expect(parsed.usage.outputTokens).toBeGreaterThan(0)
  expect(parsed.usage.totalTokens).toBe(
    parsed.usage.inputTokens + parsed.usage.outputTokens + parsed.usage.cacheReadTokens,
  )
}, 60_000)

it('the prompt survives argument parsing even when a word repeats a flag value', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  // "mock-small" also appears as --model's value; a positional scan that matched
  // by token would drop it and silently mangle the task.
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', 'rename mock-small to mock-large'],
    { out: () => {}, err: () => {} },
  )
  expect(code).toBe(0)
  const sent = JSON.stringify(mock!.requests[0])
  expect(sent).toContain('rename mock-small to mock-large')
}, 60_000)

it('--max-turns stops the run AND still reports a result the harness can read', async () => {
  await startMock({
    apiKey: 'mock-key',
    // Never finishes on its own: every turn calls a tool, so only the cap ends it.
    sequence: ['tool_call_success'],
    repeatLast: true,
    successText: 'unreachable',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'true' }),
  })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--max-turns', '2', 'loop forever'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(3)

  const raw = lines.map((l) => JSON.parse(l))
  expect(raw.find((o) => o.type === 'budget_exceeded')?.limit).toMatch(/max-turns/)

  // The whole point: a budget stop is a RESULT, not a crash.
  const parsed = openSwarmParse(lines.join('\n'))
  expect(parsed.sawResult).toBe(true)
  expect(parsed.usage.totalTokens).toBeGreaterThan(0)
}, 60_000)

it('rejects an unrecognized --permission-mode instead of quietly downgrading', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--permission-mode', 'yolo', 'go'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(1)
  expect(lines.join('\n')).toMatch(/unknown --permission-mode/)
}, 60_000)

it('--max-tokens stops the run and reports the usage actually spent', async () => {
  await startMock({
    apiKey: 'mock-key',
    sequence: ['tool_call_success'],
    repeatLast: true,
    successText: 'unreachable',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'true' }),
  })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--max-tokens', '1', 'spend it all'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(3)
  expect(lines.map((l) => JSON.parse(l)).find((o) => o.type === 'budget_exceeded')?.limit).toMatch(/max-tokens/)
  const parsed = openSwarmParse(lines.join('\n'))
  expect(parsed.sawResult).toBe(true)
  expect(parsed.usage.totalTokens).toBeGreaterThan(0)
}, 60_000)

it('--team runs the coordinator topology and still honors the output contract', async () => {
  // The coordinator's first turn MUST parse as a numbered plan (runCoordinator
  // throws otherwise), so the scripted reply is a list, not prose.
  await startMock({
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: '1. first subtask\n2. second subtask',
  })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const errs: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--team', '--workers', '2', 'ship it'],
    { out: (l) => lines.push(l), err: (l) => errs.push(l) },
  )
  expect(errs.join('\n')).toBe('')
  expect(code).toBe(0)
  const parsed = openSwarmParse(lines.join('\n'))
  expect(parsed.sawResult).toBe(true)
  expect(parsed.usage.totalTokens).toBeGreaterThan(0)
}, 120_000)

it('accepts the Claude-Code permission vocabulary the harness adapter defaults to', async () => {
  // CliHarnessAdapter falls back to "bypassPermissions" when no mode is set, so
  // rejecting it would break every cell that does not override the default.
  await startMock({
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo hi > alias-proof.txt' }),
  })
  const ws = mkdtempSync(join(tmpdir(), 'openswarm-run-ws-'))
  process.chdir(ws)

  const lines: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--permission-mode', 'bypassPermissions', 'go'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(0)
  expect(openSwarmParse(lines.join('\n')).sawResult).toBe(true)
  // Mapped to danger-full-access, not merely accepted: the write went through.
  expect(existsSync(join(ws, 'alias-proof.txt'))).toBe(true)
}, 60_000)

it('refuses --max-cost-usd rather than letting an uncapped run look capped', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--max-cost-usd', '5', 'go'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(1)
  expect(lines.join('\n')).toMatch(/--max-cost-usd is not supported/)
}, 60_000)

it('still rejects a mode with no faithful headless equivalent', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  // "default" means ask a human per action; headless there is nobody to ask.
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--permission-mode', 'default', 'go'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(1)
  expect(lines.join('\n')).toMatch(/unknown --permission-mode/)
}, 60_000)

it('flags a run that never reached a model instead of reporting an empty answer', async () => {
  // No mock server: the route resolves but nothing answers, so no usage is
  // billed. Previously this exited 1 with an empty text_delta, which parses as
  // isError=false with a real result — a broken run scored as a legitimate zero.
  process.env['OPENSWARM_LLM_BASE_URL'] = 'http://127.0.0.1:1/v1'
  process.env['OPENSWARM_LLM_API_KEY'] = 'unused'
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--max-turns', '2', 'go'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).not.toBe(0)
  const parsed = openSwarmParse(lines.join('\n'))
  expect(parsed.isError).toBe(true)
  expect(parsed.usage.totalTokens).toBe(0)
}, 60_000)

it('accepts the verbless form the harness spec actually emits', async () => {
  // openSwarmSpec.flags() emits no `run` verb — the prompt is positional after
  // the flags. Requiring the verb made every cell exit 2 with zero usage.
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'verbless ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))

  const lines: string[] = []
  const code = await runCli(
    ['--single', '--headless', '--output-format', 'json', '--model', 'mock-small', '--permission-mode',
     'danger-full-access', 'solve the thing'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(0)
  const parsed = openSwarmParse(lines.join('\n'))
  expect(parsed.sawResult).toBe(true)
  expect(parsed.output).toContain('verbless ok')
}, 60_000)

/**
 * The self-modification arm must CHANGE THE AGENT, not just accept a flag.
 * These two cases are the arm's discrimination proof: the same invocation with
 * and without `--self-modify` differs in whether `swarm_author_plugin` is
 * offered to the model. Asserting only that the flag parses would pass just as
 * happily with the plugin never mounted — an experiment arm that is a no-op.
 */
const toolNamesOf = (mock: MockLlmServer): string[] =>
  JSON.stringify(mock.requests[0] ?? {}).match(/"name":"[a-z_]+"/g)?.map((m) => m.slice(8, -1)) ?? []

it('--self-modify offers swarm_author_plugin to the model', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', '--self-modify', 'improve yourself'],
    { out: () => {}, err: () => {} },
  )
  expect(code).toBe(0)
  expect(toolNamesOf(mock!)).toContain('swarm_author_plugin')
}, 60_000)

it('without --self-modify the authoring tool is absent', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))
  const code = await runCli(
    ['run', '--output-format', 'json', '--model', 'mock-small', 'improve yourself'],
    { out: () => {}, err: () => {} },
  )
  expect(code).toBe(0)
  const names = toolNamesOf(mock!)
  expect(names).not.toContain('swarm_author_plugin')
  // Sanity: the tool list was actually read, so "absent" means absent rather
  // than "the regex found nothing at all".
  expect(names.length).toBeGreaterThan(0)
}, 60_000)

it('OPENSWARM_SELF_MODIFY=1 selects the arm, since an eval Arm carries env not flags', async () => {
  await startMock({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true, successText: 'ok' })
  process.chdir(mkdtempSync(join(tmpdir(), 'openswarm-run-ws-')))
  process.env['OPENSWARM_SELF_MODIFY'] = '1'
  try {
    const code = await runCli(
      ['run', '--output-format', 'json', '--model', 'mock-small', 'improve yourself'],
      { out: () => {}, err: () => {} },
    )
    expect(code).toBe(0)
    expect(toolNamesOf(mock!)).toContain('swarm_author_plugin')
  } finally {
    delete process.env['OPENSWARM_SELF_MODIFY']
  }
}, 60_000)
