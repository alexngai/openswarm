/**
 * smoke.ts — zero-token wiring check.
 *
 * Proves the openswarm ↔ swarmkit-eval seam works end-to-end: matrix → backend →
 * adapter → grade → content-addressed store → paired-CI report. Uses the built-in
 * `smoke` benchmark (3 arms × 3 seeds) driven by the deterministic MockAdapter on the
 * in-process backend. No models are called, so this is safe to run anytime.
 *
 * Run:  bun eval/experiments/smoke.ts
 *
 * A passing run prints a markdown report with all arms at 100% and writes the
 * content-addressed cache under .eval-runs/ (gitignored). Re-running resumes instantly.
 */
import {
  runEval,
  buildReport,
  renderMarkdownReport,
  InProcessBackend,
  LocalResultStore,
  MockAdapter,
  smokeBenchmark,
  smokeMockSpec,
  SMOKE_ARMS,
  type EvalConfig,
} from "swarmkit-eval";

const config: EvalConfig = {
  runId: "smoke",
  configVersion: "v0",
  benchmark: "smoke",
  arms: SMOKE_ARMS, // stock | notes | graph
  models: [{ name: "mock" }],
  seeds: [1, 2, 3],
  backend: "in-process",
  concurrency: { cells: 4, modelConnections: 1 },
  output: { dir: ".eval-runs", trace: false },
};

const results = await runEval(config, {
  benchmark: smokeBenchmark,
  backend: new InProcessBackend(),
  store: new LocalResultStore(".eval-runs"),
  adapter: new MockAdapter(smokeMockSpec),
});

const report = buildReport(results, config, { baselineArmId: "stock" });
console.log(renderMarkdownReport(report));
console.error(`\n[smoke] ${results.length} cells graded — wiring OK.`);
