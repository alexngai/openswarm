/**
 * Live smoke: the eval-facing CLI on real Azure gpt-5.5 — azureoai/ model
 * mapping, real bash tool work in the workspace, the command-confidence
 * gate, and real per-model usage accounting.
 *
 *   source ~/.zshrc && OPENSWARM_LIVE=1 npx vitest run packages/cli/tests/azure-cli-live.test.ts
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runCli } from '../src/index'

const live =
  process.env['OPENSWARM_LIVE'] === '1' &&
  process.env['AZURE_API_BASE'] !== undefined &&
  process.env['AZURE_API_KEY'] !== undefined
const MODEL = `azureoai/${process.env['OPENSWARM_LIVE_MODEL'] ?? 'gpt-5.5'}`

const originalCwd = process.cwd()
afterEach(() => process.chdir(originalCwd))

it.skipIf(!live)('live: command-gated cascade tier passes on real gpt-5.5', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'openswarm-cli-live-'))
  const scratch = mkdtempSync(join(tmpdir(), 'openswarm-cli-live-scratch-'))
  writeFileSync(
    join(scratch, 'team.json'),
    JSON.stringify({
      topology: 'cascade',
      members: [
        {
          id: 'tier-0',
          role: 'worker',
          prompt:
            'Using the bash tool, create a file named hello.txt in the current directory containing exactly the single line HELLO. Verify it, then confirm you are done.',
          model: MODEL,
        },
      ],
      coordination: {
        completion: { kind: 'all' },
        escalationTau: 0.5,
        escalationEvaluator: 'command',
        escalationCommands: ['grep -q HELLO hello.txt'],
      },
    }),
  )
  process.chdir(workspace)
  const lines: string[] = []
  const code = await runCli(
    [
      'topology', 'cascade',
      '--spec', join(scratch, 'team.json'),
      '--output', join(scratch, 'results.jsonl'),
      '--trace-output', join(scratch, 'trace.jsonl'),
      '--headless', '--output-format', 'json',
    ],
    { out: (l) => lines.push(l), err: (l) => console.error(l) },
  )
  expect(code).toBe(0)
  expect(readFileSync(join(workspace, 'hello.txt'), 'utf8').trim()).toBe('HELLO')
  expect(readFileSync(join(scratch, 'trace.jsonl'), 'utf8')).toMatch(/accepted at tier 0 after 0 escalation/)
  const usageLine = JSON.parse(readFileSync(join(scratch, 'results.jsonl'), 'utf8').trim())
  expect(usageLine.byModel[MODEL].totalTokens).toBeGreaterThan(0)
  expect(usageLine.byModel[MODEL].calls).toBeGreaterThanOrEqual(2)
}, 300_000)

const bedrockLive = process.env['OPENSWARM_LIVE'] === '1' && process.env['AWS_BEARER_TOKEN_BEDROCK'] !== undefined
const HAIKU = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

it.skipIf(!bedrockLive)('live: bedrock haiku tier completes with real usage', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'openswarm-cli-bedrock-'))
  const scratch = mkdtempSync(join(tmpdir(), 'openswarm-cli-bedrock-s-'))
  writeFileSync(
    join(scratch, 'team.json'),
    JSON.stringify({
      topology: 'cascade',
      members: [
        {
          id: 'tier-0',
          prompt:
            'Using the bash tool, create a file named hello.txt containing exactly the single line HELLO. Then confirm you are done.',
          model: HAIKU,
        },
      ],
      coordination: { escalationTau: 0.5, escalationEvaluator: 'command', escalationCommands: ['grep -q HELLO hello.txt'] },
    }),
  )
  process.chdir(workspace)
  const lines: string[] = []
  const code = await runCli(
    ['topology', 'cascade', '--spec', join(scratch, 'team.json'), '--output', join(scratch, 'results.jsonl'), '--headless'],
    { out: (l) => lines.push(l), err: (l) => console.error(l) },
  )
  expect(code).toBe(0)
  expect(readFileSync(join(workspace, 'hello.txt'), 'utf8').trim()).toBe('HELLO')
  const usage = JSON.parse(readFileSync(join(scratch, 'results.jsonl'), 'utf8').trim())
  expect(usage.byModel[HAIKU].totalTokens).toBeGreaterThan(0)
  expect(usage.byModel[HAIKU].calls).toBeGreaterThanOrEqual(2)
}, 300_000)

it.skipIf(!bedrockLive || !live)(
  'live: heterogeneous cascade — haiku tier gated, gpt-5.5 rescues',
  async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'openswarm-cli-hetero-'))
    const scratch = mkdtempSync(join(tmpdir(), 'openswarm-cli-hetero-s-'))
    writeFileSync(
      join(scratch, 'team.json'),
      JSON.stringify({
        topology: 'cascade',
        members: [
          // The gate demands a file the small tier is not told about, forcing
          // escalation; the large tier is told exactly what to do.
          { id: 'tier-0', prompt: 'Reply with the word READY. Do not use any tools.', model: HAIKU },
          {
            id: 'tier-1',
            prompt:
              'Using the bash tool, create a file named secret.txt containing exactly the single line RESCUED. Then confirm you are done.',
            model: MODEL,
          },
        ],
        coordination: { escalationTau: 0.5, escalationEvaluator: 'command', escalationCommands: ['grep -q RESCUED secret.txt'] },
      }),
    )
    process.chdir(workspace)
    const lines: string[] = []
    const code = await runCli(
      ['topology', 'cascade', '--spec', join(scratch, 'team.json'), '--output', join(scratch, 'results.jsonl'), '--trace-output', join(scratch, 'trace.jsonl'), '--headless'],
      { out: (l) => lines.push(l), err: (l) => console.error(l) },
    )
    expect(code).toBe(0)
    expect(readFileSync(join(scratch, 'trace.jsonl'), 'utf8')).toMatch(/after 1 escalation/)
    const usage = JSON.parse(readFileSync(join(scratch, 'results.jsonl'), 'utf8').trim())
    // Cross-provider per-model attribution: both tiers accounted.
    expect(usage.byModel[HAIKU].totalTokens).toBeGreaterThan(0)
    expect(usage.byModel[MODEL].totalTokens).toBeGreaterThan(0)
  },
  300_000,
)
