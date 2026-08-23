/**
 * Live smoke (docs/01 Phase 3): `openswarm-llm-openai` chat routes against
 * Azure OpenAI's `/openai/v1` surface, driving the full stack — in-process
 * lead, worktree subprocess member, real bash tool calls, merge queue — on
 * real gpt-5.5.
 *
 * Local-only, env-gated:
 *   source ~/.zshrc && OPENSWARM_LIVE=1 npx vitest run \
 *     packages/swarm/tests/azure-live.test.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as OpenAiChat from '../../llm-openai/src/index'
import { bootHarness, type TestHarness } from './boot'

const MODEL = process.env['OPENSWARM_LIVE_MODEL'] ?? 'gpt-5.5'
const live =
  process.env['OPENSWARM_LIVE'] === '1' &&
  process.env['AZURE_API_BASE'] !== undefined &&
  process.env['AZURE_API_KEY'] !== undefined

const azureBase = () => `${(process.env['AZURE_API_BASE'] ?? '').replace(/\/+$/, '')}/openai/v1`

function azurePlugin() {
  return {
    module: OpenAiChat,
    config: {
      routes: ['openai'],
      baseURL: azureBase(),
      apiKeyEnv: 'AZURE_API_KEY',
      models: [{ id: MODEL, contextWindow: 200_000 }],
    },
    provider: 'openai',
    model: MODEL,
  }
}

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

it.skipIf(!live)('live: in-process member answers through Azure gpt-5.5', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' }, undefined, azurePlugin())
  const result = await h.swarm.runTeam(
    {
      topology: 'fanout',
      members: [{ name: 'probe' }],
      tasks: [{ member: 'probe', prompt: 'Reply with exactly the text PROBE_OK and nothing else.' }],
    },
    { parent: h.lead.agent },
  )
  if (result.topology !== 'fanout') throw new Error('wrong topology')
  expect(result.results[0]!.stopReason).toBe('completed')
  expect(result.results[0]!.text).toContain('PROBE_OK')
  // The mock server saw nothing: the turn really went to Azure.
  expect(h.mock.requests).toHaveLength(0)
}, 120_000)

it.skipIf(!live)(
  'live: worktree subprocess member edits, commits, and merges on Azure gpt-5.5',
  async () => {
    const repo = mkdtempSync(join(tmpdir(), 'openswarm-azure-live-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'base\n')
    git('add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

    h = await bootHarness({ sequence: ['success'], successText: 'unused' }, undefined, azurePlugin())
    const result = await h.swarm.runTeam(
      {
        topology: 'fanout',
        members: [{ name: 'coder' }],
        tasks: [
          {
            member: 'coder',
            prompt:
              'Using the bash tool, create a file named hello.txt in the current directory containing exactly the single line HELLO. Then confirm you are done.',
          },
        ],
      },
      {
        parent: h.lead.agent,
        worktrees: {
          repoRoot: repo,
          member: {
            model: MODEL,
            env: {
              OPENSWARM_LLM_BASE_URL: azureBase(),
              OPENSWARM_LLM_API_KEY: process.env['AZURE_API_KEY']!,
              DSH_MODEL: MODEL,
            },
          },
        },
      },
    )

    if (result.topology !== 'fanout') throw new Error('wrong topology')
    expect(result.results[0]!.stopReason).toBe('completed')
    const gitOutcome = result.git!
    expect(gitOutcome.conflicts).toEqual([])
    expect(gitOutcome.merged).toHaveLength(1)
    const content = execFileSync(
      'git',
      ['show', `${gitOutcome.targetBranch}:hello.txt`],
      { cwd: repo },
    ).toString()
    expect(content.trim()).toBe('HELLO')
    // User checkout untouched.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')
  },
  300_000,
)
