/**
 * dsh-sweep.ts — Phase-5 acceptance sweep (docs/01): the discrimination set
 * (run-2 composition: 8 SWE-bench-Verified instances) × 3 arms on the
 * dsh-based `openswarm` CLI bundle, E2B.
 *
 * Arms (all the UNCHANGED legacy CascadeAdapter, bin → the bundle):
 *   mono-small     haiku (Bedrock bearer, via openswarm-llm-anthropic)
 *   mono-large     azureoai/gpt-5.5 (via openswarm-llm-openai)
 *   cascade-tau0.5 haiku → gpt-5.5, composite compile×repro gate (run-2 form)
 * The advisor arm needs `topology critic-loop` CLI surface — deferred.
 *
 * Run (from legacy/):
 *   zsh -c 'source ~/.zshrc; RUN_DSH_SWEEP=1 \
 *     SWE_PYTHON_BIN=/Users/alexngai/GitHub/cluster-server/.venv/bin/python3 \
 *     tsx eval/experiments/dsh-sweep.ts'
 * Env: DSH_SWEEP_ARM=<id,...> filter, DSH_SWEEP_INSTANCES=<id,...> filter,
 * DSH_SWEEP_CONFIG_VERSION (cache namespace, default v1).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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

const SMALL = process.env.DSH_MODEL_SMALL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const LARGE = process.env.DSH_MODEL_LARGE ?? "azureoai/gpt-5.5";
const INSTANCES_DIR = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-subset";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUNDLE = resolve(REPO_ROOT, "packages", "cli", "dist", "openswarm.mjs");

// Run-2 authored-repro confidence protocol (docs/50 §8.1 / §10.4), verbatim.
const REPRO_CMD = "cd /testbed 2>/dev/null; python3 -m pytest repro_test.py -q";
const REPRO_PREFIX =
  "Before changing any source, FIRST write a minimal FAILING test at " +
  "`/testbed/repro_test.py` that reproduces the bug described below (import the affected " +
  "module and assert the CORRECT behaviour). Then edit the source so the test passes; " +
  "verify with `python3 -m pytest repro_test.py -q`. Do NOT delete or weaken the test to " +
  "make it pass.\n\n--- Issue to resolve ---";
const COMPILE_CMD =
  "cd /testbed 2>/dev/null; git diff --name-only -- '*.py' | xargs -r -n1 python3 -m py_compile";

const NODE_TARBALL = "https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.gz";
const SANDBOX_BUNDLE = "/opt/oscli/openswarm.mjs";
const INSTALL: string[] = [
  "command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || (apt-get update && apt-get install -y curl) || true",
  `curl -fsSL ${NODE_TARBALL} -o /tmp/node.tgz || wget -qO /tmp/node.tgz ${NODE_TARBALL}`,
  "mkdir -p /opt/node && tar -xzf /tmp/node.tgz -C /opt/node --strip-components=1",
  "for b in node npm npx; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done",
  "cd /opt/oscli && /opt/node/bin/npm install --no-audit --no-fund node-pty@1.2.0-beta.15 koffi@3.1.6",
  `test -f ${SANDBOX_BUNDLE}`,
  `cd /opt/oscli && /opt/node/bin/node -e "require('node-pty'); require('koffi'); console.log('pty ok')"`,
];

const templateName = (i: SweInstance): string => e2bSafeName(`dsh-${i.instanceId}`);

function providerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["AZURE_API_BASE", "AZURE_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (!env.AWS_REGION) env.AWS_REGION = "us-east-1";
  return env;
}

export async function runDshSweep(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("runDshSweep: set E2B_API_KEY (source ~/.zshrc)");
  let instances = loadSweInstances(INSTANCES_DIR);
  const instanceFilter = process.env.DSH_SWEEP_INSTANCES?.split(",").map((s) => s.trim()).filter(Boolean);
  if (instanceFilter?.length) instances = instances.filter((i) => instanceFilter.includes(i.instanceId));
  if (instances.length === 0) throw new Error(`no instances in ${INSTANCES_DIR}`);
  const env = providerEnv();
  const AGENT_TIMEOUT_MS = Number(process.env.DSH_AGENT_TIMEOUT_MS ?? 2_400_000);
  const bin = `/opt/node/bin/node ${SANDBOX_BUNDLE}`;

  await buildSweTemplates(instances, {
    apiKey,
    nameOf: templateName,
    memoryMB: 8192,
    cpuCount: 2,
    log: (m) => console.error(`[tmpl] ${m}`),
    readyCmd: `test -f ${SANDBOX_BUNDLE} && /opt/node/bin/node --version`,
    installCommands: INSTALL,
    copyFiles: [{ src: BUNDLE, dest: SANDBOX_BUNDLE }],
  });

  const benchmark = sweBenchmark({
    instances,
    imageOf: templateName,
    graderPythonBin: process.env.SWE_PYTHON_BIN ?? "python3",
  });
  const backend = await createBackend("e2b", {
    e2b: { apiKey, user: "root", root: "/testbed", timeoutMs: 2_700_000 },
  });
  const store = new LocalResultStore(".eval-runs");

  const arms: Array<{ arm: Arm; adapter: ExecutionAdapter }> = [
    {
      arm: { id: "dsh-mono-small", label: `dsh mono ${SMALL}`, scaffold: {} },
      adapter: new CascadeAdapter({ tiers: [{ model: SMALL }], tau: 1, env, timeoutMs: AGENT_TIMEOUT_MS, bin }),
    },
    {
      arm: { id: "dsh-mono-large", label: `dsh mono ${LARGE}`, scaffold: {} },
      adapter: new CascadeAdapter({ tiers: [{ model: LARGE }], tau: 1, env, timeoutMs: AGENT_TIMEOUT_MS, bin }),
    },
    {
      arm: { id: "dsh-cascade-tau0.5", label: "dsh cascade τ=0.5", scaffold: {} },
      adapter: new CascadeAdapter({
        tiers: [{ model: SMALL }, { model: LARGE }],
        tau: 0.5,
        escalationCommands: [COMPILE_CMD, REPRO_CMD],
        promptPrefix: REPRO_PREFIX,
        env,
        timeoutMs: AGENT_TIMEOUT_MS,
        bin,
      }),
    },
  ];

  const config = (a: Arm[]): EvalConfig => ({
    runId: "dsh-sweep",
    configVersion: process.env.DSH_SWEEP_CONFIG_VERSION ?? "v1",
    benchmark: "swe",
    arms: a,
    models: [{ name: "cascade" }],
    seeds: [1],
    backend: "e2b",
    concurrency: { cells: 2, modelConnections: 2 },
    output: { dir: ".eval-runs", trace: true },
  });

  const armIds = process.env.DSH_SWEEP_ARM
    ? process.env.DSH_SWEEP_ARM.split(",").map((s) => s.trim()).filter(Boolean)
    : arms.map((a) => a.arm.id);
  const all: Awaited<ReturnType<typeof runEval>> = [];
  for (const { arm, adapter } of arms) {
    if (!armIds.includes(arm.id)) continue;
    console.error(`[dsh-sweep] === arm ${arm.id} ===`);
    all.push(...(await runEval(config([arm]), { benchmark, adapter, backend, store })));
  }

  console.log(renderMarkdownReport(buildReport(all, config(arms.map((a) => a.arm)), { baselineArmId: "dsh-mono-large" })));
  for (const cell of all) {
    const meta = (cell.metadata as any)?.cascade ?? {};
    console.error(
      `[dsh-sweep] ${(cell as any).taskId ?? (cell as any).task} arm-cell full=${(cell.score as any)?.full} tokens=${cell.usage?.totalTokens} esc=${meta.escalations ?? "-"} exit=${meta.exitCode}`,
    );
  }
}

if (process.env.RUN_DSH_SWEEP) {
  await runDshSweep();
} else {
  console.error("set RUN_DSH_SWEEP=1 to run");
}
