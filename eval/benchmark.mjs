/**
 * The C1/C2 task set: changes to this repo, each with SEALED ground truth.
 *
 * `checkpoints` never reach the system under test — `PublicTask` is a `Pick`
 * allowlist, so they are structurally unreachable rather than merely
 * undocumented, and a `cmd` check's `writeFiles` seeds its test into the
 * FINISHED workspace, after the agent is done, in a directory it never saw.
 *
 * ## Roles, and why every check carries a discrimination proof
 *
 * A check that cannot come out both ways measures nothing, and it fails
 * silently — it reports a number that was never in question. So each check
 * declares how it is proven to discriminate:
 *
 * - `role: 'progress'` — did the job get done. MUST FAIL at the base commit.
 * - `role: 'guard'` — was anything broken. MUST PASS at base. Its power to fail
 *   is not re-proven per task: it inherits that evidence from the mutation run
 *   in [docs/04](../docs/04-gate-discrimination.md).
 *
 * The roles are the general contract, not SWE-bench's shape; a measured or
 * structural check fits it equally.
 *
 * ## Sealed tests need their own vitest config
 *
 * The root config includes only `packages/*[/]tests/**`, so a test dropped
 * anywhere else is silently NOT COLLECTED — vitest exits 1 with "No test files
 * found". A progress check written that way fails at base for the wrong reason
 * and keeps failing after a correct change, making the task unwinnable while
 * looking perfectly well-behaved. Every sealed test therefore ships
 * `SEALED_CONFIG` alongside it and runs under `--config`, which also keeps it
 * out of `npm test` so the guard and progress checks stay independent.
 *
 * ## What this set cannot see
 *
 * Verifiable feedback selects for verifiable work. The one real
 * self-modification we have achieved — a model improving `swarm_author_plugin`'s
 * description — has no mechanical check and would be excluded by this rule.
 */

/** Config that makes `sealed/` collectable without touching the repo's own suite. */
const SEALED_CONFIG = {
  path: 'sealed/vitest.config.ts',
  content: `import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const src = (p: string) => fileURLToPath(new URL(\`../packages/\${p}/src/index.ts\`, import.meta.url))
export default defineConfig({
  root,
  resolve: { alias: { 'openswarm-git': src('git'), 'openswarm-swarm': src('swarm') } },
  test: { include: ['sealed/**/*.test.ts'], environment: 'node', testTimeout: 60_000, hookTimeout: 60_000 },
})
`,
}

const SEALED_CMD = 'npx vitest run --config sealed/vitest.config.ts'

/** A sealed vitest progress check: the test plus the config that collects it. */
const sealedCheck = (id, source) => ({
  id,
  weight: 1,
  role: 'progress',
  check: {
    type: 'cmd',
    cmd: SEALED_CMD,
    writeFiles: [SEALED_CONFIG, { path: `sealed/${id}.test.ts`, content: source }],
  },
})

/**
 * "Nothing broke" — the PASS_TO_PASS half of ground truth.
 *
 * Retried once on failure, deliberately. This suite has timing-sensitive e2e
 * tests and has produced two non-reproducing failures in a day. A genuine
 * regression fails both attempts; a flake does not. Without the retry a flaky
 * run scores a CORRECT change as incorrect, biasing the 2×2 toward making the
 * gate look better than it is — the direction we would least question.
 */
const GUARD = {
  id: 'suite-still-passes',
  weight: 1,
  role: 'guard',
  check: { type: 'cmd', cmd: 'OPENSWARM_LIVE=0 npm test || OPENSWARM_LIVE=0 npm test' },
}

const task = (id, difficulty, prompt, check) => ({
  id: `selfmod/${id}`,
  benchmark: 'openswarm-selfmod',
  difficulty,
  prompt,
  checkpoints: [check, GUARD],
})

export const TASKS = [
  task(
    'launcher-version',
    'easy',
    'Add a --version flag to the launcher at bin/openswarm.mjs. Running `node bin/openswarm.mjs --version` must print the version from the repository package.json and exit 0; today it exits 1 with "unknown option". Change nothing else.',
    {
      id: 'prints-version',
      weight: 1,
      role: 'progress',
      check: {
        type: 'cmd',
        cmd: 'test "$(node bin/openswarm.mjs --version)" = "$(node -p \'require("./package.json").version\')"',
      },
    },
  ),

  task(
    'slots-counts',
    'easy',
    'The Slots class in packages/swarm/src/worktrees.ts tracks concurrency but exposes no way to observe it. Add two public getters: `active` (slots currently held) and `queued` (callers waiting).',
    sealedCheck(
      'slots-counts',
      `import { expect, it } from 'vitest'
import { Slots } from '../packages/swarm/src/worktrees'

it('reports held and waiting counts', async () => {
  const slots = new Slots(1)
  await slots.acquire()
  const waiter = slots.acquire()
  expect(slots.active).toBe(1)
  expect(slots.queued).toBe(1)
  slots.release()
  await waiter
  expect(slots.queued).toBe(0)
})
`,
    ),
  ),

  task(
    'digest-tool-calls',
    'medium',
    "digestSessionLog in packages/swarm/src/recover.ts folds a dead member's session log into what it was asked and what it reported, but drops tool calls, so a restarted member is told the narrative and not the actions. Add a `tools: string[]` field to SessionDigest holding each `tool/call` event's name in order (the name is at `event.data.name`), and include them in renderRecoveryBriefing's output.",
    sealedCheck(
      'digest-tool-calls',
      `import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { digestSessionLog, renderRecoveryBriefing } from '../packages/swarm/src/recover'

it('captures tool calls and surfaces them in the briefing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-'))
  const log = join(dir, 'session.jsonl')
  writeFileSync(
    log,
    [
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'do it' }] } }),
      JSON.stringify({ type: 'tool/call', data: { name: 'bash' } }),
      JSON.stringify({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'done' }] } }),
    ].join('\\n'),
  )
  const digest = digestSessionLog(log)
  expect(digest.tools).toEqual(['bash'])
  expect(renderRecoveryBriefing(digest)).toContain('bash')
})
`,
    ),
  ),

  task(
    'briefing-clip-count',
    'medium',
    'renderRecoveryBriefing in packages/swarm/src/recover.ts keeps only the three most recent entries and silently drops the rest, so a restarted member cannot tell how much history it is missing. When entries are omitted, append exactly "(N earlier omitted)" — with N the number dropped — after the clipped list for that section.',
    sealedCheck(
      'briefing-clip-count',
      `import { expect, it } from 'vitest'
import { renderRecoveryBriefing } from '../packages/swarm/src/recover'

it('says how many earlier entries were dropped', () => {
  const digest = { asked: ['a', 'b', 'c', 'd', 'e', 'f'], reported: [] }
  const out = renderRecoveryBriefing(digest) ?? ''
  expect(out).toContain('(3 earlier omitted)')
})
`,
    ),
  ),

  task(
    'cascade-attempt-duration',
    'medium',
    'CascadeAttempt in packages/swarm/src/types.ts records the tier and its confidence but not how long the tier took, so a cascade cannot be reasoned about on cost. Add a required `durationMs: number` to CascadeAttempt and populate it in runCascade with the wall-clock time of that tier\'s member run.',
    sealedCheck(
      'cascade-attempt-duration',
      `import { expect, it } from 'vitest'
import { runCascade } from '../packages/swarm/src/topologies'
import type { MemberRunResult, MemberSpec } from '../packages/swarm/src/types'

it('records how long each tier took', async () => {
  const run = async (member: MemberSpec): Promise<MemberRunResult> => {
    await new Promise((r) => setTimeout(r, 40))
    return { member: member.name, runId: 'r', text: 'ok', output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }
  }
  const result = await runCascade({ topology: 'cascade', tiers: [{ name: 'only' }], task: 't' }, run)
  expect(result.attempts[0]!.durationMs).toBeGreaterThanOrEqual(30)
})
`,
    ),
  ),

  task(
    'merge-reports-base',
    'medium',
    'MergeOutcome.merged entries in packages/git/src/index.ts report taskKey, branch and commits, but not what they were merged from, so a merge cannot be reproduced from the record. Add `baseCommit: string` to each merged entry, set to the resolved base commit the worktrees were cut from.',
    sealedCheck(
      'merge-reports-base',
      `import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SwarmGit } from '../packages/git/src'

it('records the base commit on each merged branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mergebase-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'base\\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')

  const swarm = new SwarmGit({ repoRoot: root, teamId: 'mb' })
  const wt = await swarm.worktree('task')
  writeFileSync(join(wt.path, 'new.txt'), 'work\\n')
  await swarm.autoCommit(wt, 'work')
  const base = await swarm.baseCommit()
  const outcome = await swarm.mergeAll()
  expect(outcome.merged[0]!.baseCommit).toBe(base)
  await swarm.dispose()
})
`,
    ),
  ),

  task(
    'pipeline-failed-stage',
    'hard',
    'runPipeline in packages/swarm/src/topologies.ts feeds each stage the previous stage output and never inspects stopReason, so a stage that fails is treated as success and the pipeline runs on with a broken input. Halt on the first stage whose stopReason is not "completed", and add `failedStage?: number` to PipelineResult holding that stage index. On success the field stays absent.',
    sealedCheck(
      'pipeline-failed-stage',
      `import { expect, it } from 'vitest'
import { runPipeline } from '../packages/swarm/src/topologies'
import type { MemberRunResult, MemberSpec } from '../packages/swarm/src/types'

it('halts on a failed stage and reports which one', async () => {
  const seen: string[] = []
  const run = async (member: MemberSpec): Promise<MemberRunResult> => {
    seen.push(member.name)
    const stopReason = member.name === 'b' ? 'error' : 'completed'
    return { member: member.name, runId: 'r', text: 'x', output: [{ type: 'text', text: 'x' }], stopReason: stopReason as never }
  }
  const result = await runPipeline(
    { topology: 'pipeline', stages: [
      { member: { name: 'a' }, prompt: 'p' },
      { member: { name: 'b' }, prompt: 'p' },
      { member: { name: 'c' }, prompt: 'p' },
    ] },
    run,
  )
  expect(result.failedStage).toBe(1)
  expect(seen).toEqual(['a', 'b'])
})
`,
    ),
  ),

  task(
    'slots-resize',
    'hard',
    'The Slots semaphore in packages/swarm/src/worktrees.ts has a fixed cap set at construction. Add `resize(limit: number)`: growing the cap must immediately admit as many queued waiters as the new headroom allows, and shrinking must not evict holders already inside — the cap simply applies to future acquisitions.',
    sealedCheck(
      'slots-resize',
      `import { expect, it } from 'vitest'
import { Slots } from '../packages/swarm/src/worktrees'

it('admits queued waiters when the cap grows', async () => {
  const slots = new Slots(1)
  await slots.acquire()
  let admitted = 0
  const a = slots.acquire().then(() => { admitted++ })
  const b = slots.acquire().then(() => { admitted++ })
  expect(admitted).toBe(0)
  slots.resize(3)
  await Promise.all([a, b])
  expect(admitted).toBe(2)
})

it('shrinking does not evict current holders', async () => {
  const slots = new Slots(3)
  await slots.acquire()
  await slots.acquire()
  slots.resize(1)
  slots.release()
  slots.release()
  await slots.acquire()
  expect(true).toBe(true)
})
`,
    ),
  ),
]

export function selfModBenchmark(tasks = TASKS) {
  return {
    id: 'openswarm-selfmod',
    execution: 'native',
    async load(opts = {}) {
      const ids = opts.taskIds
      const chosen = ids === undefined ? tasks : tasks.filter((t) => ids.includes(t.id))
      return opts.limit === undefined ? chosen : chosen.slice(0, opts.limit)
    },
  }
}

/**
 * Gate-on vs gate-off. Everything else held constant, so a difference between
 * the arms is attributable to the gate.
 */
export const ARMS = [
  { id: 'gated', label: 'gate on', scaffold: {} },
  { id: 'ungated', label: 'gate off', scaffold: {} },
]
