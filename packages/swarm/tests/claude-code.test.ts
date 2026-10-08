/**
 * The claude-code member runtime (docs/05 R1), keyless: a fake `claude`
 * (support/fake-claude.mjs) streams what the CLI's headless mode does. Exit
 * criterion 3: a dsh member (a real subprocess harness on the mock LLM) and a
 * claude-code member run a peer-team over worktrees and land both tasks
 * through one train, the claude-code member repairing its own culprit, with
 * tokens and dollars attributed per runtime and each landing bundle carrying
 * its task's cost. Then cancellation, error results, in-place runs, and
 * what is refused before any spend: a messaging team, an L3 run (its tamper
 * scan cannot read Claude Code transcripts), and a CLI failing its preflight.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, expect, it } from 'vitest'
import {
  SwarmJournal,
  buildEvidence,
  claudeEnv,
  emptyUsage,
  foldMetrics,
  landingText,
  runClaudeCode,
  runMetrics,
  tokensOf,
  trainJournalPath,
  type SwarmUsageEvent,
} from '../src/index'
import { bootHarness, type TestHarness } from './boot'

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url))
/** The fake's per-run usage and dollars. */
const RUN_TOKENS = 12 + 34 + 500 + 200
const RUN_USD = 0.0421

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
  delete process.env['FAKE_CLAUDE_LOG']
})
// A checkout may drop the exec bit.
beforeAll(() => chmodSync(FAKE, 0o755))

/** A fresh log the fake appends to, as `{ event, … }` lines. */
function fakeLog(): () => any[] {
  const file = join(mkdtempSync(join(tmpdir(), 'openswarm-fake-claude-')), 'log.jsonl')
  process.env['FAKE_CLAUDE_LOG'] = file
  return () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])
}

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-claude-code-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  return root
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

it('a mixed roster of a dsh member and a claude-code member lands both tasks through one train, cost attributed per runtime (docs/05 exit criterion 3)', async () => {
  const repo = scratchRepo()
  const log = fakeLog()
  h = await bootHarness({
    // The dsh member's one task: a bash call writing a file named by its branch, then done.
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"' }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      intent: { purpose: 'ship both parts', endState: 'both files exist on the target' },
      members: [
        { name: 'dsh-dev' },
        { name: 'cc-dev', runtime: 'claude-code', persona: 'You are the Claude Code member.' },
      ],
      tasks: [
        { subject: 'first part', prompt: 'write your part' },
        { subject: 'second part', prompt: 'write your part' },
      ],
    },
    {
      parent: h.lead.agent,
      worktrees: {
        repoRoot: repo,
        member: { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' }, claudeCommand: FAKE, claudeSettingSources: ['project', 'local'] },
        // The fake's first edit fails this; its repair, a fresh run in the same worktree, passes it.
        train: { checks: ['! grep -qs broken claude-out.txt'] },
      },
    },
  )
  const result = await run.result
  const events = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl'))
  const usage = events.filter((e) => e.type === 'swarm/usage').map((e) => e.data as SwarmUsageEvent)
  const claude = usage.filter((u) => u.runtime === 'claude-code')
  const dsh = usage.filter((u) => u.runtime === 'dsh:sdk')
  const ccKey = claude[0]!.taskKey!
  const dshKey = dsh[0]!.taskKey!
  expect(new Set([ccKey, dshKey])).toEqual(new Set(['task-0', 'task-1']))

  // Both landed through the train; the claude-code task after its own member repaired it.
  const git = result.git!
  expect(git.landed!.map((l) => l.taskKey).sort()).toEqual(['task-0', 'task-1'])
  expect(git.ejected).toEqual([])
  const show = (file: string) => execFileSync('git', ['show', `${git.targetBranch}:${file}`], { cwd: repo }).toString()
  expect(show('claude-out.txt')).toBe('fixed\n')
  const train = SwarmJournal.read(trainJournalPath(h.runsDir, run.id))
  expect(train.filter((e) => e.type === 'train/repair').map((e) => [(e.data as any).key, (e.data as any).member])).toEqual([[ccKey, 'cc-dev']])
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString()).toBe('')

  // Preflighted once, then the CLI ran headless in the task's worktree, never the checkout, with the dsh member's prompt and none of OpenSwarm's secrets.
  expect(log()[0].event).toBe('version')
  expect(log().filter((e) => e.event === 'version')).toHaveLength(1)
  const starts = log().filter((e) => e.event === 'start')
  expect(starts).toHaveLength(2)
  const [first, repair] = starts
  // The fake reports its cwd resolved; the worktree is gone once the train lands it.
  expect(first.cwd.startsWith(join(realpathSync(repo), '.swarm', 'worktrees'))).toBe(true)
  expect(repair.cwd).toBe(first.cwd)
  expect(first.argv).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--permission-mode', 'acceptEdits', '--setting-sources', 'project,local'])
  expect(first.prompt).toMatch(/^You are the Claude Code member\.\n\n/)
  expect(first.prompt).toContain('ship both parts')
  expect(first.prompt).toContain('write your part')
  expect(first.secrets.filter((name: string) => !/^(ANTHROPIC_|CLAUDE_)/.test(name))).toEqual([])

  // Usage per run: the CLI's model, tokens and dollars for claude-code; session logs for dsh.
  expect(claude.map((u) => [u.member, u.role, u.taskKey, u.provider, u.model, tokensOf(u.usage), u.usage.calls, u.costUsd])).toEqual([
    ['cc-dev', 'task', ccKey, 'anthropic', 'claude-fake-1', RUN_TOKENS, 2, RUN_USD],
    ['cc-dev', 'repair', ccKey, 'anthropic', 'claude-fake-1', RUN_TOKENS, 2, RUN_USD],
  ])
  expect(dsh.map((u) => [u.member, u.role, u.costUsd])).toEqual([['dsh-dev', 'task', undefined]])
  const dshTokens = tokensOf(dsh[0]!.usage)
  expect(dshTokens).toBeGreaterThan(0)

  // Unpriced, claude-code's own dollars stand as a lower bound, the dsh run counted as neither reported nor priced.
  const m = result.metrics!
  expect(m.tokens!.byRuntime).toEqual({ 'dsh:sdk': dshTokens, 'claude-code': 2 * RUN_TOKENS })
  expect(m.dollars).toEqual({ total: 2 * RUN_USD, byModel: { 'claude-fake-1': 2 * RUN_USD, 'deepseek-v4-flash': 0 }, byRuntime: { 'claude-code': 2 * RUN_USD, 'dsh:sdk': 0 }, source: 'runtime', unreported: 1 })
  expect(m.landed).toBe(2)
  // Priced, dollars by runtime: claude-code's as it reported them, dsh's from the table.
  const pricing = { 'deepseek-v4-flash': { input: 1, output: 2 } }
  const priced = runMetrics(join(h.runsDir, run.id), { pricing })
  const dshUsd = (dsh[0]!.usage.inputTokens + dsh[0]!.usage.cacheReadTokens + dsh[0]!.usage.cacheWriteTokens + 2 * dsh[0]!.usage.outputTokens) / 1e6
  expect(priced.dollars).toMatchObject({ source: 'mixed', byRuntime: { 'claude-code': expect.closeTo(2 * RUN_USD, 10), 'dsh:sdk': expect.closeTo(dshUsd, 10) } })
  expect(priced.dollars!.total).toBeCloseTo(2 * RUN_USD + dshUsd, 10)
  expect(priced.dollars!.unreported).toBeUndefined()
  expect(priced.costPerLanding!.dollars).toBeCloseTo((2 * RUN_USD + dshUsd) / 2, 10)
  expect(foldMetrics(events, train, { pricing })).toEqual(priced)

  // Each landing bundle carries its own task's cost; the claude-code one in the dollars its runtime reported.
  const landings = new Map(h.swarm.landings(run.id).map((l) => [l.key, l]))
  expect(landings.get(ccKey)!.cost).toMatchObject({ tokens: 2 * RUN_TOKENS, byRole: { task: RUN_TOKENS, repair: RUN_TOKENS }, reported: { usd: expect.closeTo(2 * RUN_USD, 10), rest: [] } })
  expect(landingText(landings.get(ccKey)!).join('\n')).toContain(`cost: ${(2 * RUN_TOKENS).toLocaleString('en-US')} tokens (task ${RUN_TOKENS}, repair ${RUN_TOKENS}), $0.08`)
  expect(landings.get(dshKey)!.cost).toMatchObject({ tokens: dshTokens, byRole: { task: dshTokens } })
  expect(landings.get(dshKey)!.cost!.reported).toBeUndefined()
  expect(landingText(landings.get(dshKey)!, pricing).join('\n')).toContain(`, $${dshUsd.toFixed(2)}`)
}, 120_000)

it('cancelling a claude-code run kills the CLI, its process group and the descendants it started in sessions of their own, and reports aborted with the usage it streamed', async () => {
  const log = fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-claude-cancel-'))
  const recorded: any[] = []
  const controller = new AbortController()
  const settled = runClaudeCode({ name: 'cc' }, 'FAKE_HANG', { cwd, command: FAKE, signal: controller.signal, usage: async (u) => void recorded.push(u), taskKey: 'task-0' })
  await until(() => log().some((e) => e.event === 'grandchild'))
  const { pid } = log().find((e) => e.event === 'start')
  const { pid: grandchild, detached } = log().find((e) => e.event === 'grandchild')
  controller.abort()
  const result = await settled
  expect(result.stopReason).toBe('aborted')
  expect(log().some((e) => e.event === 'sigterm')).toBe(true)
  // One sleep was in its process group; the other, in a session of its own as Claude Code's Bash tool is, was found by parent link.
  await until(() => !alive(pid) && !alive(grandchild) && !alive(detached))
  expect(recorded).toEqual([
    expect.objectContaining({ member: 'cc', taskKey: 'task-0', runtime: 'claude-code', model: 'claude-fake-1', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } }),
  ])
  expect(recorded[0].costUsd).toBeUndefined()
}, 30_000)

it('an error result, or a CLI that cannot start, settles as error with a diagnostic', async () => {
  fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-claude-error-'))
  const recorded: any[] = []
  const failed = await runClaudeCode({ name: 'cc', agentOptions: { model: 'sonnet' } }, 'FAKE_FAIL', { cwd, command: FAKE, usage: async (u) => void recorded.push(u) })
  expect(failed.stopReason).toBe('error')
  expect(failed.text).toContain('claude-code failed (error_during_execution, is_error)')
  expect(failed.text).toContain('API Error: 529 overloaded')
  expect(failed.text).toContain('the model endpoint refused')
  // `--model` follows agentOptions.model; the failed run's dollars still count.
  expect(recorded).toEqual([expect.objectContaining({ model: 'sonnet', costUsd: 0.001 })])

  const missing = await runClaudeCode({ name: 'cc' }, 'hello', { cwd, command: join(cwd, 'no-such-claude') })
  expect(missing.stopReason).toBe('error')
  expect(missing.text).toMatch(/could not run ".*no-such-claude" \(.*ENOENT.*\); set worktrees\.member\.claudeCommand or OPENSWARM_CLAUDE_BIN/)
})

it('without worktrees a claude-code member works in its parent agent\'s cwd, as an in-process dsh member does, without the launcher\'s secrets; a run priced only by its runtime has dollars without a table', async () => {
  const log = fakeLog()
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const cwd = h.lead.agent.session.header.cwd!
  const secrets = { OPENSWARM_CLAUDE_BIN: FAKE, OPENAI_API_KEY: 'sk-test', AZURE_API_KEY: 'az-test', AWS_BEARER_TOKEN_BEDROCK: 'bt-test', ANTHROPIC_API_KEY: 'ant-test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' }
  const saved = Object.fromEntries(Object.keys(secrets).map((name) => [name, process.env[name]]))
  Object.assign(process.env, secrets)
  try {
    const result = await h.swarm.runTeam(
      { topology: 'fanout', members: [{ name: 'cc', runtime: 'claude-code', permissionMode: 'bypassPermissions' }], tasks: [{ member: 'cc', prompt: 'write it' }] },
      // confidenceCwd places checks, not members: an in-process dsh child inherits its parent's cwd.
      { parent: h.lead.agent, confidenceCwd: mkdtempSync(join(tmpdir(), 'openswarm-claude-checks-')) },
    )
    if (result.topology !== 'fanout') throw new Error('wrong topology')
    expect(result.results.map((r) => [r.stopReason, r.text])).toEqual([['completed', 'wrote claude-out.txt']])
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  expect(readFileSync(join(cwd, 'claude-out.txt'), 'utf8')).toBe('broken\n')
  expect(log().map((e) => e.event)).toEqual(['version', 'start'])
  const start = log()[1]
  expect(realpathSync(start.cwd)).toBe(realpathSync(cwd))
  expect(start.argv).toContain('bypassPermissions')
  expect(start.argv).not.toContain('--setting-sources')
  // Claude Code's own auth survives; the launcher's provider keys do not.
  expect(start.secrets).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']))
  expect(start.secrets.filter((name: string) => !/^(ANTHROPIC_|CLAUDE_)/.test(name))).toEqual([])
  expect(h.mock.requests).toHaveLength(0)
  const [id] = h.swarm.runs().map((r) => r.id)
  const m = h.swarm.metrics(id!)
  expect(m.dollars).toEqual({ total: RUN_USD, byModel: { 'claude-fake-1': RUN_USD }, byRuntime: { 'claude-code': RUN_USD }, source: 'runtime' })
})

it('a claude-code member is refused before any spend in a messaging peer-team, and an unknown runtime anywhere', async () => {
  const log = fakeLog()
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const tasks = [{ subject: 's', prompt: 'p' }]
  await expect(
    h.swarm.runTeam({ topology: 'peer-team', messaging: true, members: [{ name: 'a' }, { name: 'cc', runtime: 'claude-code' }], tasks }, { parent: h.lead.agent }),
  ).rejects.toThrow('member "cc" runs on claude-code, a basic member (one-shot runs): a messaging peer-team needs steerable members')
  await expect(
    h.swarm.runTeam({ topology: 'committee', members: [{ name: 'a' }], judge: { name: 'j', runtime: 'codex' as any }, task: 't' }, { parent: h.lead.agent }),
  ).rejects.toThrow('member "j" names runtime "codex"; the runtimes are dsh and claude-code')
  expect(h.mock.requests).toHaveLength(0)
  expect(log()).toEqual([])
})

it('an L3 run with a claude-code member is refused before any spend: the tamper scan cannot read Claude Code transcripts', async () => {
  const log = fakeLog()
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const members = [{ name: 'a' }, { name: 'cc', runtime: 'claude-code' as const }]
  const tasks = [{ subject: 's', prompt: 'p' }]
  const refused = 'member "cc" runs on claude-code, and this run verifies at L3 with a hidden suite: the tamper scan cannot read Claude Code transcripts'
  // A gated task whose suite comes from the team's gate…
  await expect(h.swarm.runTeam({ topology: 'peer-team', members, tasks, gate: { suite: 'hidden' } }, { parent: h.lead.agent, confidenceCwd: tmpdir() })).rejects.toThrow(refused)
  // …or its own, beside checks…
  await expect(
    h.swarm.runTeam({ topology: 'peer-team', members, tasks: [{ ...tasks[0]!, suite: 'hidden' }], gate: { checks: ['true'] } }, { parent: h.lead.agent, confidenceCwd: tmpdir() }),
  ).rejects.toThrow(refused)
  // …and a train verifying at L3, whose repairs and resolvers the members would run.
  const repo = scratchRepo()
  await expect(
    h.swarm.runTeam({ topology: 'peer-team', members, tasks }, { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { claudeCommand: FAKE }, train: { suite: 'hidden' } } }),
  ).rejects.toThrow(refused)
  // Refused before the preflight, so nothing ran.
  expect(h.mock.requests).toHaveLength(0)
  expect(log()).toEqual([])
})

it('a claude CLI that fails its preflight stops the run up front, before any member runs', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'unused' })
  const repo = scratchRepo()
  const missing = join(repo, 'no-such-claude')
  await expect(
    h.swarm.runTeam(
      { topology: 'fanout', members: [{ name: 'a' }, { name: 'cc', runtime: 'claude-code' }], tasks: [{ member: 'a', prompt: 'p' }, { member: 'cc', prompt: 'p' }] },
      { parent: h.lead.agent, worktrees: { repoRoot: repo, member: { claudeCommand: missing } } },
    ),
  ).rejects.toThrow(`claude-code members need the claude CLI, and "${missing} --version" failed`)
  // The dsh member never spent a call, and no worktree was cut.
  expect(h.mock.requests).toHaveLength(0)
  expect(existsSync(join(repo, '.swarm'))).toBe(false)
})

it('the env keeps what Claude Code reads and drops the launcher\'s credentials, as dsh\'s spawner does; AWS only for Bedrock', () => {
  const env = { PATH: '/bin', HOME: '/h', AWS_REGION: 'us-east-1', AWS_BEARER_TOKEN_BEDROCK: 'bt', AWS_SECRET_ACCESS_KEY: 'sk', OPENAI_API_KEY: 'o', OPENAI_BASE_URL: 'u', AZURE_API_BASE: 'a', AZURE_API_KEY: 'k', GITHUB_TOKEN: 'g', DSH_MODEL: 'm', OPENSWARM_LLM_API_KEY: 'l', DEEPSEEK_BASE_URL: 'd', ANTHROPIC_API_KEY: 'ant', ANTHROPIC_BASE_URL: 'b', CLAUDE_CODE_OAUTH_TOKEN: 't' }
  expect(Object.keys(claudeEnv(env)).sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AWS_REGION', 'CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH'])
  expect(Object.keys(claudeEnv({ ...env, CLAUDE_CODE_USE_BEDROCK: '1' })).sort()).toEqual([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'HOME', 'PATH',
  ])
})

it('a pre-aborted signal settles aborted without starting the CLI', async () => {
  const log = fakeLog()
  const recorded: any[] = []
  const result = await runClaudeCode({ name: 'cc' }, 'hello', { cwd: tmpdir(), command: FAKE, signal: AbortSignal.abort(), usage: async (u) => void recorded.push(u) })
  expect(result).toEqual({ member: 'cc', runId: '', text: '', output: [], stopReason: 'aborted' })
  expect(log()).toEqual([])
  expect(recorded).toEqual([])
})

it('the stream: error_max_turns is max-turns, malformed lines are skipped, and a CLI that exits without a result is an error carrying its stderr', async () => {
  fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-claude-stream-'))
  const recorded: any[] = []
  const usage = async (u: any) => void recorded.push(u)
  const run = (prompt: string) => runClaudeCode({ name: 'cc' }, prompt, { cwd, command: FAKE, usage })

  expect(await run('FAKE_MAX_TURNS')).toMatchObject({ stopReason: 'max-turns', text: 'claude-code stopped at its turn limit after 3 turn(s)' })
  // A result line without its newline is still read.
  expect(await run('FAKE_GARBAGE')).toMatchObject({ stopReason: 'completed', text: 'survived' })
  const crashed = await run('FAKE_CRASH')
  expect(crashed.stopReason).toBe('error')
  expect(crashed.text).toBe('claude-code exited (code 2) without a result: fake: segfault')
  // A crashed run journals what it streamed, and reported no dollars.
  expect(recorded.map((u) => [tokensOf(u.usage), u.costUsd])).toEqual([
    [RUN_TOKENS, 0.01],
    [RUN_TOKENS, RUN_USD],
    [10, undefined],
  ])
})

it('a run is bounded: a CLI that lingers after its result is stopped and the result stands; past timeoutMs one is stopped as an error', async () => {
  const log = fakeLog()
  const cwd = mkdtempSync(join(tmpdir(), 'openswarm-claude-bound-'))
  const lingered = await runClaudeCode({ name: 'cc' }, 'FAKE_LINGER', { cwd, command: FAKE, exitGraceMs: 200 })
  expect(lingered).toMatchObject({ stopReason: 'completed', text: 'done, lingering' })
  const timed = await runClaudeCode({ name: 'cc', claudeTimeoutMs: 300 }, 'FAKE_HANG', { cwd, command: FAKE })
  expect(timed.stopReason).toBe('error')
  expect(timed.text).toBe('claude-code timed out after 300ms without a result')
  const pids = log().flatMap((e) => (e.event === 'start' ? [e.pid] : e.event === 'grandchild' ? [e.pid, e.detached] : []))
  expect(pids).toHaveLength(4)
  await until(() => pids.every((pid) => !alive(pid)))
}, 30_000)

it('dollars: a run that reported none (cancelled) leaves the reported total a lower bound with a count, not null; priced when the table can', () => {
  const run = { id: 'run-0000c0de', status: 'finished', topology: 'peer-team', parentSessionId: 'lead', writer: { pid: 1, host: 'h', incarnation: 'i' }, startedAt: 0, endedAt: 1, usageJournaled: true, spec: { topology: 'peer-team', members: [{ name: 'cc', runtime: 'claude-code' }], tasks: [{ subject: 's', prompt: 'p' }] } }
  const tokens = { ...emptyUsage(), inputTokens: 1_000_000, calls: 1 }
  const usage = (costUsd?: number) => ({ type: 'swarm/usage', data: { version: 1, member: 'cc', role: 'task', taskKey: 'task-0', runtime: 'claude-code', provider: 'anthropic', model: 'claude-fake-1', runId: 'r', usage: tokens, startedAt: 0, ...(costUsd === undefined ? {} : { costUsd }) } })
  const events = [{ type: 'swarm/run', data: { version: 1, run } }, usage(RUN_USD), usage()].map((e, seq) => ({ seq, time: seq, ...e }))

  const m = foldMetrics(events, [])
  expect(m.dollars).toEqual({ total: RUN_USD, byModel: { 'claude-fake-1': RUN_USD }, byRuntime: { 'claude-code': RUN_USD }, source: 'runtime', unreported: 1 })
  expect(m.unsupported['dollars']).toBeUndefined()
  // With a price for its model, the cancelled run is priced and the total exact.
  expect(foldMetrics(events, [], { pricing: { 'claude-fake-1': { input: 3, output: 15 } } }).dollars).toEqual({ total: RUN_USD + 3, byModel: { 'claude-fake-1': RUN_USD + 3 }, byRuntime: { 'claude-code': RUN_USD + 3 }, source: 'mixed' })

  const bundle = buildEvidence({ key: 'task-0', outcome: 'landed', via: 'train', branch: 'b', base: 'c0ffee00', at: 2 }, events, [])
  expect(bundle.cost!.reported).toEqual({ usd: RUN_USD, rest: [{ model: 'claude-fake-1', usage: tokens }] })
  expect(landingText(bundle).join('\n')).toContain('cost: 2,000,000 tokens (task 2,000,000), at least $0.04 (1 run(s) neither reported nor priced)')
  expect(landingText(bundle, { 'claude-fake-1': { input: 3, output: 15 } }).join('\n')).toContain('cost: 2,000,000 tokens (task 2,000,000), $3.04')
})
