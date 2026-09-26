/**
 * Rung 5 — the self-modification gate: a cascade whose tiers edit a git
 * worktree and whose command-confidence gate GRADES THAT WORKTREE.
 *
 * This is the combination nothing covered before, and it was broken: the
 * confidence runner was built from `confidenceCwd ?? process.cwd()` at dispatch
 * time, so under worktree execution it graded the repo root — a tree no tier
 * ever touched. Because that tree is the caller's own (normally passing)
 * checkout, the gate returned 1 regardless of the work, and a cascade could
 * "pass" having changed nothing. Here the polarity is inverted (the gate can
 * only pass in a worktree), so the bug shows up as a cascade that never
 * accepts.
 *
 * The scripted command is deliberately self-differentiating: every tier runs
 * the SAME bash, and it does something different on the second run. That gives
 * two assertions for one script — the gate reads the tier's edits, and all
 * tiers share one worktree (tier 2 can see tier 1's marker).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { bootHarness, type TestHarness } from './boot'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-cascade-wt-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

function memberEnv(h: TestHarness): Record<string, string> {
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  return {
    OPENSWARM_LLM_BASE_URL: base,
    OPENSWARM_LLM_API_KEY: 'mock-key',
    DSH_MODEL: 'mock-model',
  }
}

it('an unaccepted cascade withholds the merge but keeps the work on its branch', async () => {
  const repo = scratchRepo()
  h = await bootHarness({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'tier done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo attempted > work.txt' }),
  })

  const result = await h.swarm.runTeam(
    {
      topology: 'cascade',
      tiers: [{ name: 'only' }],
      task: 'do the thing',
      // Never satisfiable, so the run ends unaccepted.
      confidence: { commands: ['test -f never-exists'], tau: 1 },
    },
    { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { env: memberEnv(h) } } },
  )

  if (result.topology !== 'cascade') throw new Error('wrong topology')
  expect(result.accepted).toBe(false)

  // Nothing reached the integration branch: previously `finalize` ran
  // unconditionally and merged regardless of the verdict, which made the gate
  // decide nothing about what landed.
  const git = result.git!
  expect(git.merged).toEqual([])
  expect(git.withheld).toHaveLength(1)

  // The work is not lost — it is reachable by branch name.
  const kept = execFileSync('git', ['show', `${git.withheld[0]!.branch}:work.txt`], {
    cwd: repo,
  }).toString()
  expect(kept.trim()).toBe('attempted')
}, 120_000)

it('a rejected tier records which command failed, and tells the next tier', async () => {
  const repo = scratchRepo()
  h = await bootHarness({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'tier done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo hi > out.txt' }),
  })

  const result = await h.swarm.runTeam(
    {
      topology: 'cascade',
      tiers: [{ name: 'cheap' }, { name: 'strong' }],
      task: 'do the thing',
      confidence: { commands: ['echo DIAGNOSTIC_MARKER >&2; exit 3'], tau: 1 },
    },
    { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { env: memberEnv(h) } } },
  )

  if (result.topology !== 'cascade') throw new Error('wrong topology')
  // The attempt is attributable: which command, and what it printed. Without
  // this a rejection cannot be told apart from an environment problem.
  expect(result.attempts[0]!.failure?.command).toContain('DIAGNOSTIC_MARKER')
  expect(result.attempts[0]!.failure?.output).toContain('DIAGNOSTIC_MARKER')

  // And it actually reached the model: the second tier's prompt carries the
  // failure, which is the whole point of escalation feedback.
  const sent = JSON.stringify(h.mock.requests)
  expect(sent).toContain('DIAGNOSTIC_MARKER')
}, 120_000)

it('cascade: the command gate grades the tier worktree, and the passing tier merges', async () => {
  const repo = scratchRepo()
  h = await bootHarness({
    // Two tiers, each one member turn: a bash call then a closing message.
    // Tiers run sequentially inside runCascade, so the shared mock's FIFO
    // script stays deterministic.
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'tier done',
    toolName: 'bash',
    // First run leaves only a marker (gate must fail); second run sees the
    // marker and writes the file the gate wants (gate must pass).
    toolArguments: JSON.stringify({
      command: 'if [ -f attempt1 ]; then echo ok > fixed.txt; else touch attempt1; fi',
    }),
  })

  const result = await h.swarm.runTeam(
    {
      topology: 'cascade',
      tiers: [{ name: 'cheap' }, { name: 'strong' }],
      task: 'make the verification command pass',
      // Only ever true inside a worktree a tier has edited. In the repo root
      // this file does not exist, so a gate pointed there can never pass.
      confidence: { commands: ['test -f fixed.txt'], tau: 1 },
    },
    {
      parent: h.lead.agent,
      worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
    },
  )

  if (result.topology !== 'cascade') throw new Error('wrong topology')

  // The gate saw the real tree: tier 1 scored 0, tier 2 scored 1.
  expect(result.attempts.map((a) => a.confidence)).toEqual([0, 1])
  expect(result.accepted).toBe(true)
  expect(result.tier).toBe(1)

  // Tier 2 saw tier 1's marker, so both tiers shared one worktree.
  const targetBranch = result.git!.targetBranch
  const show = (file: string) =>
    execFileSync('git', ['show', `${targetBranch}:${file}`], { cwd: repo }).toString()
  expect(show('attempt1')).toBe('')
  expect(show('fixed.txt').trim()).toBe('ok')

  // Merged, and the caller's checkout was never touched.
  expect(result.git!.conflicts).toEqual([])
  expect(result.git!.merged).toHaveLength(1)
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')
}, 120_000)
