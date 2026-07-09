/**
 * cascade-fixit.ts — Stage 0 (docs/51 §7): the cascade pipeline end-to-end on FixIt-N
 * + the in-process backend, on the $/FLOPs axis. Plumbs every seam cheaply —
 * CascadeAdapter → `openswarm topology cascade` (per-tier usage + in-process pytest
 * confidence) → scoring CheckpointGrader → cost-frontier — where fixit's confidence
 * signal is near-perfect (visible tests == scoring tests, docs/51 §9.3). A green run
 * validates the WIRING before any SWE/E2B/GPU spend; it does NOT test signal
 * imperfection (that is Stage 1 / SWE).
 *
 * Arms (all one CascadeAdapter, so per-tier measurement is uniform):
 *   mono-small / mono-large  — 1-tier cascades (never escalate; no confidence command)
 *   cascade-tau<τ>           — [small, large] tiers, escalate when pytest pass-rate < τ
 *
 * Run (needs a packed local `openswarm` on PATH + model creds + python3/pytest):
 *   RUN_CASCADE_FIXIT=1 CF_MODEL_SMALL=<id> CF_MODEL_LARGE=<id> tsx eval/experiments/cascade-fixit.ts
 * Then analyse: `tsx eval/analysis/cost-frontier.ts` (reads the per-tier cost + τ-sweep).
 */
import {
  runEval,
  buildReport,
  renderMarkdownReport,
  createBackend,
  LocalResultStore,
  fixitBenchmark,
  type EvalConfig,
  type Arm,
} from "swarmkit-eval";
import { CascadeAdapter } from "../harness/cascade-adapter.js";

const SMALL = process.env.CF_MODEL_SMALL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const LARGE = process.env.CF_MODEL_LARGE ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const SEEDS = (process.env.CF_SEEDS ?? "1,2").split(",").map((s) => Number(s.trim()));
const N = process.env.CF_N ? Number(process.env.CF_N) : 8;
const TAUS = (process.env.CF_TAUS ?? "0.3,0.6,0.9").split(",").map((s) => Number(s.trim()));
/** fixit's VISIBLE tests (the agent's own `tests/`) → pass-rate confidence (docs/51 §9.3). */
const PYTEST = "python3 -m pytest tests/ -q";

/** Bedrock env forwarded to the in-sandbox openswarm process AND its spawned tiers. */
function providerEnv(): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_USE_BEDROCK: "1" };
  for (const k of [
    "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  ]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (!env.AWS_REGION && !env.AWS_DEFAULT_REGION) env.AWS_REGION = "us-east-1";
  return env;
}

function config(arms: Arm[]): EvalConfig {
  return {
    runId: "cascade-fixit",
    configVersion: process.env.CF_CONFIG_VERSION ?? "v0",
    benchmark: "fixit",
    arms,
    models: [{ name: "cascade" }], // model axis unused — the tier fleet lives in the adapter
    seeds: SEEDS,
    backend: "in-process",
    concurrency: { cells: 2, modelConnections: 2 },
    output: { dir: ".eval-runs", trace: true },
  };
}

export async function runCascadeFixit(): Promise<void> {
  const benchmark = fixitBenchmark({ n: N, seeds: SEEDS });
  const backend = await createBackend("in-process");
  const store = new LocalResultStore(".eval-runs");
  const env = providerEnv();

  const arms: Array<{ arm: Arm; adapter: CascadeAdapter }> = [
    { arm: { id: "mono-small", label: `mono ${SMALL}`, scaffold: {} },
      adapter: new CascadeAdapter({ tiers: [{ model: SMALL }], tau: 1, env }) },
    { arm: { id: "mono-large", label: `mono ${LARGE}`, scaffold: {} },
      adapter: new CascadeAdapter({ tiers: [{ model: LARGE }], tau: 1, env }) },
    ...TAUS.map((tau) => ({
      arm: { id: `cascade-tau${tau}`, label: `cascade τ=${tau}`, scaffold: {} } as Arm,
      adapter: new CascadeAdapter({ tiers: [{ model: SMALL }, { model: LARGE }], tau, escalationCommand: PYTEST, env }),
    })),
  ];

  const all: Awaited<ReturnType<typeof runEval>> = [];
  for (const { arm, adapter } of arms) {
    all.push(...(await runEval(config([arm]), { benchmark, adapter, backend, store })));
  }

  console.log(renderMarkdownReport(buildReport(all, config(arms.map((a) => a.arm)), { baselineArmId: "mono-large" })));
  console.error(
    `[cascade-fixit] ${all.length} cells over fixit-n${N} × ${arms.length} arms × ${SEEDS.length} seeds. ` +
      `Analyse per-tier cost + τ-sweep: tsx eval/analysis/cost-frontier.ts`,
  );
}

if (process.env.RUN_CASCADE_FIXIT) {
  await runCascadeFixit();
} else {
  console.error(
    "[cascade-fixit] dry: set RUN_CASCADE_FIXIT=1 (+ CF_MODEL_SMALL/LARGE, model creds, python3/pytest, " +
      "a packed local `openswarm` on PATH) to run. See the file header.",
  );
}
