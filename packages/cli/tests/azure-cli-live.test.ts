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
