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
 * ## Tasks must be winnable UNDER the pin
 *
 * The gate pins `packages/*[/]tests`, so a task that cannot be completed without
 * editing an existing test is unwinnable by construction, and its cells measure
 * the pin rather than the gate. Adding a REQUIRED field to a public type does
 * exactly that: every existing literal stops compiling, so the repo's own tests
 * must change. That produced a run where the model's work was correct, the
 * sealed check passed, and ground truth still said "incorrect" because the pin
 * had reverted the test update the change required — reported as a false accept
 * until the checkpoint detail was read.
 *
 * So: additive-OPTIONAL fields, new functions, or behaviour covered solely by
 * sealed checks. This is a winnability precondition alongside discrimination,
 * and unlike discrimination there is no cheap automatic proof — verifying it
 * needs a reference solution.
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
 * NOT retried, deliberately — and it used to be.
 *
 * The retry was added to absorb a flaky suite, but the GATE does not retry, so
 * ground truth held a capability the system under test lacked. A flake then
 * failed the gate and passed ground truth, manufacturing a phantom
 * "rejected & correct" cell — which is exactly what happened to slots-resize,
 * where an unrelated messaging test failed the gate while the change itself was
 * fine. Measuring the gate against a more forgiving oracle measures the gap
 * between them, not the gate.
 *
 * Symmetric instead, with the underlying flake fixed at its source
 * (board-harness `assertRecipientSaw` now polls rather than racing delivery).
 * Residual flakiness will still surface as rejected & correct, which has to be
 * checked case by case rather than papered over.
 */
const GUARD = {
  id: 'suite-still-passes',
  weight: 1,
  role: 'guard',
  check: {
    type: 'cmd',
    // Typecheck AND tests. Ground truth that omits tsc calls code "correct"
    // that does not compile — vitest transpiles without typechecking, so a
    // change breaking types scored as done. Only the suite is retried; tsc is
    // deterministic and a retry would just hide a real failure.
    cmd: 'OPENSWARM_LIVE=0 npm run typecheck && OPENSWARM_LIVE=0 npm test',
  },
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
        // Fail-closed. `test "$(a)" = "$(b)"` passes when BOTH sides are empty,
        // so in an empty or broken workspace this check reported success while
        // nothing had been built at all — it must require the command to exit 0
        // and produce a non-empty version before comparing.
        type: 'cmd',
        cmd: 'v=$(node bin/openswarm.mjs --version) && [ -n "$v" ] && [ "$v" = "$(node -p \'require("./package.json").version\')" ]',
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
    "digestSessionLog in packages/swarm/src/recover.ts folds a dead member's session log into what it was asked and what it reported, but drops tool calls, so a restarted member is told the narrative and not the actions. Add an OPTIONAL `tools?: string[]` field to SessionDigest holding each `tool/call` event's name in order (the name is at `event.data.name`), and include them in renderRecoveryBriefing's output. It must be optional so existing SessionDigest literals still compile — do not edit any file under packages/*/tests.",
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
  expect(result.attempts[0]!.durationMs ?? 0).toBeGreaterThanOrEqual(30)
})
`,
    ),
  ),

  task(
    'merge-reports-base',
    'medium',
    'MergeOutcome.merged entries in packages/git/src/index.ts report taskKey, branch and commits, but not what they were merged from, so a merge cannot be reproduced from the record. Add an OPTIONAL `baseCommit?: string` to each merged entry, set to the resolved base commit the worktrees were cut from. Keep it optional so existing literals still compile, and do not edit any file under packages/*/tests.',
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
  task(
    'slots-cancellable-acquire',
    'hard',
    'The Slots semaphore in packages/swarm/src/worktrees.ts queues callers that arrive at the cap, and a queued caller can never give up. Add an OPTIONAL AbortSignal parameter to acquire(signal?): aborting must reject that waiter AND remove it from the queue, so a later release() hands the slot to the next REAL waiter. Do not edit any file under packages/*[/]tests.',
    sealedCheck(
      'slots-cancellable-acquire',
      `import { expect, it } from 'vitest'
import { Slots } from '../packages/swarm/src/worktrees'

it('an aborted waiter does not swallow a later release', async () => {
  const slots = new Slots(1)
  await slots.acquire()

  const ac = new AbortController()
  const cancelled = slots.acquire(ac.signal).then(() => 'acquired', () => 'cancelled')
  let bAcquired = false
  const b = slots.acquire().then(() => { bAcquired = true })

  ac.abort()
  expect(await cancelled).toBe('cancelled')

  // The slot must reach B. A waiter that is rejected but left in the queue
  // consumes this release and starves everyone behind it.
  slots.release()
  await b
  expect(bAcquired).toBe(true)
})
`,
    ),
  ),

  task(
    'cascade-stall-detection',
    'hard',
    'runCascade in packages/swarm/src/topologies.ts escalates through every tier even when a tier returns exactly what the previous tier already returned, burning budget on a chain that is making no progress. When a tier\'s final text is identical to the previous tier\'s, stop escalating and set an OPTIONAL `stalled?: boolean` on CascadeResult. Do not edit any file under packages/*[/]tests.',
    sealedCheck(
      'cascade-stall-detection',
      `import { expect, it } from 'vitest'
import { runCascade } from '../packages/swarm/src/topologies'
import type { MemberRunResult, MemberSpec } from '../packages/swarm/src/types'

it('stops escalating when a tier repeats the previous tier', async () => {
  let calls = 0
  const run = async (member: MemberSpec): Promise<MemberRunResult> => {
    calls++
    return { member: member.name, runId: 'r', text: 'identical',
      output: [{ type: 'text', text: 'identical' }], stopReason: 'completed' }
  }
  const result = await runCascade(
    { topology: 'cascade', tiers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], task: 't',
      confidence: { commands: ['false'], tau: 1 } },
    run,
    async () => 0,
  )
  expect(result.stalled).toBe(true)
  // Detected at the repeat, not after exhausting the chain.
  expect(calls).toBe(2)
})
`,
    ),
  ),

  task(
    'pipeline-stage-retries',
    'hard',
    'A pipeline stage in packages/swarm/src/topologies.ts gets exactly one attempt, so one transient member failure loses the whole run. Add an OPTIONAL `retries?: number` to a pipeline stage: a stage whose stopReason is not "completed" is retried up to that many additional times before the pipeline gives up. Default stays 0, so existing behaviour is unchanged. Do not edit any file under packages/*[/]tests.',
    sealedCheck(
      'pipeline-stage-retries',
      `import { expect, it } from 'vitest'
import { runPipeline } from '../packages/swarm/src/topologies'
import type { MemberRunResult, MemberSpec } from '../packages/swarm/src/types'

it('retries a failing stage up to its budget, then succeeds', async () => {
  let attempts = 0
  const run = async (member: MemberSpec): Promise<MemberRunResult> => {
    attempts++
    const ok = attempts >= 3
    return { member: member.name, runId: 'r', text: 'x',
      output: [{ type: 'text', text: 'x' }],
      stopReason: (ok ? 'completed' : 'error') as never }
  }
  const result = await runPipeline(
    { topology: 'pipeline', stages: [{ member: { name: 'a' }, prompt: 'p', retries: 2 }] } as never,
    run,
  )
  expect(attempts).toBe(3)
  expect(result.final.stopReason).toBe('completed')
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
  { id: 'ungated', label: 'gate off', scaffold: {} }
]
