/**
 * h1-single-vs-team.ts — H1 negative control (docs/45 §6).
 *
 * H1: a HOMOGENEOUS Claude team is ≤ a single long-lived Claude agent on quality, at higher cost —
 * reproducing the "Strong Single-Agent Baseline" result (arXiv 2601.12307) on swarm-harness. Both arms
 * run ONE model on the SAME SWE-bench subset over E2B; the only difference is whether the agent has the
 * team-spawn tools (eval/harness/swarm-modes.ts). `buildReport` renders the paired single-vs-team delta.
 *
 * Run (Path A is runnable once configured):
 *   eval/scripts/pack-local-harness.sh                       # only if HARNESS=local
 *   eval/scripts/prep-swe-subset.sh <id…>                    # writes eval/.artifacts/swe-instances/*.json
 *   RUN_H1=1 E2B_API_KEY=… [HARNESS=local] bun eval/experiments/h1-single-vs-team.ts
 *
 * E2B SAFETY (shared account): we never enumerate/kill foreign sandboxes — the backend kills only the
 * sandbox it creates. We also NAMESPACE our templates (`sh-h1-<id>`) so we never overwrite the shared
 * `swe-<id>` templates, keep `skipCache` off, and bound concurrency.
 */
import {
  runEval,
  buildReport,
  renderMarkdownReport,
  createBackend,
  LocalResultStore,
  sweBenchmark,
  swarmHarness,
  buildSweTemplates,
  e2bSafeName,
  loadSweInstances,
  type EvalConfig,
  type ModelRef,
  type Harness,
  type SweInstance,
  type Arm,
} from "swarmkit-eval";
import { H1_ARMS } from "../harness/swarm-modes.js";
import { sandboxInstallLocalHarness, LOCAL_HARNESS_TARBALL, LOCAL_SKILLTREE_TARBALL } from "../harness/local.js";

/** One Claude model, held constant — H1 isolates topology, not model diversity (that's H2).
 *  Bedrock inference-profile id (the agent runs under CLAUDE_CODE_USE_BEDROCK). Override with H1_MODEL. */
const H1_MODEL = process.env.H1_MODEL ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const H1_MODELS: ModelRef[] = [{ name: H1_MODEL }];
export const H1_SEEDS = [1, 2, 3];
const INSTANCES_DIR = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-instances";

/** Namespaced template name — keeps our builds off the shared `swe-<id>` templates. */
const h1TemplateName = (i: SweInstance): string => e2bSafeName(`sh-h1-${i.instanceId}`);

/**
 * Bedrock-direct auth for the in-sandbox agent (docs/45: sandbox auth = Bedrock). swarm-harness routes
 * `claude-sonnet-4-6` → Claude Agent SDK, whose Bedrock mode maps the model. E2B account secrets may
 * already inject AWS creds into the sandbox; we set the mode + region and forward any creds present in
 * OUR env (read at runtime — never hardcoded; secrets never printed).
 */
function bedrockEnv(): Record<string, string> {
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

/** Cost-control knobs for a validation run: H1_INSTANCE_LIMIT=1 H1_ARM=single H1_SEEDS=1 → one cell. */
function sized<T>(xs: readonly T[], n?: number): T[] {
  return n && n > 0 ? xs.slice(0, n) : [...xs];
}

function h1Config(arms: Arm[], seeds: number[]): EvalConfig {
  return {
    runId: "h1",
    configVersion: "v0",
    benchmark: "swe",
    arms,
    models: H1_MODELS,
    seeds,
    backend: "e2b",
    concurrency: { cells: 2, modelConnections: 2 }, // bounded — good neighbor on the shared E2B account
    output: { dir: ".eval-runs", trace: true },
  };
}

export async function runH1(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("runH1: set E2B_API_KEY in env (source ~/.zshrc; ~/.e2b is the CLI token only)");
  }
  const local = process.env.HARNESS === "local";
  // 20-min agent command timeout (default 15) for hard instances; still < the 30-min sandbox lifetime,
  // leaving headroom for grading. A genuine timeout is now scored as a failure, not a batch crash.
  const harness: Harness = swarmHarness({ env: bedrockEnv(), timeoutMs: 1_200_000 });

  const limit = process.env.H1_INSTANCE_LIMIT ? Number(process.env.H1_INSTANCE_LIMIT) : undefined;
  const instances = sized(loadSweInstances(INSTANCES_DIR), limit);
  if (instances.length === 0) {
    throw new Error(`runH1: no instances in ${INSTANCES_DIR} — run eval/scripts/prep-swe-subset.sh`);
  }
  const arms = process.env.H1_ARM ? H1_ARMS.filter((a) => a.id === process.env.H1_ARM) : H1_ARMS;
  const seeds = process.env.H1_SEEDS ? process.env.H1_SEEDS.split(",").map((s) => Number(s.trim())) : H1_SEEDS;

  // Build per-instance templates ONCE (shared by both arms), server-side — NO local Docker pull.
  // HARNESS=local stages our packed tarball into the template (no publishing); else install published npm.
  const SANDBOX_TGZ = "/opt/swarm-harness-local.tgz";
  const SANDBOX_ST = "/opt/skill-tree-local.tgz"; // unpublished sibling dep, co-installed
  // swarm-harness has a heavy dep tree (opentui/solid/ai-sdk) — the default E2B build memory OOM-kills
  // `npm i -g`. Give the build headroom (override with H1_BUILD_MEM).
  await buildSweTemplates(instances, {
    apiKey,
    nameOf: h1TemplateName, // ISOLATION: don't clobber shared `swe-<id>` templates
    memoryMB: process.env.H1_BUILD_MEM ? Number(process.env.H1_BUILD_MEM) : 8192,
    cpuCount: 2,
    log: (m) => console.error(`[tmpl] ${m}`),
    // Probe swarm-harness (NOT the default `claude` ready cmd — claude isn't installed here).
    readyCmd: harness.readyCmd ?? "/opt/node/bin/swarm-harness --version",
    installCommands: local
      ? sandboxInstallLocalHarness(SANDBOX_TGZ, [SANDBOX_ST])
      : harness.templateInstall,
    ...(local
      ? {
          copyFiles: [
            { src: LOCAL_SKILLTREE_TARBALL, dest: SANDBOX_ST },
            { src: LOCAL_HARNESS_TARBALL, dest: SANDBOX_TGZ },
          ],
        }
      : {}),
  });

  // django/sympy use unittest (not pytest), so the default log parser can't score them — use the
  // FAITHFUL swebench `get_eval_report` grader via a swebench-equipped python (override with SWE_PYTHON_BIN).
  const benchmark = sweBenchmark({
    instances,
    imageOf: h1TemplateName,
    graderPythonBin: process.env.SWE_PYTHON_BIN ?? "python3",
  });
  // 30-min sandbox lifetime — the default 5 min is shorter than long agent runs (e.g. sympy/sklearn),
  // which otherwise get killed mid-run ("sandbox reached its end of life").
  const backend = await createBackend("e2b", {
    e2b: { apiKey, user: "root", root: "/testbed", timeoutMs: 1_800_000 },
  });
  const store = new LocalResultStore(".eval-runs");
  const config = h1Config(arms, seeds);

  const results = await runEval(config, { benchmark, adapter: harness.adapter, backend, store });

  // `single` is the baseline; the report's "Comparisons (paired vs baseline)" row IS the H1 verdict.
  console.log(renderMarkdownReport(buildReport(results, config, { baselineArmId: "single" })));
  console.error(`[h1] ${results.length} cells over ${instances.length} instances × ${arms.length} arms × ${seeds.length} seeds.`);
}

if (process.env.RUN_H1) {
  await runH1();
} else {
  console.error("[h1] dry: set RUN_H1=1 (+ E2B_API_KEY, prepped SWE_INSTANCES_DIR) to run. See file header.");
}
