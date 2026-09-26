/**
 * Positive controls: prove the instrument can report each verdict.
 *
 *   node controls.mjs        (zero tokens, no credentials)
 *
 * Every cell of the 2×2 has been asserted about all day, but only ONE of them
 * has ever actually been observed: `accepted & correct`. We have been hunting
 * `accepted & incorrect` across four matrices without ever establishing that the
 * pipeline can emit it. These controls fix that by running cases whose answer is
 * known through the REAL adapter, pin, gate, grader and 2×2 computation —
 * swapping only the model for a scripted member.
 *
 * Two of them are load-bearing beyond plumbing:
 *
 *   `incomplete` is the first thing that would ever produce an
 *   `accepted & incorrect` cell. Note BOTH arms accept it: work that breaks
 *   nothing and does nothing passes a repo-health gate. That is the gate's
 *   structural blind spot, demonstrated rather than argued.
 *
 *   `breaking` is the positive control for the gate having any value at all —
 *   identical member behaviour, different arm, different verdict. If the gated
 *   arm does not reject it, no matrix result means anything.
 *
 * `rejected & correct` is deliberately NOT controlled. Ground truth includes the
 * guard, so a change that breaks something is incorrect by definition and the
 * gate cannot reject correct work unless something is wrong. It should stay
 * empty; an occurrence is a signal to investigate, which is how the flaky
 * messaging test surfaced.
 *
 * LIMIT: the member runs one scripted bash command, not a model tool-use loop.
 * These validate the MEASUREMENT pipeline, not the agent path. A bug that only
 * manifests under real multi-turn tool use would pass here.
 */
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { readdirSync, existsSync, rmSync } from 'node:fs'
import { runEval, LocalResultStore, InProcessBackend } from 'swarmkit-eval'
import { bootMock } from './boot.mjs'
import { makeSelfModAdapter } from './adapter.mjs'
import { ARMS } from './benchmark.mjs'

const REPO = resolve(import.meta.dirname, '..')

/**
 * A trivial task whose ground truth is unambiguous. Real shape — a sealed
 * progress check plus a repo-health guard — so the pipeline is exercised as
 * live runs exercise it.
 *
 * The guard is typecheck-only rather than the full suite: it is still a real
 * health command on the real tree, and it keeps a control run to minutes. The
 * cost is that a defect specific to `npm test` would not surface here.
 */
const CONTROL_TASK = {
  id: 'control/marker',
  benchmark: 'openswarm-selfmod',
  prompt: 'Create a file CONTROL.txt in the repository root containing exactly OK.',
  checkpoints: [
    { id: 'marker', weight: 1, role: 'progress', check: { type: 'cmd', cmd: 'grep -q OK CONTROL.txt' } },
    { id: 'healthy', weight: 1, role: 'guard', check: { type: 'cmd', cmd: 'OPENSWARM_LIVE=0 npm run typecheck' } },
  ],
}

const CONTROLS = [
  {
    id: 'correct',
    why: 'does the job and breaks nothing',
    command: 'echo OK > CONTROL.txt',
    expect: { gated: 'accepted & correct', ungated: 'accepted & correct' },
  },
  {
    id: 'incomplete',
    why: 'breaks nothing and does nothing — the gate is blind to this',
    command: 'echo WRONG > CONTROL.txt',
    expect: { gated: 'accepted & incorrect', ungated: 'accepted & incorrect' },
  },
  {
    id: 'breaking',
    why: 'does the job but breaks the repo — only the gate catches it',
    command: 'echo OK > CONTROL.txt; echo "this is not valid typescript ((" >> packages/swarm/src/recover.ts',
    expect: { gated: 'rejected & incorrect', ungated: 'accepted & incorrect' },
  },
]

/**
 * An errored cell has NO verdict, and must not be rendered as one. Mapping it
 * onto the 2×2 yields "rejected & incorrect" — which is exactly what a gate
 * correctly catching bad work looks like, so an infrastructure failure passes
 * as a finding. That happened here: both `breaking` cells errored, and the
 * gated one matched its expectation by accident.
 */
const cellOf = (c) =>
  c.status === 'env_error'
    ? `env_error (${c.envError?.message ?? '?'})`
    : `${c.metadata?.accepted === true ? 'accepted' : 'rejected'} & ${c.score?.full === true ? 'correct' : 'incorrect'}`

const pinPaths = readdirSync(join(REPO, 'packages'))
  .map((pkg) => join('packages', pkg, 'tests'))
  .filter((rel) => existsSync(join(REPO, rel)))

let failures = 0
for (const control of CONTROLS) {
  console.log(`\n━━ control:${control.id} — ${control.why}`)
  const dir = `.eval-runs/controls-${control.id}`
  rmSync(dir, { recursive: true, force: true })

  const adapter = makeSelfModAdapter({
    repoRoot: REPO,
    boot: () =>
      bootMock({
        sequence: ['tool_call_success', 'success'],
        repeatLast: true,
        successText: 'done',
        toolName: 'bash',
        toolArguments: JSON.stringify({ command: control.command }),
      }),
    gate: {
      commands: ({ work }) => [
        `[ -d node_modules ] || cp -al ${JSON.stringify(work)}/node_modules node_modules`,
        'OPENSWARM_LIVE=0 npm run typecheck',
      ],
      pinPaths,
      tiers: 1,
    },
  })

  const config = {
    runId: `controls-${control.id}`,
    configVersion: 'v1',
    benchmark: 'openswarm-selfmod',
    arms: ARMS,
    models: [{ name: 'mock' }],
    seeds: [1],
    backend: 'in-process',
    concurrency: { cells: 1, modelConnections: 1 },
    output: { dir, trace: false },
  }

  const results = await runEval(config, {
    benchmark: {
      id: 'openswarm-selfmod',
      execution: 'native',
      async load() {
        return [CONTROL_TASK]
      },
    },
    adapter,
    backend: new InProcessBackend(),
    store: new LocalResultStore(dir),
  })
  adapter.cleanup()

  for (const cell of results) {
    const got = cellOf(cell)
    const want = control.expect[cell.armId]
    const ok = got === want
    if (!ok) failures++
    console.log(`   ${ok ? '✓' : '✗'} ${cell.armId.padEnd(8)} got "${got}"${ok ? '' : `  WANT "${want}"`}`)
  }
}

console.log(
  failures === 0
    ? '\nall controls report the expected verdict — the instrument can emit every cell it is asked about'
    : `\n${failures} control(s) MISREPORTED — matrix numbers cannot be trusted until this is fixed`,
)
process.exit(failures === 0 ? 0 : 1)
