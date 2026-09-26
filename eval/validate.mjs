/**
 * Zero-token validation of the whole C1/C2 path before any spend.
 *
 * Drives the real adapter, the real cascade, the real worktree/merge machinery
 * and the real sealed-checkpoint grader — with a scripted mock standing in for
 * the model. If this is green, the only untested variable in a live run is the
 * model itself.
 *
 *   node validate.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runEval, buildReport, renderMarkdownReport, LocalResultStore, InProcessBackend } from 'swarmkit-eval'
import { bootMock } from './boot.mjs'
import { makeSelfModAdapter } from './adapter.mjs'
import { selfModBenchmark, wiringTask, ARMS } from './benchmark.mjs'

const REPO = resolve(import.meta.dirname, '..')

/**
 * A check that already passes at base scores a no-op as success. Refuse to run
 * rather than trust the author — the same discipline as the mutation runner's
 * baseline.
 */
function verifyChecksFailAtBase(tasks) {
  const probe = mkdtempSync(join(tmpdir(), 'openswarm-basecheck-'))
  rmSync(probe, { recursive: true, force: true })
  execFileSync('git', ['worktree', 'add', '-q', '--detach', probe, 'HEAD'], { cwd: REPO })
  try {
    for (const task of tasks) {
      for (const cp of task.checkpoints ?? []) {
        if (cp.check.type !== 'cmd') continue
        let passed = true
        try {
          execFileSync('bash', ['-c', cp.check.cmd], { cwd: probe, stdio: 'ignore' })
        } catch {
          passed = false
        }
        if (passed) {
          throw new Error(
            `checkpoint "${cp.id}" of ${task.id} ALREADY PASSES at base — it cannot distinguish a real change from a no-op`,
          )
        }
        console.log(`  ✓ ${task.id}/${cp.id} fails at base (as it must)`)
      }
    }
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', probe], { cwd: REPO })
    } catch {
      rmSync(probe, { recursive: true, force: true })
    }
  }
}

console.log('checking sealed checkpoints fail at base…')
verifyChecksFailAtBase([wiringTask])

// The scripted member writes exactly what the sealed check looks for. The gate
// is deliberately unsatisfiable, so the two arms must diverge: gated withholds,
// ungated merges. Identical outcomes would mean the arms are not wired.
const boot = () =>
  bootMock({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'wrote the marker',
    toolName: 'bash',
    toolArguments: JSON.stringify({ command: 'echo evaluated > eval-marker.txt' }),
  })

const adapter = makeSelfModAdapter({
  repoRoot: REPO,
  boot,
  gate: { commands: ['test -f never-satisfied'], pinPaths: ['packages/*/tests'], tiers: 1 },
})

const config = {
  runId: 'selfmod-validate',
  configVersion: 'v0',
  benchmark: 'openswarm-selfmod',
  arms: ARMS,
  models: [{ name: 'mock' }],
  seeds: [1],
  backend: 'in-process',
  concurrency: { cells: 1, modelConnections: 1 },
  output: { dir: '.eval-runs', trace: false },
}

console.log('running cells…')
const results = await runEval(config, {
  benchmark: selfModBenchmark(),
  adapter,
  // Required even though the adapter self-places: the orchestrator validates
  // the pair up front rather than at first use.
  backend: new InProcessBackend(),
  store: new LocalResultStore('.eval-runs'),
})

adapter.cleanup()

for (const cell of results) {
  const m = cell.raw?.metadata ?? cell.metadata ?? {}
  console.log(
    `[${cell.armId ?? cell.arm?.id}] status=${cell.status} score=${cell.score?.full} ` +
      `accepted=${m.accepted} merged=${m.merged} withheld=${m.withheld}`,
  )
}

console.log()
console.log(renderMarkdownReport(buildReport(results, config)).split('\n').slice(0, 14).join('\n'))
process.exit(0)
