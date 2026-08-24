/**
 * Keyless CLI contract test: the exact invocation the eval harness's
 * CascadeAdapter issues, against the scriptable mock. Verifies the three
 * output surfaces the adapter reads — stdout JSONL (openSwarmParse), the
 * team_usage line, the escalation trace line — and the command-confidence
 * escalation itself: tier-0 completes but its gate command fails (no marker
 * file), tier-1's scripted bash creates the marker, the gate passes.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  startMockLlmServer,
  type MockLlmServer,
} from '@deepseek-ai/dsh-llm-mock-server'
import { runCli } from '../src/index'

let mock: MockLlmServer | undefined
const originalCwd = process.cwd()
afterEach(async () => {
  process.chdir(originalCwd)
  await mock?.close()
  mock = undefined
})

it('topology cascade: escalates on gate failure, honors the legacy output contract', async () => {
  mock = await startMockLlmServer({
    apiKey: 'mock-key',
    // tier-0 turn (no tool), then tier-1: bash creates the marker, closes.
    sequence: ['success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'cascade final answer',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'touch marker.txt' }),
  })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  process.env['OPENSWARM_LLM_BASE_URL'] = base
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'

  const workspace = mkdtempSync(join(tmpdir(), 'openswarm-cli-ws-'))
  const scratch = mkdtempSync(join(tmpdir(), 'openswarm-cli-scratch-'))
  const spec = {
    name: 'cascade',
    topology: 'cascade',
    members: [
      { id: 'tier-0', role: 'worker', prompt: 'fix the bug', model: 'mock-small' },
      { id: 'tier-1', role: 'worker', prompt: 'fix the bug', model: 'mock-large' },
    ],
    coordination: {
      completion: { kind: 'all' },
      escalationTau: 0.5,
      escalationEvaluator: 'command',
      escalationCommands: ['test -f marker.txt'],
    },
  }
  writeFileSync(join(scratch, 'team.json'), JSON.stringify(spec))

  process.chdir(workspace)
  const lines: string[] = []
  const errs: string[] = []
  const code = await runCli(
    [
      'topology', 'cascade',
      '--spec', join(scratch, 'team.json'),
      '--output', join(scratch, 'results.jsonl'),
      '--trace-output', join(scratch, 'trace.jsonl'),
      '--model', 'mock-small',
      '--permission-mode', 'danger-full-access',
      '--headless', '--output-format', 'json',
    ],
    { out: (l) => lines.push(l), err: (l) => errs.push(l) },
  )
  expect(errs.join('\n')).toBe('')
  expect(code).toBe(0)

  // The escalation actually happened: tier-1's bash created the marker.
  expect(existsSync(join(workspace, 'marker.txt'))).toBe(true)

  // stdout protocol (openSwarmParse shapes).
  const parsed = lines.map((l) => JSON.parse(l))
  expect(parsed.find((o) => o.type === 'tool_use_start')?.name).toBe('bash')
  expect(parsed.find((o) => o.type === 'text_delta')?.text).toContain('cascade final answer')
  const stop = parsed.find((o) => o.type === 'message_stop')
  expect(stop).toBeDefined()
  expect(stop.usage.inputTokens).toBeGreaterThan(0)
  expect(stop.usage.outputTokens).toBeGreaterThan(0)

  // team_usage line: both tiers' models with per-model calls.
  const usageLine = JSON.parse(readFileSync(join(scratch, 'results.jsonl'), 'utf8').trim())
  expect(usageLine.type).toBe('team_usage')
  expect(Object.keys(usageLine.byModel).sort()).toEqual(['mock-large', 'mock-small'])
  expect(usageLine.byModel['mock-small'].calls).toBeGreaterThanOrEqual(1)
  expect(usageLine.byModel['mock-large'].calls).toBeGreaterThanOrEqual(2) // tool turn = 2 requests
  expect(usageLine.team.totalTokens).toBe(
    usageLine.byModel['mock-small'].totalTokens + usageLine.byModel['mock-large'].totalTokens,
  )

  // Escalation trace line the adapter regexes.
  const trace = readFileSync(join(scratch, 'trace.jsonl'), 'utf8')
  expect(trace).toMatch(/after 1 escalation/)

  // Four mock requests total: tier-0, tier-1 tool call + continuation... plus none extra.
  expect(mock!.requests.length).toBe(3)
}, 60_000)

it('mono tier with no gate accepts immediately, zero escalations', async () => {
  mock = await startMockLlmServer({
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: 'mono answer',
  })
  const base = mock.baseURL.endsWith('/v1') ? mock.baseURL : `${mock.baseURL}/v1`
  process.env['OPENSWARM_LLM_BASE_URL'] = base
  process.env['OPENSWARM_LLM_API_KEY'] = 'mock-key'

  const workspace = mkdtempSync(join(tmpdir(), 'openswarm-cli-mono-'))
  const scratch = mkdtempSync(join(tmpdir(), 'openswarm-cli-mono-scratch-'))
  writeFileSync(
    join(scratch, 'team.json'),
    JSON.stringify({
      topology: 'cascade',
      members: [{ id: 'tier-0', prompt: 'answer', model: 'mock-model' }],
      coordination: { completion: { kind: 'all' }, escalationTau: 0.5 },
    }),
  )
  process.chdir(workspace)
  const lines: string[] = []
  const code = await runCli(
    ['topology', 'cascade', '--spec', join(scratch, 'team.json'), '--trace-output', join(scratch, 'trace.jsonl'), '--headless'],
    { out: (l) => lines.push(l), err: () => {} },
  )
  expect(code).toBe(0)
  expect(readFileSync(join(scratch, 'trace.jsonl'), 'utf8')).toMatch(/after 0 escalation/)
  expect(lines.some((l) => l.includes('mono answer'))).toBe(true)
})
