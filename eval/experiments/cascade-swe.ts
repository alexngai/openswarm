/**
 * cascade-swe.ts — Stage 1 (docs/51 §7): the heterogeneous cost cascade on
 * SWE-bench-Verified + E2B — the first UNSATURATED, imperfect-signal run.
 *
 * Tiers (cross-provider heterogeneity): small = haiku (Bedrock), large = gpt-5.5
 * (Azure). Confidence = AUTHORED-REPRO (docs/51 §9): each tier first writes a
 * FAILING test at /testbed/repro_test.py reproducing the bug, then fixes; the
 * topology runs `python3 -m pytest repro_test.py -q` in the workspace → pass-rate →
 * the escalation gate. VISIBLE-only (the agent authors the test from the public
 * problem statement) — never the held-out FAIL_TO_PASS scoring tests (docs/50 §8.1).
 * RO4 = does that repro confidence predict the real (SweGrader) outcome?
 *
 * Arms (all one CascadeAdapter): mono-small, mono-large, cascade-tau<τ>. The
 * held-out SweGrader scores the finished workspace as usual.
 *
 * Run (source ~/.zshrc for E2B + Bedrock + Azure creds; HARNESS=local + packed CLI):
 *   npm run build && bash eval/scripts/pack-local-harness.sh
 *   bash eval/scripts/prep-swe-subset.sh <instance-ids…>
 *   RUN_CASCADE_SWE=1 HARNESS=local SWE_INSTANCES_DIR=eval/.artifacts/swe-subset \
 *     SWE_PYTHON_BIN=<swebench-python> tsx eval/experiments/cascade-swe.ts
 */
import {
  runEval,
  buildReport,
  renderMarkdownReport,
  createBackend,
  LocalResultStore,
  sweBenchmark,
  buildSweTemplates,
  e2bSafeName,
  loadSweInstances,
  type EvalConfig,
  type Arm,
  type SweInstance,
  type ExecutionAdapter,
} from "swarmkit-eval";
import { CascadeAdapter } from "../harness/cascade-adapter.js";
import { CriticLoopAdapter } from "../harness/critic-loop-adapter.js";
import { sandboxInstallLocalHarness, LOCAL_HARNESS_TARBALL, LOCAL_SKILLTREE_TARBALL } from "../harness/local.js";

const SMALL = process.env.CS_MODEL_SMALL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const LARGE = process.env.CS_MODEL_LARGE ?? "azureoai/gpt-5.5";
const TAUS = (process.env.CS_TAUS ?? "0.5").split(",").map((s) => Number(s.trim()));
const SEEDS = (process.env.CS_SEEDS ?? "1").split(",").map((s) => Number(s.trim()));
/** advise-don't-redo arm (docs/50 §10.4): executor↔critic round cap. Low bounds cost. */
const ADVISOR_ITERS = Number(process.env.CS_ADVISOR_ITERS ?? 3);
// The sandbox `openswarm` launcher prefers a STALE published platform binary (no `cascade`);
// invoke the installed dist/cli.js directly (its dist IS current). $(…) is evaluated by the
// sandbox's `bash -c`. Override with CS_BIN if the global path differs.
const BIN = process.env.CS_BIN ?? `node "$(npm root -g)/openswarm/dist/cli.js"`;
const INSTANCES_DIR = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-subset";

/** Authored-repro confidence: run the tier's own reproduction test (visible-only). */
const REPRO_CMD = "cd /testbed 2>/dev/null; python3 -m pytest repro_test.py -q";
const REPRO_PREFIX =
  "Before changing any source, FIRST write a minimal FAILING test at " +
  "`/testbed/repro_test.py` that reproduces the bug described below (import the affected " +
  "module and assert the CORRECT behaviour). Then edit the source so the test passes; " +
  "verify with `python3 -m pytest repro_test.py -q`. Do NOT delete or weaken the test to " +
  "make it pass.\n\n--- Issue to resolve ---";

/** Bedrock (haiku) + Azure (gpt-5.5) creds forwarded to the sandbox for the cross-provider cascade. */
function providerEnv(): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_USE_BEDROCK: "1", OPENSWARM_TOOL_USE_WARMUP: "1" };
  for (const k of [
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AZURE_API_BASE", "AZURE_OPENAI_ENDPOINT", "AZURE_API_KEY",
    "AZURE_OPENAI_API_KEY", "AZURE_API_VERSION", "AZURE_OPENAI_API_VERSION",
  ]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (!env.AWS_REGION && !env.AWS_DEFAULT_REGION) env.AWS_REGION = "us-east-1";
  if (!env.AZURE_OPENAI_ENDPOINT && env.AZURE_API_BASE) env.AZURE_OPENAI_ENDPOINT = env.AZURE_API_BASE;
  if (!env.AZURE_OPENAI_API_VERSION && env.AZURE_API_VERSION) env.AZURE_OPENAI_API_VERSION = env.AZURE_API_VERSION;
  return env;
}

/** Namespaced template — never clobber the shared `swe-<id>` templates (docs/47 E2B etiquette). */
const templateName = (i: SweInstance): string => e2bSafeName(`cs-${i.instanceId}`);

function config(arms: Arm[]): EvalConfig {
  return {
    runId: "cascade-swe",
    configVersion: process.env.CS_CONFIG_VERSION ?? "v0",
    benchmark: "swe",
    arms,
    models: [{ name: "cascade" }], // model axis unused — tiers live in the adapter
    seeds: SEEDS,
    backend: "e2b",
    concurrency: {
      cells: process.env.CS_CONCURRENCY ? Number(process.env.CS_CONCURRENCY) : 2,
      modelConnections: process.env.CS_CONCURRENCY ? Number(process.env.CS_CONCURRENCY) : 2,
    },
    output: { dir: ".eval-runs", trace: true },
  };
}

export async function runCascadeSwe(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("runCascadeSwe: set E2B_API_KEY (source ~/.zshrc)");
  if (process.env.HARNESS !== "local") {
    throw new Error(
      "runCascadeSwe: HARNESS=local required — the cascade topology only exists in the working-tree CLI; " +
        "run `npm run build && bash eval/scripts/pack-local-harness.sh` first.",
    );
  }
  const env = providerEnv();
  const AGENT_TIMEOUT_MS = Number(process.env.CS_AGENT_TIMEOUT_MS ?? 1_200_000);
  const SANDBOX_TIMEOUT_MS = Number(process.env.CS_SANDBOX_TIMEOUT_MS ?? 1_800_000);

  const instances = loadSweInstances(INSTANCES_DIR);
  if (instances.length === 0) {
    throw new Error(`runCascadeSwe: no instances in ${INSTANCES_DIR} — run eval/scripts/prep-swe-subset.sh`);
  }

  const SANDBOX_TGZ = "/opt/openswarm-local.tgz";
  const SANDBOX_ST = "/opt/skill-tree-local.tgz";
  await buildSweTemplates(instances, {
    apiKey,
    nameOf: templateName,
    memoryMB: process.env.CS_BUILD_MEM ? Number(process.env.CS_BUILD_MEM) : 8192,
    cpuCount: 2,
    log: (m) => console.error(`[tmpl] ${m}`),
    readyCmd: "/opt/node/bin/openswarm --version",
    installCommands: sandboxInstallLocalHarness(SANDBOX_TGZ, [SANDBOX_ST]),
    copyFiles: [
      { src: LOCAL_SKILLTREE_TARBALL, dest: SANDBOX_ST },
      { src: LOCAL_HARNESS_TARBALL, dest: SANDBOX_TGZ },
    ],
  });

  const benchmark = sweBenchmark({
    instances,
    imageOf: templateName,
    graderPythonBin: process.env.SWE_PYTHON_BIN ?? "python3",
  });
  const backend = await createBackend("e2b", {
    e2b: { apiKey, user: "root", root: "/testbed", timeoutMs: SANDBOX_TIMEOUT_MS },
  });
  const store = new LocalResultStore(".eval-runs");

  const arms: Array<{ arm: Arm; adapter: ExecutionAdapter }> = [
    { arm: { id: "mono-small", label: `mono ${SMALL}`, scaffold: {} },
      adapter: new CascadeAdapter({ tiers: [{ model: SMALL }], tau: 1, env, timeoutMs: AGENT_TIMEOUT_MS, bin: BIN }) },
    { arm: { id: "mono-large", label: `mono ${LARGE}`, scaffold: {} },
      adapter: new CascadeAdapter({ tiers: [{ model: LARGE }], tau: 1, env, timeoutMs: AGENT_TIMEOUT_MS, bin: BIN }) },
    ...TAUS.map((tau) => ({
      arm: { id: `cascade-tau${tau}`, label: `cascade τ=${tau}`, scaffold: {} } as Arm,
      adapter: new CascadeAdapter({
        tiers: [{ model: SMALL }, { model: LARGE }],
        tau,
        escalationCommand: REPRO_CMD,
        promptPrefix: REPRO_PREFIX,
        env,
        timeoutMs: AGENT_TIMEOUT_MS,
        bin: BIN,
      }),
    })),
    // advise-don't-redo (docs/50 §10.4): cheap executor + bounded read-only critic
    // (reviewer role). The strong model advises, never authors — the Advisor-tool
    // economics, reproduced cross-provider via the critic-loop topology.
    {
      arm: { id: "advisor", label: `advisor exec=${SMALL} critic=${LARGE}`, scaffold: {} },
      adapter: new CriticLoopAdapter({
        executorModel: SMALL,
        criticModel: LARGE,
        maxIterations: ADVISOR_ITERS,
        env,
        timeoutMs: AGENT_TIMEOUT_MS,
        bin: BIN,
      }),
    },
  ];

  const armIds = process.env.CS_ARM ? [process.env.CS_ARM] : arms.map((a) => a.arm.id);
  const all: Awaited<ReturnType<typeof runEval>> = [];
  for (const { arm, adapter } of arms) {
    if (!armIds.includes(arm.id)) continue;
    all.push(...(await runEval(config([arm]), { benchmark, adapter, backend, store })));
  }

  console.log(renderMarkdownReport(buildReport(all, config(arms.map((a) => a.arm)), { baselineArmId: "mono-large" })));
  console.error(
    `[cascade-swe] ${all.length} cells over ${instances.length} instances × ${arms.length} arms × ${SEEDS.length} seeds. ` +
      `Analyse per-tier cost + τ-sweep: tsx eval/analysis/cost-frontier.ts`,
  );
}

if (process.env.RUN_CASCADE_SWE) {
  await runCascadeSwe();
} else {
  console.error(
    "[cascade-swe] dry: set RUN_CASCADE_SWE=1 HARNESS=local (+ E2B/Bedrock/Azure creds, SWE_INSTANCES_DIR, " +
      "packed local CLI) to run. See the file header.",
  );
}
