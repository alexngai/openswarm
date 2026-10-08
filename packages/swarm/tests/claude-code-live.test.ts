/**
 * Live claude-code member (docs/05 R1): the user's installed `claude` CLI, on
 * their own Claude login or ANTHROPIC_API_KEY, makes a trivial edit in a
 * temp repo's task worktree and lands it through a train whose check is
 * `test -f`; its usage and the dollars the CLI reported are journaled.
 * Spends a few cents.
 *
 *   OPENSWARM_LIVE=1 npx vitest run packages/swarm/tests/claude-code-live.test.ts
 *
 * `OPENSWARM_LIVE_CLAUDE_MODEL` picks the model (default `haiku`).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SwarmJournal, type SwarmUsageEvent } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

const claude = process.env['OPENSWARM_CLAUDE_BIN'] ?? 'claude'
const live = process.env['OPENSWARM_LIVE'] === '1' && spawnSync(claude, ['--version']).status === 0

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

it.skipIf(!live)('a claude-code member edits its worktree and lands through a train, its usage and cost recorded', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'openswarm-claude-live-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  // No dsh member runs; the mock only backs the lead.
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })

  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      members: [{ name: 'cc', runtime: 'claude-code', agentOptions: { model: process.env['OPENSWARM_LIVE_CLAUDE_MODEL'] ?? 'haiku' } }],
      tasks: [{ subject: 'hello', prompt: 'Create a file named hello.txt in the current directory containing the single word hello. Do nothing else.' }],
    },
    { parent: h.lead.agent, worktrees: { repoRoot: repo, train: { checks: ['test -f hello.txt'] } } },
  )
  const result = await run.result
  expect(result.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  expect(execFileSync('git', ['show', `${result.git!.targetBranch}:hello.txt`], { cwd: repo }).toString()).toMatch(/hello/i)

  const usage = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl'))
    .filter((e) => e.type === 'swarm/usage')
    .map((e) => e.data as SwarmUsageEvent)
  expect(usage).toHaveLength(1)
  expect(usage[0]).toMatchObject({ member: 'cc', role: 'task', taskKey: 'task-0', runtime: 'claude-code', provider: 'anthropic', model: expect.stringMatching(/claude/) })
  expect(usage[0]!.usage.outputTokens).toBeGreaterThan(0)
  expect(usage[0]!.costUsd).toBeGreaterThan(0)

  const m = result.metrics!
  expect(m.tokens!.byRuntime['claude-code']).toBeGreaterThan(0)
  expect(m.dollars).toMatchObject({ source: 'runtime', total: usage[0]!.costUsd })
  expect(h.swarm.landings(run.id)[0]!.cost!.reported!.usd).toBe(usage[0]!.costUsd)
}, 300_000)
