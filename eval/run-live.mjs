/**
 * C1/C2 live: the self-modification loop against a real model.
 *
 *   source ~/.zshrc && node run-live.mjs [--tasks a,b] [--seeds 1,2,3]
 *
 * Refuses to start unless every sealed check is proven to discriminate first —
 * a check that cannot come out both ways turns an expensive run into an
 * expensive no-op, and that is cheaper to catch here than in the report.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  runEval,
  buildReport,
  renderMarkdownReport,
  LocalResultStore,
  InProcessBackend,
} from 'swarmkit-eval'
import { bootAzure } from './boot.mjs'
import { makeSelfModAdapter } from './adapter.mjs'
import { selfModBenchmark, TASKS, ARMS } from './benchmark.mjs'
import { verifyDiscrimination } from './discriminate.mjs'

const REPO = resolve(import.meta.dirname, '..')
const argOf = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}
const only = argOf('--tasks')?.split(',')
const seeds = (argOf('--seeds') ?? '1').split(',').map(Number)
const tasks = only === undefined ? TASKS : TASKS.filter((t) => only.includes(t.id))

// The checkout must be clean: cells are cut from HEAD, so uncommitted work is
// invisible to every run and the report would describe a tree nobody has.
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO }).toString().trim()
if (dirty !== '') {
  console.error(`refusing to run against a dirty checkout:\n${dirty}`)
  process.exit(2)
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO }).toString().trim()

console.log(`proving ${tasks.length} task(s) discriminate at ${head.slice(0, 8)}…`)
verifyDiscrimination(tasks, REPO, { onProgress: (l) => console.log(l) })

const adapter = makeSelfModAdapter({
  repoRoot: REPO,
  boot: () => bootAzure(),
  // Keep the diff and the member's tool-call log per cell. Numbers say whether
  // a change passed; only these say what it WAS, and whether it was the change
  // we asked for or an accident that happened to satisfy the check.
  artifactsDir: resolve(import.meta.dirname, '.eval-runs/artifacts'),
  gate: {
    // The real gate, provisioning itself: the inner task worktree is
    // gitignore-clean, so without the hardlink `npm run presubmit` dies on
    // ERR_MODULE_NOT_FOUND and scores every tier 0 regardless of its work.
    commands: ({ work }) => [
      `[ -d node_modules ] || cp -al ${JSON.stringify(work)}/node_modules node_modules`,
      'OPENSWARM_LIVE=0 npm run presubmit',
    ],
    // Tests are not this run's to change: the gate must not grade assets the
    // graded party can edit.
    pinPaths: ['packages/*/tests'],
    tiers: 1,
  },
})

const config = {
  runId: `selfmod-live-${head.slice(0, 8)}`,
  configVersion: 'v1',
  benchmark: 'openswarm-selfmod',
  arms: ARMS,
  models: [{ name: process.env['OPENSWARM_LIVE_MODEL'] ?? 'gpt-5.5' }],
  seeds,
  backend: 'in-process',
  // Serial. presubmit is CPU-bound and this suite has timing-sensitive e2e
  // tests; concurrent cells induce flakes, and a flaked gate is indistinguishable
  // from a real rejection, which silently corrupts the 2×2.
  concurrency: { cells: 1, modelConnections: 1 },
  output: { dir: '.eval-runs', trace: false },
}

console.log(`\nrunning ${tasks.length * ARMS.length * seeds.length} cells (serial)…`)
const started = Date.now()
const results = await runEval(config, {
  benchmark: selfModBenchmark(tasks),
  adapter,
  backend: new InProcessBackend(),
  store: new LocalResultStore('.eval-runs'),
})
adapter.cleanup()

// The 2×2 this whole exercise exists to fill: how often does a gate that only
// checks repo health accept work that did not do the job.
let cells = []
for (const cell of results) {
  const m = cell.metadata ?? {}
  cells.push({
    task: cell.taskId,
    arm: cell.armId,
    seed: cell.seed,
    accepted: m.accepted === true,
    correct: cell.score?.full === true,
    status: cell.status,
    tokens: cell.usage?.totalTokens ?? 0,
    seconds: Math.round((cell.durationMs ?? 0) / 1000),
    failedGateCommand: (m.failures ?? [])[0]?.command,
  })
}
const count = (a, c) => cells.filter((x) => x.accepted === a && x.correct === c).length
console.log('\n=== gate verdict × ground truth ===')
console.log(`  accepted & correct   : ${count(true, true)}`)
console.log(`  accepted & INCORRECT : ${count(true, false)}   <- false accepts`)
console.log(`  rejected & correct   : ${count(false, true)}`)
console.log(`  rejected & incorrect : ${count(false, false)}`)

console.table(cells)
writeFileSync('.eval-runs/cells.json', `${JSON.stringify(cells, null, 2)}\n`, 'utf8')
console.log(`\nelapsed ${Math.round((Date.now() - started) / 60000)}m`)
console.log(renderMarkdownReport(buildReport(results, config)).split('\n').slice(0, 18).join('\n'))
process.exit(0)
