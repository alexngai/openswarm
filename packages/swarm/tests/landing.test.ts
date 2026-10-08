/**
 * Landing evidence (docs/05 B4) and RunMetrics (B5). A gated peer-team's
 * journals with a train landing (support/landing-scenario.ts: one repair,
 * one resolver, one ejection, a human waiver and a tamper advisory) give the
 * bundles, their risk tiers, the landing queue's order and text, and every
 * metric; real runs without the train (worktrees and the sequential queue;
 * members in process) still get bundles and metrics from what they journal;
 * the protocol serves both to a viewer.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SwarmGit } from 'openswarm-git'
import {
  SwarmJournal,
  buildEvidence,
  dispatch,
  emptyUsage,
  foldMetrics,
  landTrain,
  landingText,
  metricsRows,
  priced,
  runLandings,
  runMetrics,
  tokensOf,
  trainJournalPath,
  trainVerify,
  usageFromLogs,
  type LandingEvidence,
  type MemberSpec,
  type RunMetrics,
  type SwarmRunRecord,
  type SwarmUsageEvent,
} from '../src/index'
import { bootHarness, type TestHarness } from './boot'
import { BAD, PLANTED, REVIEW, STEP, TASK, WALL_MS, landingScenario } from './support/landing-scenario'

let h: TestHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const runsDir = () => mkdtempSync(join(tmpdir(), 'openswarm-landing-runs-'))
/** The scenario's journals, landed once for the tests that only read them. */
let landed: ReturnType<typeof landingScenario> | undefined
const scenario = () => (landed ??= landingScenario(runsDir()))
const byKey = (landings: LandingEvidence[]) => new Map(landings.map((l) => [l.key, l]))
const T = tokensOf(TASK)
const R = tokensOf(REVIEW)
const S = tokensOf(STEP)

it('the train journals an evidence bundle per landed and ejected entry: intent, diff, verifier levels, cost, questions, steps, and a risk tier', async () => {
  const { runDir, outcome, steps } = await scenario()
  // The train gave each agent step its role, so its usage counts as coordination.
  expect(steps.map((s) => [s.key, s.role])).toEqual([
    ['task-3', 'resolve'],
    ['task-1', 'repair'],
  ])
  expect(outcome.landed!.map((l) => l.taskKey)).toEqual(['task-0', 'task-2', 'task-4', 'task-5', 'task-3'])
  expect(outcome.ejected!.map((e) => e.taskKey)).toEqual(['task-1'])

  const train = SwarmJournal.read(join(runDir, 'train.jsonl'))
  const bundles = train.filter((e) => e.type === 'train/evidence').map((e) => e.data as LandingEvidence)
  // Journaled as each entry lands or is ejected: right after its train/landed or train/ejected.
  const order = train.filter((e) => ['train/landed', 'train/ejected', 'train/evidence'].includes(e.type)).map((e) => `${e.type.slice(6)} ${(e.data as any).key}`)
  expect(order).toEqual(['landed task-0', 'evidence task-0', 'landed task-2', 'evidence task-2', 'landed task-4', 'evidence task-4', 'landed task-5', 'evidence task-5', 'landed task-3', 'evidence task-3', 'ejected task-1', 'evidence task-1'])
  const b = byKey(bundles)

  // A clean L2 landing: the run's intent, its diff against the batch tip, gate and train both L2.
  expect(b.get('task-0')).toMatchObject({
    outcome: 'landed',
    via: 'train',
    batch: 3,
    subject: 'core',
    intent: { purpose: 'ship the parser', endState: 'every check passes' },
    diff: { files: ['a.txt'], insertions: 1, deletions: 0 },
    level: 2,
    gate: { kind: 'commands', level: 2, passed: true, round: 1 },
    gateRounds: 1,
    train: { level: 2, passed: true, batch: 3 },
    cost: { tokens: T, byRole: { task: T } },
    questions: [],
    steps: [],
    tamper: [],
    risk: 'medium',
    why: [],
  })
  const tipOf = (batch: number) => (train.find((e) => e.type === 'train/batch' && (e.data as any).batch === batch)!.data as any).tip
  expect(b.get('task-0')!.base).toBe(tipOf(3))

  // Waived by a person at its gate: high, with who and when; the train's L2 still verified the landing.
  expect(b.get('task-2')).toMatchObject({
    level: 2,
    gate: { kind: 'human', passed: true, by: 'owner' },
    gateRounds: 2,
    questions: [{ id: 'q-0', trigger: 'verifier-failure', status: 'answered', answer: 'accept', by: 'owner', raisedAt: expect.any(Number), closedAt: expect.any(Number) }],
    risk: 'high',
    why: ['gate waived by owner'],
  })
  const waiver = b.get('task-2')!.questions[0]!
  expect(waiver.closedAt! - waiver.raisedAt).toBe(30_000)

  // Went to the resolver: its own intent, and the resolver's usage as coordination.
  expect(b.get('task-3')).toMatchObject({
    intent: { purpose: 'load the config', endState: 'config loads' },
    diff: { files: ['shared.txt'] },
    steps: [{ step: 'resolve', member: 'bob', outcome: 'resolved' }],
    cost: { tokens: T + S, byRole: { task: T, resolve: S } },
    risk: 'high',
    why: ['went to the resolver'],
  })

  // L3, fully enforced, nothing else: low. Its gate evidence is counts only.
  expect(b.get('task-4')).toMatchObject({ level: 3, risk: 'low', why: [] })
  expect(b.get('task-4')!.gate).toEqual({ kind: 'hidden', level: 3, passed: true, round: 1, suite: 'acceptance', total: 4, failed: 0, enforcement: 'full' })

  // L1 review at its gate with a tamper advisory: high; the review's usage counts toward its cost.
  expect(b.get('task-5')).toMatchObject({
    level: 2,
    gate: { kind: 'review', level: 1 },
    gateRounds: 2,
    tamper: [{ step: 'gate', severity: 'advisory', signals: ['verifier-user in transcript'] }],
    cost: { tokens: T + R, byRole: { task: T, review: R }, byModel: { 'model-a': TASK, 'model-b': REVIEW } },
    risk: 'high',
    why: ['tamper advisory in its gate'],
  })

  // Ejected after its one repair: the failing verification by command, the question that ejected it, the step.
  const ejected = b.get('task-1')!
  expect(ejected).toMatchObject({
    outcome: 'ejected',
    reason: expect.stringContaining('after 1 repair(s): L2 check failed'),
    level: 2,
    train: { level: 2, passed: false, failedCommand: BAD },
    steps: [{ step: 'repair', member: 'bob', attempt: 1, outcome: 'committed' }],
    questions: [{ trigger: 'verifier-failure', status: 'defaulted', answer: 'eject' }],
    cost: { tokens: T + S, byRole: { task: T, repair: S } },
    risk: 'high',
    why: ['repaired'],
  })
  expect(ejected.diff!.files.sort()).toEqual(['b.txt', 'bad.txt', 'notes.txt'])

  // Never a check's output, which the train's own journal keeps a tail of.
  expect(JSON.stringify(train.filter((e) => e.type === 'train/verified'))).toContain(PLANTED)
  for (const bundle of bundles) {
    expect(JSON.stringify(bundle)).not.toContain(PLANTED)
    expect(bundle.train === undefined || !('output' in bundle.train)).toBe(true)
  }
})

it('the landing queue sorts by risk tier, then time, one compact block per landing', async () => {
  const { runDir } = await scenario()
  const landings = runLandings(runDir)
  expect(landings.map((l) => [l.risk, l.key])).toEqual([
    ['high', 'task-2'],
    ['high', 'task-5'],
    ['high', 'task-3'],
    ['high', 'task-1'],
    ['medium', 'task-0'],
    ['low', 'task-4'],
  ])
  const blocks = landings.map((l) => landingText(l))
  expect(blocks.map((lines) => lines[0])).toEqual([
    expect.stringMatching(/^HIGH   task-2 landed \(train batch 5, [0-9a-f]{8}\) — docs$/),
    expect.stringMatching(/^HIGH   task-5 landed \(train batch 6, [0-9a-f]{8}\) — review$/),
    expect.stringMatching(/^HIGH   task-3 landed \(train batch 9, [0-9a-f]{8}\) — config$/),
    expect.stringMatching(/^HIGH   task-1 ejected \(branch swarm\/scn\/task-1 kept: fails on the integrated tree after 1 repair\(s\)/),
    expect.stringMatching(/^MEDIUM task-0 landed \(train batch 3, [0-9a-f]{8}\) — core$/),
    expect.stringMatching(/^LOW    task-4 landed \(train batch 6, [0-9a-f]{8}\) — hidden$/),
  ])
  const ejected = blocks[3]!.join('\n')
  expect(ejected).toContain('why: repaired')
  expect(ejected).toContain('intent: ship the parser — end state: every check passes')
  expect(ejected).toMatch(/diff on [0-9a-f]{8}: 3 file\(s\), \+3 −0: /)
  expect(ejected).toContain(`verified: L2 (gate: L2 commands, round 1 passed, 1 round(s); train batch 8: L2 check failed: ${BAD})`)
  expect(ejected).toContain(`cost: ${(T + S).toLocaleString('en-US')} tokens (task ${T.toLocaleString('en-US')}, repair ${S})`)
  expect(ejected).toMatch(/questions: q-\d+ verifier-failure: eject \(defaulted after \d+m?s\)/)
  expect(ejected).toContain('steps: repair 1 by bob: committed')
  expect(blocks[0]!.join('\n')).toContain('questions: q-0 verifier-failure: accept (answered by owner after 30s)')
  expect(blocks[1]!.join('\n')).toContain('tamper advisory in its gate: verifier-user in transcript')
  // Every line past the first is indented under it.
  for (const lines of blocks) for (const line of lines.slice(1)) expect(line).toMatch(/^ {7}\S/)
  // Priced, the cost reads in dollars too.
  expect(landingText(landings[4]!, { 'model-a': { input: 5, output: 30, cacheRead: 0.5 } }).join('\n')).toContain(`cost: ${T.toLocaleString('en-US')} tokens (task ${T.toLocaleString('en-US')}), $0.01`)
})

it('RunMetrics: every row from the journals, null with a reason where they cannot say', async () => {
  const { runDir, runId } = await scenario()
  const m = runMetrics(runDir)
  const coordination = R + 2 * S
  expect(m).toEqual({
    version: 1,
    runId,
    landed: 5,
    levels: { L2: 4, L3: 1 },
    tokens: {
      inputTokens: 6 * TASK.inputTokens + REVIEW.inputTokens + 2 * STEP.inputTokens,
      outputTokens: 6 * TASK.outputTokens + REVIEW.outputTokens + 2 * STEP.outputTokens,
      cacheReadTokens: 6 * TASK.cacheReadTokens,
      cacheWriteTokens: 0,
      calls: 6 * TASK.calls + REVIEW.calls + 2 * STEP.calls,
      total: 6 * T + coordination,
      byPrincipal: { alice: 3 * T, bob: 3 * T + 2 * S, reviewer: R },
      byModel: { 'model-a': 6 * T + 2 * S, 'model-b': R },
      byRuntime: { 'dsh:sdk': 6 * T + coordination },
    },
    dollars: null,
    wallClockMs: WALL_MS,
    coordination: { ratio: coordination / (6 * T), coordination, task: 6 * T, split: { review: R, repair: S, resolve: S, lead: 0 } },
    interventions: { steers: 0, answers: 1, restarts: 0, questions: { 'verifier-failure': 2 }, medianTimeToAnswerMs: 30_000 },
    landing: {
      entries: 6,
      landed: 5,
      landingRate: 5 / 6,
      // task-0, task-2, task-4 and task-5; task-3 conflicted, task-1 was repaired.
      cleanMergeRate: 4 / 6,
      // Batch 1, its first half, and the second wave's batch.
      bisects: 3,
      conflicts: 1,
      latencyMs: { median: expect.any(Number), max: expect.any(Number) },
    },
    tasks: { seeded: 6, lost: 0, duplicated: 0 },
    tamper: { incidents: 0, advisories: 1 },
    costPerLanding: { tokens: Math.round((6 * T + coordination) / 5), dollars: null },
    unsupported: {
      dollars: 'no pricing configured (SwarmConfig.pricing, or --pricing <file>)',
      'costPerLanding.dollars': 'no pricing configured (SwarmConfig.pricing, or --pricing <file>)',
    },
  } satisfies RunMetrics)
  expect(m.landing!.latencyMs!.max).toBeGreaterThanOrEqual(m.landing!.latencyMs!.median)
  expect(m.landing!.latencyMs!.median).toBeGreaterThanOrEqual(0)

  // Priced: dollars by model; a model the table lacks leaves them null, saying which.
  const pricing = { 'model-a': { input: 5, output: 30, cacheRead: 0.5 }, 'model-b': { input: 1, output: 2 } }
  const priced = runMetrics(runDir, { pricing })
  const a = ((6 * TASK.inputTokens + 2 * STEP.inputTokens) * 5 + (6 * TASK.outputTokens + 2 * STEP.outputTokens) * 30 + 6 * TASK.cacheReadTokens * 0.5) / 1e6
  const bModel = (REVIEW.inputTokens * 1 + REVIEW.outputTokens * 2) / 1e6
  expect(priced.dollars!.byModel).toEqual({ 'model-a': expect.closeTo(a, 10), 'model-b': expect.closeTo(bModel, 10) })
  expect(priced.dollars!.total).toBeCloseTo(a + bModel, 10)
  expect(priced.costPerLanding!.dollars).toBeCloseTo((a + bModel) / 5, 10)
  expect(priced.unsupported).toEqual({})
  const partial = runMetrics(runDir, { pricing: { 'model-a': pricing['model-a'] } })
  expect(partial.dollars).toBeNull()
  expect(partial.unsupported['dollars']).toBe('no price for model-b')

  const rows = new Map(metricsRows(m))
  expect(rows.get('landed')).toBe('5 (L2 4, L3 1)')
  expect(rows.get('dollars')).toBe('— no pricing configured (SwarmConfig.pricing, or --pricing <file>)')
  expect(rows.get('coordination')).toBe(`${(coordination / (6 * T)).toFixed(2)} = ${coordination} (lead 0, repair ${S}, resolve ${S}, review ${R}) ÷ ${(6 * T).toLocaleString('en-US')} task work`)
  expect(rows.get('interventions')).toBe('steers 0, answers 1, restarts 0; median time-to-answer 30s')
  expect(rows.get('tasks')).toBe('seeded 6, lost 0, duplicated 0')
  expect(rows.get('tamper')).toBe('0 incident(s), 1 advisory')
})

it('lost and duplicated tasks, steers, restarts and unanswered questions are counted from the journal, not assumed', () => {
  const run = {
    id: 'run-0000beef',
    status: 'finished',
    topology: 'peer-team',
    parentSessionId: 'lead',
    writer: { pid: 1, host: 'h', incarnation: 'i' },
    startedAt: 1_000,
    endedAt: 61_000,
    spec: { topology: 'peer-team', members: [{ name: 'a' }], tasks: [{ subject: 'x', prompt: 'p' }, { subject: 'y', prompt: 'p' }], messaging: true },
  }
  const task = (id: string, subject: string) => ({ type: 'swarm/task', data: { version: 1, task: { id, revision: 0, subject, prompt: 'p', status: 'completed', blockedBy: [] } } })
  const events = [
    { type: 'swarm/run', data: { version: 1, run } },
    // y never reached the board; x is on it twice.
    task('task-0', 'x'),
    task('task-1', 'x'),
    { type: 'swarm/steer', data: { version: 1, to: 'a', text: 'go', delivery: 'immediate', by: 'owner' } },
    { type: 'swarm/restart', data: { version: 1, member: 'a', taskId: 'task-0', restart: 1 } },
    { type: 'swarm/question', data: { version: 1, question: { id: 'q-0', trigger: 'stall', kind: 'escalation', tier: 'low', prompt: '', options: [], default: 'restart', status: 'defaulted', answer: 'restart', raisedAt: 0, closedAt: 5 } } },
  ].map((e, seq) => ({ seq, time: seq, ...e }))
  const m = foldMetrics(events, [])
  expect(m.tasks).toEqual({ seeded: 2, lost: 1, duplicated: 1 })
  expect(m.interventions).toEqual({ steers: 1, answers: 0, restarts: 1, questions: { stall: 1 }, medianTimeToAnswerMs: null })
  expect(m.wallClockMs).toBe(60_000)
  // In place (no worktrees): a board task completing is its landing; there is no train or queue to measure.
  expect(m.landed).toBe(2)
  expect(m.levels).toEqual({ L0: 2 })
  expect(m.landing).toBeNull()
  expect(m.unsupported).toMatchObject({
    tokens: "messaging peers' usage is not journaled yet",
    landing: "nothing lands: the run's members work in place, without worktrees",
    'interventions.medianTimeToAnswerMs': 'no question was answered',
  })
  expect(m.dollars).toBeNull()
  expect(m.coordination).toBeNull()
  expect(m.costPerLanding).toBeNull()
})

it('without the train: worktree members journal their usage, finalize journals a bundle per merged task, and the result carries the same metrics as the offline fold', async () => {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const root = mkdtempSync(join(tmpdir(), 'openswarm-landing-queue-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  h = await bootHarness({
    // Each task's turn: a bash call, then done.
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'task done',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'b=$(git rev-parse --abbrev-ref HEAD | tr / -); echo "$b" > "out-$b.txt"' }),
  })
  const base = h.mock.baseURL.endsWith('/v1') ? h.mock.baseURL : `${h.mock.baseURL}/v1`
  const member = { env: { OPENSWARM_LLM_BASE_URL: base, OPENSWARM_LLM_API_KEY: 'mock-key', DSH_MODEL: 'mock-model' } }
  const settled: [string, RunMetrics][] = []
  h.ctx.on('swarm/metrics', (runId, metrics) => void settled.push([runId, metrics]))
  const run = await h.swarm.start(
    {
      topology: 'peer-team',
      intent: { purpose: 'write two files', endState: 'both exist' },
      members: [{ name: 'solo' }],
      tasks: [
        { subject: 'first', prompt: 'do the first task' },
        { subject: 'second', prompt: 'do the second task' },
      ],
    },
    { parent: h.lead.agent, worktrees: { repoRoot: root, member } },
  )
  const result = await run.result
  expect(result.git!.merged.map((m) => m.taskKey)).toEqual(['task-0', 'task-1'])

  // Each member run's usage, read back from its own session root, with the model its messages name:
  // the SDK provider's default, as no member config names one (DSH_MODEL is not what the child requests).
  const events = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl'))
  const usage = events.filter((e) => e.type === 'swarm/usage').map((e) => e.data as SwarmUsageEvent)
  expect(usage.map((u) => [u.member, u.role, u.taskKey, u.runtime, u.model])).toEqual([
    ['solo', 'task', 'task-0', 'dsh:sdk', 'deepseek-v4-flash'],
    ['solo', 'task', 'task-1', 'dsh:sdk', 'deepseek-v4-flash'],
  ])
  for (const u of usage) expect(u.usage.calls).toBeGreaterThan(0)

  // A bundle per merged task, in the run's journal: the gate's evidence only (none here), so below L2.
  const landings = h.swarm.landings(run.id)
  expect(landings.map((l) => [l.key, l.outcome, l.via, l.level, l.risk])).toEqual([
    ['task-0', 'landed', 'queue', 0, 'high'],
    ['task-1', 'landed', 'queue', 0, 'high'],
  ])
  for (const l of landings) {
    expect(l.why).toEqual(['verified only to L0'])
    expect(l.diff).toEqual({ files: [`out-${l.branch.replace(/\//g, '-')}.txt`], insertions: 1, deletions: 0 })
    expect(l.intent).toEqual({ purpose: 'write two files', endState: 'both exist' })
    expect(l.cost!.byRole.task).toBeGreaterThan(0)
  }
  expect(SwarmJournal.read(trainJournalPath(h.runsDir, run.id))).toEqual([])

  // The result's metrics are the offline fold's, and were emitted as the run settled.
  const m = result.metrics!
  expect(m).toEqual(runMetrics(join(h.runsDir, run.id)))
  expect(settled).toEqual([[run.id, m]])
  expect(m.landed).toBe(2)
  expect(m.levels).toEqual({ L0: 2 })
  expect(m.tokens!.byRuntime).toEqual({ 'dsh:sdk': m.tokens!.total })
  expect(m.tokens!.byPrincipal).toEqual({ solo: m.tokens!.total })
  expect(m.coordination).toMatchObject({ ratio: 0, coordination: 0 })
  expect(m.landing).toEqual({
    entries: 2,
    landed: 2,
    landingRate: 1,
    cleanMergeRate: null,
    bisects: null,
    conflicts: 0,
    latencyMs: null,
  })
  expect(m.unsupported).toMatchObject({
    'landing.cleanMergeRate': 'the sequential queue merges without verifying',
    'landing.bisects': 'the sequential queue does not bisect',
    'landing.latencyMs': 'the sequential queue journals no landing times',
  })
  expect(m.tasks).toEqual({ seeded: 2, lost: 0, duplicated: 0 })
  expect(SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl')).at(-1)).toMatchObject({ type: 'swarm/run', data: { run: { status: 'finished', landing: 'queue', result: { metrics: m } } } })
}, 120_000)

it('in process, with no worktrees: usage from the session events, nothing lands, and roles follow the topology', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'APPROVED' })
  const result = await h.swarm.runTeam(
    { topology: 'critic-loop', worker: { name: 'writer' }, critic: { name: 'critic' }, task: 'write it' },
    { parent: h.lead.agent },
  )
  const m = result.metrics!
  expect(m.tokens!.byPrincipal).toEqual({ writer: expect.any(Number), critic: expect.any(Number) })
  expect(m.tokens!.byRuntime).toEqual({ 'dsh:spawn': m.tokens!.total })
  expect(m.tokens!.byModel).toEqual({ 'mock-model': m.tokens!.total })
  // The critic reviews: its tokens are coordination over the writer's.
  expect(m.coordination).toEqual({
    ratio: m.tokens!.byPrincipal['critic']! / m.tokens!.byPrincipal['writer']!,
    coordination: m.tokens!.byPrincipal['critic'],
    task: m.tokens!.byPrincipal['writer'],
    split: { review: m.tokens!.byPrincipal['critic'], repair: 0, resolve: 0, lead: 0 },
  })
  expect(m.landed).toBeNull()
  expect(m.unsupported['landed']).toBe("nothing lands: the run's members work in place, without worktrees, and it has no board")
  expect(h.swarm.landings((await h.swarm.runs()).at(-1)!.id)).toEqual([])
})

it('swarm/landings and swarm/metrics serve a viewer, as text too, and a bound principal only its run', async () => {
  h = await bootHarness({ sequence: ['success'], successText: 'unused' })
  const { runId } = await landingScenario(h.runsDir)
  const viewer = { role: 'viewer' } as const
  const { landings } = (await dispatch(h.ctx, viewer, 'swarm/landings', { runId })) as { landings: (LandingEvidence & { text: string[] })[] }
  expect(landings.map((l) => l.key)).toEqual(['task-2', 'task-5', 'task-3', 'task-1', 'task-0', 'task-4'])
  expect(landings[0]!.text).toEqual(landingText(runLandings(join(h.runsDir, runId))[0]!))
  const { metrics, rows } = (await dispatch(h.ctx, viewer, 'swarm/metrics', { runId })) as { metrics: RunMetrics; rows: [string, string][] }
  expect(metrics).toEqual(runMetrics(join(h.runsDir, runId)))
  expect(rows).toEqual(metricsRows(metrics))
  await expect(dispatch(h.ctx, { role: 'viewer', runId: 'run-00000000' }, 'swarm/metrics', { runId })).rejects.toThrow(/^FORBIDDEN: swarm\/metrics: this principal is bound to run run-00000000/)
  await expect(dispatch(h.ctx, viewer, 'swarm/landings', { runId: 'run-0000none' })).rejects.toThrow(/^NOT_FOUND: /)
})

/** Journal events as a reader gets them, numbered and timed in order (`time` defaults to the seq). */
const journaled = (events: { type: string; data: unknown; time?: number }[]) => events.map((e, seq) => ({ seq, time: e.time ?? seq, type: e.type, data: e.data }))
const record = (run: Partial<SwarmRunRecord>) => ({
  type: 'swarm/run',
  data: { version: 1, run: { id: 'run-0000c0de', status: 'finished', topology: 'peer-team', parentSessionId: 'lead', writer: { pid: 1, host: 'h', incarnation: 'i' }, startedAt: 0, ...run } },
})

it("a baseline-failing train's merge-anyway fallback journals its landings, unverified, and bundles the queue's conflicts too", async () => {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-landing-fallback-'))
  const sh = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root })
  sh('init', '-q', '-b', 'main')
  // The target already fails the train's check.
  writeFileSync(join(root, 'bad.txt'), 'already\n')
  sh('add', '.')
  sh('commit', '-qm', 'init')
  const git = new SwarmGit({ repoRoot: root, teamId: 'fb' })
  for (const [key, file, text] of [['a', 'a.txt', 'a\n'], ['b', 'shared.txt', 'from b\n'], ['c', 'shared.txt', 'from c\n']] as const) {
    const worktree = await git.worktree(key)
    writeFileSync(join(worktree.path, file), text)
    await git.autoCommit(worktree, `work ${key}`)
  }
  const runDir = runsDir()
  const runEvents = journaled([record({ landing: 'train', usageJournaled: true, status: 'running' })])
  const train = SwarmJournal.open(join(runDir, 'train.jsonl'))
  const config = { checks: ['test ! -f bad.txt'] }
  const outcome = await landTrain(git, config, {
    journal: train,
    runEvents: () => runEvents,
    owners: new Map(['a', 'b', 'c'].map((key) => [key, { member: { name: 'm' } as MemberSpec, prompt: key }])),
    run: async () => {
      throw new Error('no agent step on this path')
    },
    ask: async (q) => (q.options.includes('merge') ? 'merge' : q.default),
    verify: trainVerify(config),
  })
  await git.dispose()
  expect(outcome.merged.map((m) => m.taskKey)).toEqual(['a', 'b'])
  expect(outcome.conflicts.map((c) => c.taskKey)).toEqual(['c'])

  const landed = train.events.filter((e) => e.type === 'train/landed').map((e) => e.data as any)
  expect(landed.map((l) => [l.key, l.batch, l.unverified, l.commits])).toEqual([
    ['a', 0, true, 1],
    ['b', 0, true, 1],
  ])
  const bundles = byKey(bundlesOf(train.events))
  expect([...bundles.values()].map((b) => [b.key, b.outcome, b.via, b.risk, b.why])).toEqual([
    ['a', 'landed', 'queue', 'high', ['merged unverified', 'verified only to L0']],
    ['b', 'landed', 'queue', 'high', ['merged unverified', 'verified only to L0']],
    ['c', 'conflicted', 'queue', 'high', ['merged unverified', 'conflicted in the queue', 'verified only to L0']],
  ])
  expect(bundles.get('c')!.diff!.files).toEqual(['shared.txt'])
  expect(landingText(bundles.get('a')!)[0]).toMatch(/^HIGH   a landed \(queue unverified, branch swarm\/fb\/a\)$/)
  expect(landingText(bundles.get('c')!)[0]).toMatch(/^HIGH   c conflicted \(queue, branch swarm\/fb\/c kept\)$/)

  // The metrics agree with the bundles: two of three landed, none cleanly, one conflict.
  const m = foldMetrics(runEvents, train.events)
  expect(m.landed).toBe(2)
  expect(m.landing).toMatchObject({ entries: 3, landed: 2, landingRate: 2 / 3, cleanMergeRate: 0, bisects: 0, conflicts: 1 })
})

/** A train journal's bundles, in journal order. */
function bundlesOf(trainEvents: readonly { type: string; data: unknown }[]): LandingEvidence[] {
  return trainEvents.filter((e) => e.type === 'train/evidence').map((e) => e.data as LandingEvidence)
}

it("a messaging team's usage is not measured, though the train's steps journaled some: tokens, dollars, cost per landing and bundle cost say why", () => {
  const spec = { topology: 'peer-team', messaging: true, members: [{ name: 'a' }], tasks: [{ subject: 'x', prompt: 'p' }] }
  const step: SwarmUsageEvent = { version: 1, member: 'a', role: 'repair', taskKey: 'task-0', runtime: 'dsh:sdk', model: 'm', runId: 'r', usage: { ...emptyUsage(), inputTokens: 50, calls: 1 }, startedAt: 0 }
  const runEvents = journaled([
    record({ landing: 'train', usageJournaled: true, spec: spec as any, endedAt: 10 }),
    { type: 'swarm/task', data: { version: 1, task: { id: 'task-0', revision: 2, subject: 'x', prompt: 'p', status: 'completed', blockedBy: [], owner: 'a' } } },
    { type: 'swarm/usage', data: step },
  ])
  const bundle = buildEvidence({ key: 'task-0', outcome: 'landed', via: 'train', branch: 'swarm/t/task-0', base: 'b', at: 5, batch: 1, commit: 'c' }, runEvents, [])
  const trainEvents = journaled([
    { type: 'train/enqueued', data: { version: 1, key: 'task-0', branch: 'swarm/t/task-0', commits: 1, blockedBy: [], priority: 0 } },
    { type: 'train/landed', data: { version: 1, key: 'task-0', branch: 'swarm/t/task-0', commits: 1, batch: 1, commit: 'c' } },
    { type: 'train/evidence', data: bundle },
  ])
  expect(bundle.cost).toBeNull()
  expect(bundle.unmeasured).toBe("messaging peers' usage is not journaled yet")
  expect(landingText(bundle).join('\n')).toContain("cost: — messaging peers' usage is not journaled yet")
  const m = foldMetrics(runEvents, trainEvents, { pricing: { m: { input: 1, output: 1 } } })
  expect(m.landed).toBe(1)
  expect([m.tokens, m.dollars, m.coordination, m.costPerLanding]).toEqual([null, null, null, null])
  expect(m.unsupported).toMatchObject({
    tokens: "messaging peers' usage is not journaled yet",
    dollars: "messaging peers' usage is not journaled yet",
    costPerLanding: "messaging peers' usage is not journaled yet",
  })
})

it('older and interrupted runs: no landing records or usage records read as unrecorded, not as in place or zero; an interrupted run ends at its last write', () => {
  // A worktree run from before B4/B5: it merged (its result has git), but journaled no evidence or usage.
  const git = { targetBranch: 't', merged: [{ taskKey: 'task-0', branch: 'b', commits: 1 }], conflicts: [], empty: [], withheld: [] }
  const old = foldMetrics(journaled([record({ endedAt: 100, result: { topology: 'peer-team', tasks: [], runs: {}, git } as any })]), [])
  expect([old.landed, old.levels, old.landing, old.tokens]).toEqual([null, null, null, null])
  expect(old.unsupported).toMatchObject({ landed: 'the run predates landing records', landing: 'the run predates landing records', tokens: 'the run predates usage records' })

  // Measured, a run in which no member spent anything has zero tokens, not unknown ones.
  const idle = foldMetrics(journaled([record({ topology: 'fanout', usageJournaled: true, endedAt: 100 })]), [])
  expect(idle.tokens).toMatchObject({ total: 0, byPrincipal: {} })
  expect(idle.dollars).toBeNull()

  // Interrupted: the dead writer's last event, before the takeover's claim release and record.
  const interrupted = foldMetrics(
    journaled([
      { ...record({ status: 'running', usageJournaled: true }), time: 0 },
      { type: 'swarm/task', data: { version: 1, task: { id: 'task-0', revision: 1, subject: 'x', prompt: 'p', status: 'in_progress', owner: 'a', blockedBy: [] } }, time: 4_000 },
      { type: 'swarm/task', data: { version: 1, task: { id: 'task-0', revision: 2, subject: 'x', prompt: 'p', status: 'pending', blockedBy: [] } }, time: 90_000 },
      { ...record({ status: 'interrupted', usageJournaled: true }), time: 90_001 },
    ]),
    [],
    { now: 1_000_000 },
  )
  expect(interrupted.wallClockMs).toBe(4_000)
})

it('session logs: only message lines are parsed, the route is the one the messages name, and a zstd log is not read; a model that spent nothing needs no price', () => {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-usage-logs-'))
  mkdirSync(join(root, 'run-1'))
  const message = (model: string, usage: object) => JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', source: { kind: 'model', provider: 'openai', model } }, usage } })
  writeFileSync(
    join(root, 'run-1', 'session-a.jsonl'),
    [
      JSON.stringify({ type: 'session', id: 'session-a' }),
      // A tool result that merely mentions a message type is not one.
      JSON.stringify({ type: 'tool/result', data: { text: '"assistant/message" {"usage":{"inputTokens":999}}' } }),
      message('gpt-x', { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 }),
      message('gpt-x', { inputTokens: 5, outputTokens: 1 }),
      '{"type":"assistant/message","data":{"usage":{"inputTokens":7', // torn
    ].join('\n'),
  )
  writeFileSync(join(root, 'run-1', 'session-b.jsonl.zstd'), 'not plain text')
  expect(usageFromLogs(root)).toEqual({ usage: { inputTokens: 15, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0, calls: 2 }, provider: 'openai', model: 'gpt-x' })
  expect(usageFromLogs(join(root, 'missing'))).toEqual({ usage: emptyUsage() })

  const spent = { ...emptyUsage(), inputTokens: 1_000_000, calls: 1 }
  expect(priced({ 'gpt-x': spent, idle: emptyUsage() }, { 'gpt-x': { input: 2, output: 8 } })).toBe(2)
  expect(priced({ 'gpt-x': spent, other: spent }, { 'gpt-x': { input: 2, output: 8 } })).toEqual({ reason: 'no price for other' })
})

it('an in-process member that spends and then throws still has its usage journaled, its error intact, and nothing left in the recorder', async () => {
  h = await bootHarness({ sequence: ['success'], repeatLast: true, successText: 'spent' })
  const ctx = h.ctx as any
  // The in-process provider's child runs its turn (spending tokens), then its run throws.
  const spawn = ctx.subagents.getProvider('spawn')
  let child = ''
  ctx.subagents.registerProvider({
    name: 'spends-then-throws',
    capabilities: spawn.capabilities,
    start: async (request: unknown) => {
      const run = await spawn.start(request)
      child = run.id
      return { id: run.id, localAgent: run.localAgent, result: run.result.then(() => Promise.reject(new Error('member blew up'))) }
    },
  })
  const run = await h.swarm.start(
    { topology: 'fanout', members: [{ name: 'x', subagentProvider: 'spends-then-throws' }], tasks: [{ member: 'x', prompt: 'go' }] },
    { parent: h.lead.agent },
  )
  await expect(run.result).rejects.toThrow('member blew up')
  const usage = SwarmJournal.read(join(h.runsDir, run.id, 'journal.jsonl')).filter((e) => e.type === 'swarm/usage').map((e) => e.data)
  // One mock turn: 3 prompt tokens and one per character of 'spent'.
  expect(usage).toEqual([
    {
      version: 1,
      member: 'x',
      role: 'task',
      taskKey: 'task-0',
      runtime: 'dsh:spends-then-throws',
      provider: 'deepseek-official',
      model: 'mock-model',
      runId: child,
      usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
      startedAt: expect.any(Number),
    },
  ])
  expect((h.swarm as any).usage.take(child)).toEqual({ usage: emptyUsage() })
  expect(runMetrics(join(h.runsDir, run.id)).tokens).toMatchObject({ total: 8, byPrincipal: { x: 8 } })
})
