/**
 * The gate must not grade assets the graded party controls.
 *
 * Under worktree execution the command gate runs in the member's OWN worktree,
 * which is a full checkout — tests included. So "make the gate pass" has two
 * solutions: fix the code, or weaken the test. The second is cheaper, and
 * nothing stopped it. This was not hypothetical: during the rung-6 work the
 * gate ran a test file out of the worktree and failed on THAT copy's guard,
 * which is the same mechanism pointed the other way.
 *
 * `confidencePinPaths` restores the verification assets from the base commit
 * before every gate run, so the tier is graded against the tests as written
 * rather than as edited.
 *
 * Both halves are asserted here. Unpinned, the sabotage succeeds and the gate
 * reports a confident 1 on broken code — the vulnerability, pinned in place so
 * it cannot regress silently. Pinned, the same member is caught.
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

/**
 * A repo whose "test" (check.sh) verifies its "source" (value.txt). The gate
 * runs check.sh, so sabotaging check.sh is the cheap way to pass.
 */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-gate-pin-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'value.txt'), 'good\n')
  writeFileSync(join(root, 'check.sh'), 'grep -q good value.txt\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return root
}

function memberEnv(h: TestHarness): Record<string, string> {
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  return { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' }
}

/** One cascade tier that breaks the source AND neuters the check. */
async function bootSaboteur(): Promise<TestHarness> {
  return bootHarness({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'done',
    toolName: 'bash',
    toolArguments: JSON.stringify({
      command: 'echo bad > value.txt; echo "exit 0" > check.sh',
    }),
  })
}

const spec = {
  topology: 'cascade' as const,
  tiers: [{ name: 'only' }],
  task: 'make the check pass',
  confidence: { commands: ['sh check.sh'], tau: 1 },
}

it('UNPINNED: a member passes the gate by neutering the test it is graded by', async () => {
  const repo = scratchRepo()
  h = await bootSaboteur()

  const result = await h.swarm.runTeam(spec, {
    parent: h.lead.agent,
    worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
  })

  if (result.topology !== 'cascade') throw new Error('wrong topology')
  // The gate is satisfied — by a check.sh that no longer checks anything.
  expect(result.attempts[0]!.confidence).toBe(1)
  expect(result.accepted).toBe(true)
  // And the broken source rode in on that verdict.
  const merged = execFileSync('git', ['show', `${result.git!.targetBranch}:value.txt`], {
    cwd: repo,
  }).toString()
  expect(merged.trim()).toBe('bad')
}, 120_000)

it('PINNED: the same sabotage is caught, because the check is restored first', async () => {
  const repo = scratchRepo()
  h = await bootSaboteur()

  const progress: string[] = []
  const result = await h.swarm.runTeam(spec, {
    parent: h.lead.agent,
    onProgress: (line) => progress.push(line),
    confidencePinPaths: ['check.sh'],
    worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
  })

  if (result.topology !== 'cascade') throw new Error('wrong topology')
  // Graded against the real check, the broken source fails.
  expect(result.attempts[0]!.confidence).toBe(0)
  expect(result.accepted).toBe(false)
  // And the revert was announced rather than done behind the member's back.
  expect(progress.some((l) => l.includes('discarded member edits'))).toBe(true)
}, 120_000)

/**
 * `suite/` does not exist at base, so `checkout` cannot restore it — only the
 * clean pass removes it. That makes this the test that isolates clean.
 *
 * It must assert the PASSING direction. An earlier version had the member also
 * sabotage value.txt and asserted `confidence === 0`, which is true whether or
 * not clean runs (leftover file fails one command; sabotaged value fails the
 * other). It therefore passed with the clean pass deleted — mutation A7 in
 * docs/04 survived against it. Asserting 1 makes the leftover file the only
 * thing that can fail the gate.
 */
/**
 * Every earlier test here used LITERAL paths, so none of them could catch the
 * defect that mattered: `packages/*[/]tests` matches nothing, because git
 * matches wildcards against WHOLE paths — "a/*[/]b" does not match
 * "a/x/b/c.ts". The pin was therefore inert through a whole live matrix while
 * looking configured, since a pathspec absent from base was treated as the
 * legitimate "nothing may appear here" case.
 */
it('a pathspec that pins NOTHING fails loud instead of silently protecting nothing', async () => {
  const repo = scratchRepo()
  const { SwarmGit } = await import('openswarm-git')
  const swarm = new SwarmGit({ repoRoot: repo, teamId: 'inert' })
  const wt = await swarm.worktree('task')

  await expect(swarm.restoreFromBase(wt, ['nope/*/missing'])).rejects.toThrow(/pins nothing/)

  // A literal directory that DOES exist still works.
  writeFileSync(join(wt.path, 'check.sh'), 'exit 0\n')
  expect(await swarm.restoreFromBase(wt, ['check.sh'])).toContain('check.sh')
  await swarm.removeAll()
  await swarm.dispose()
}, 60_000)

it('pinning also removes files the member ADDED under a pinned path', async () => {
  const repo = scratchRepo()
  const bootAdder = () =>
    bootHarness({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      successText: 'done',
      toolName: 'bash',
      // Note: value.txt is left ALONE, so `sh check.sh` passes on its own and
      // the only way the gate can fail is a surviving suite/extra.sh.
      toolArguments: JSON.stringify({
        command: 'mkdir -p suite && echo "exit 0" > suite/extra.sh',
      }),
    })
  const gate = {
    ...spec,
    confidence: { commands: ['test ! -e suite/extra.sh', 'sh check.sh'], tau: 1 },
  }

  h = await bootAdder()
  const pinned = await h.swarm.runTeam(gate, {
    parent: h.lead.agent,
    confidencePinPaths: ['check.sh', 'suite'],
    worktrees: { repoRoot: repo, member: { env: memberEnv(h) } },
  })
  if (pinned.topology !== 'cascade') throw new Error('wrong topology')
  // The added file is gone, so the gate passes.
  expect(pinned.attempts[0]!.confidence).toBe(1)

  // Control: without pinning the same file survives and the gate fails, so the
  // assertion above is attributable to clean rather than to anything else.
  await h.close()
  h = await bootAdder()
  const unpinned = await h.swarm.runTeam(gate, {
    parent: h.lead.agent,
    worktrees: { repoRoot: scratchRepo(), member: { env: memberEnv(h) } },
  })
  if (unpinned.topology !== 'cascade') throw new Error('wrong topology')
  expect(unpinned.attempts[0]!.confidence).toBe(0)
}, 180_000)
