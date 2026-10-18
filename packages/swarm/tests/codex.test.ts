/**
 * The codex member runtime (docs/05 R2), keyless: a fake `codex`
 * (support/fake-codex.mjs) streams what `codex exec --json` does. A codex
 * member lands its task through the train with its usage journaled (cached
 * input split out, no dollars); the CLI gets the pinned sandbox, the member's
 * cwd and model, and the prompt on stdin; a cancel interrupts it (SIGINT,
 * which Codex handles; SIGTERM it does not) and kills the descendants it
 * started; a failed turn, a crash and a missing CLI are errors with a
 * diagnostic; and what a basic member cannot do is refused before any spend.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { SwarmJournal, codexEnv, runCodex, runUsd, type SwarmUsageEvent } from '../src/index'
import { bootHarness, type TestHarness } from './boot'

const FAKE = fileURLToPath(new URL('./support/fake-codex.mjs', import.meta.url))

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
  delete process.env['FAKE_CODEX_LOG']
})
// Every codex a test starts is the fake, the real CLI never: in place a member
// takes OPENSWARM_CODEX_BIN, as a run without worktrees.member.codexCommand does.
const savedBin = process.env['OPENSWARM_CODEX_BIN']
beforeAll(() => {
  chmodSync(FAKE, 0o755)
  process.env['OPENSWARM_CODEX_BIN'] = FAKE
})
afterAll(() => {
  if (savedBin === undefined) delete process.env['OPENSWARM_CODEX_BIN']
  else process.env['OPENSWARM_CODEX_BIN'] = savedBin
})

function fakeLog(): () => any[] {
  const file = join(mkdtempSync(join(tmpdir(), 'openswarm-fake-codex-')), 'log.jsonl')
  process.env['FAKE_CODEX_LOG'] = file
  return () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(test: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !test(); ) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

it('a codex member lands its task through the train, its usage journaled with the cached input split out and no dollars', async () => {
  const log = fakeLog()
  const root = mkdtempSync(join(tmpdir(), 'openswarm-codex-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const run = await h.swarm.start(
    { topology: 'peer-team', members: [{ name: 'cx', runtime: 'codex', agentOptions: { model: 'gpt-5.5-codex' } }], tasks: [{ subject: 'write it', prompt: 'write codex-out.txt' }], gate: { rounds: 1, checks: ['test -f codex-out.txt'] } },
    { parent: h.lead.agent, worktrees: { repoRoot: root, member: { codexCommand: FAKE }, train: { checks: ['git status --porcelain >/dev/null'] } } },
  )
  const result = await run.result
  expect(result.git!.landed!.map((l) => l.taskKey)).toEqual(['task-0'])
  expect(git('show', `${result.git!.targetBranch}:codex-out.txt`)).toBe('done\n')
  const usage = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl'))
    .filter((e) => e.type === 'swarm/usage')
    .map((e) => e.data as SwarmUsageEvent)
  expect(usage).toEqual([
    expect.objectContaining({ member: 'cx', taskKey: 'task-0', runtime: 'codex', provider: 'openai', model: 'gpt-5.5-codex', usage: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 0, calls: 1 } }),
  ])
  expect(usage[0]!.costUsd).toBeUndefined()
  expect(usage[0]!.runId).toMatch(/^fake-thread-\d+$/)
  // The preflight, then the one run; nothing reached the dsh mock.
  expect(log().map((e) => e.event)).toEqual(['version', 'start'])
  expect(h.mock.requests).toHaveLength(0)
}, 60_000)

it('the CLI gets exec --json, the pinned sandbox, the cwd and model, the prompt on stdin, and the last agent message is the answer', async () => {
  const log = fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-codex-run-'))
  const result = await runCodex({ name: 'cx', persona: 'You are terse.', agentOptions: { model: 'o4-mini' } }, '--not-a-flag: write it', { cwd, command: FAKE })
  expect(result.stopReason).toBe('completed')
  expect(result.text).toBe('wrote codex-out.txt')
  const start = log().find((e) => e.event === 'start')
  expect(start.argv).toEqual(['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--color', 'never', '-s', 'workspace-write', '-C', cwd, '-m', 'o4-mini'])
  expect(start.prompt).toBe('You are terse.\n\n--not-a-flag: write it')
  // A member's own sandbox wins over the run's.
  await runCodex({ name: 'cx', codexSandbox: 'read-only' }, 'again', { cwd, command: FAKE, sandbox: 'danger-full-access' })
  expect(log().filter((e) => e.event === 'start')[1].argv).toContain('read-only')
})

it('a cancel interrupts the CLI with SIGINT and kills the descendants it started in sessions of their own; aborted, its spend journaled as unmeasured', async () => {
  const log = fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-codex-cancel-'))
  const recorded: any[] = []
  const controller = new AbortController()
  const settled = runCodex({ name: 'cx' }, 'FAKE_HANG', { cwd, command: FAKE, signal: controller.signal, usage: async (u) => void recorded.push(u) })
  await until(() => log().some((e) => e.event === 'grandchild'))
  const { pid } = log().find((e) => e.event === 'start')
  const { pid: grandchild, detached } = log().find((e) => e.event === 'grandchild')
  controller.abort()
  const result = await settled
  expect(result.stopReason).toBe('aborted')
  expect(log().some((e) => e.event === 'sigint')).toBe(true)
  await until(() => !alive(pid) && !alive(grandchild) && !alive(detached))
  // Codex reports usage only when a turn completes: what this one spent is unknown, not zero.
  expect(recorded).toEqual([expect.objectContaining({ runtime: 'codex', unmeasured: true, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 } })])
  expect(runUsd(recorded[0], { 'gpt-5.5': { input: 1, output: 1 } })).toBeUndefined()
}, 30_000)

it('a non-fatal error event does not fail a turn that completes; a failed turn, a crash and a missing CLI settle as errors with a diagnostic', async () => {
  fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-codex-error-'))
  const warned = await runCodex({ name: 'cx' }, 'FAKE_WARN', { cwd, command: FAKE })
  expect([warned.stopReason, warned.text]).toEqual(['completed', 'wrote codex-out.txt'])
  const failed = await runCodex({ name: 'cx' }, 'FAKE_FAIL', { cwd, command: FAKE })
  expect(failed.stopReason).toBe('error')
  expect(failed.text).toContain('codex failed: unexpected status 401 Unauthorized')
  const crashed = await runCodex({ name: 'cx' }, 'FAKE_CRASH', { cwd, command: FAKE })
  expect(crashed.stopReason).toBe('error')
  expect(crashed.text).toContain('codex exited (code 2) before its turn ended')
  expect(crashed.text).toContain('codex: panicked')
  const missing = await runCodex({ name: 'cx' }, 'hello', { cwd, command: join(cwd, 'no-such-codex') })
  expect(missing.text).toMatch(/could not run ".*no-such-codex" \(.*ENOENT.*\); set worktrees\.member\.codexCommand or OPENSWARM_CODEX_BIN/)
})

it("the env keeps Codex's own (CODEX_HOME, CODEX_API_KEY) and drops the launcher's credentials and routes", () => {
  const env = codexEnv({ HOME: '/h', PATH: '/bin', CODEX_HOME: '/c', CODEX_API_KEY: 'k', OPENAI_API_KEY: 'sk', OPENSWARM_LLM_API_KEY: 'o', GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a' })
  expect(env).toEqual({ HOME: '/h', PATH: '/bin', CODEX_HOME: '/c', CODEX_API_KEY: 'k' })
})

it('a codex member is refused before any spend in a messaging peer-team and at L3; a missing CLI fails its preflight', async () => {
  const log = fakeLog()
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const tasks = [{ subject: 's', prompt: 'p' }]
  await expect(
    h.swarm.runTeam({ topology: 'peer-team', messaging: true, members: [{ name: 'a' }, { name: 'cx', runtime: 'codex' }], tasks }, { parent: h.lead.agent }),
  ).rejects.toThrow('member "cx" runs on codex, a basic member (one-shot runs): a messaging peer-team needs steerable members')
  await expect(
    h.swarm.runTeam({ topology: 'peer-team', members: [{ name: 'cx', runtime: 'codex' }], tasks, gate: { suite: 'hidden' } }, { parent: h.lead.agent, confidenceCwd: tmpdir() }),
  ).rejects.toThrow('member "cx" runs on codex, and this run verifies at L3 with a hidden suite: the tamper scan cannot read Codex transcripts')
  expect(log()).toEqual([])
  // A missing CLI fails its preflight before any member runs.
  const missing = join(mkdtempSync(join(tmpdir(), 'openswarm-codex-pre-')), 'no-such-codex')
  const repo = mkdtempSync(join(tmpdir(), 'openswarm-codex-pre-repo-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })
  await expect(
    h.swarm.runTeam({ topology: 'fanout', members: [{ name: 'cx', runtime: 'codex' }], tasks: [{ member: 'cx', prompt: 'p' }] }, { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { codexCommand: missing } } }),
  ).rejects.toThrow(`codex members need the codex CLI, and "${missing} --version" failed`)
  expect(existsSync(join(repo, '.swarm'))).toBe(false)
})
