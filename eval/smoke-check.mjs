// Zero-token wiring check: does swarmkit-eval's own smoke benchmark run in this
// repo? Proves the dependency works before any OpenSwarm integration is written.
import {
  runEval, buildReport, renderMarkdownReport,
  InProcessBackend, LocalResultStore, MockAdapter,
  smokeBenchmark, smokeMockSpec, SMOKE_ARMS,
} from 'swarmkit-eval'

const config = {
    runId: 'wiring-check',
    configVersion: 'v0',
    benchmark: 'smoke',
    arms: SMOKE_ARMS,
    models: [{ name: 'mock' }],
    seeds: [1, 2, 3],
    backend: 'in-process',
    concurrency: { cells: 4, modelConnections: 1 },
    output: { dir: '.eval-runs', trace: false },
}
const results = await runEval(config, {
    benchmark: smokeBenchmark,
    adapter: new MockAdapter(smokeMockSpec),
    backend: new InProcessBackend(),
    store: new LocalResultStore('.eval-runs'),
  },
)
console.log('cells:', results.length)
const report = buildReport(results, config)
console.log(renderMarkdownReport(report).split('\n').slice(0, 20).join('\n'))
