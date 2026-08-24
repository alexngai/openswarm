/**
 * dsh-smoke.ts — Phase-5 smoke (new-stack docs/01): ONE SWE-bench instance ×
 * ONE mono-azure arm through the dsh-based `openswarm` CLI bundle, on E2B.
 *
 * The CascadeAdapter is UNCHANGED — the new CLI implements the legacy
 * `topology cascade` contract, so only `bin` differs. The template bakes
 * node + the single-file bundle + node-pty (the one native dep, resolved via
 * NODE_PATH from /opt/node's global modules).
 *
 * Run (from the legacy/ directory):
 *   zsh -c 'source ~/.zshrc; RUN_DSH_SMOKE=1 \
 *     SWE_PYTHON_BIN=/Users/alexngai/GitHub/cluster-server/.venv/bin/python3 \
 *     tsx eval/experiments/dsh-smoke.ts'
 * Env: DSH_SMOKE_INSTANCE (default django__django-11179), DSH_SMOKE_MODEL
 * (default azureoai/gpt-5.5), SWE_INSTANCES_DIR.
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
} from "swarmkit-eval";
import { CascadeAdapter } from "../harness/cascade-adapter.js";

const MODEL = process.env.DSH_SMOKE_MODEL ?? "azureoai/gpt-5.5";
const INSTANCE = process.env.DSH_SMOKE_INSTANCE ?? "django__django-11179";
const INSTANCES_DIR = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-subset";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The Phase-5 single-file bundle (esbuild; node-pty external). */
const BUNDLE = resolve(REPO_ROOT, "packages", "cli", "dist", "openswarm.mjs");

// v22.15+ required: dsh session persistence imports node:zlib zstd APIs.
const NODE_TARBALL = "https://nodejs.org/dist/v22.21.1/node-v22.21.1-linux-x64.tar.gz";
const SANDBOX_BUNDLE = "/opt/oscli/openswarm.mjs";
/** node + the copied bundle + node-pty BESIDE the bundle: the bundle is ESM,
 *  and ESM import resolution walks node_modules from the importing file —
 *  NODE_PATH is a CJS-only mechanism and is ignored. */
const INSTALL: string[] = [
  "command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || (apt-get update && apt-get install -y curl) || true",
  `curl -fsSL ${NODE_TARBALL} -o /tmp/node.tgz || wget -qO /tmp/node.tgz ${NODE_TARBALL}`,
  "mkdir -p /opt/node && tar -xzf /tmp/node.tgz -C /opt/node --strip-components=1",
  "for b in node npm npx; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done",
  "cd /opt/oscli && /opt/node/bin/npm install --no-audit --no-fund node-pty@1.2.0-beta.15",
  `test -f ${SANDBOX_BUNDLE}`,
  `cd /opt/oscli && /opt/node/bin/node -e "require('node-pty'); console.log('pty ok')"`,
];

const templateName = (i: SweInstance): string => e2bSafeName(`dsh-${i.instanceId}`);

function providerEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["AZURE_API_BASE", "AZURE_API_KEY"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export async function runDshSmoke(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("runDshSmoke: set E2B_API_KEY (source ~/.zshrc)");
  const instances = loadSweInstances(INSTANCES_DIR).filter((i) => i.instanceId === INSTANCE);
  if (instances.length === 0) throw new Error(`instance ${INSTANCE} not in ${INSTANCES_DIR}`);
  const env = providerEnv();

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

  const arm: Arm = { id: "dsh-mono-large", label: `dsh mono ${MODEL}`, scaffold: {} };
  const adapter = new CascadeAdapter({
    tiers: [{ model: MODEL }],
    tau: 1,
    env,
    timeoutMs: 1_800_000,
    bin: `/opt/node/bin/node ${SANDBOX_BUNDLE}`,
  });

  const config: EvalConfig = {
    runId: "dsh-smoke",
    configVersion: process.env.DSH_SMOKE_CONFIG_VERSION ?? "v1",
    benchmark: "swe",
    arms: [arm],
    models: [{ name: "cascade" }],
    seeds: [1],
    backend: "e2b",
    concurrency: { cells: 1, modelConnections: 1 },
    output: { dir: ".eval-runs", trace: true },
  };

  const results = await runEval(config, { benchmark, adapter, backend, store });
  console.log(renderMarkdownReport(buildReport(results, config, { baselineArmId: "dsh-mono-large" })));
  for (const cell of results) {
    console.error(
      `[dsh-smoke] ${cell.task} score=${JSON.stringify(cell.score)} tokens=${cell.usage?.totalTokens} meta=${JSON.stringify(cell.metadata ?? {}).slice(0, 400)}`,
    );
  }
}

if (process.env.RUN_DSH_SMOKE) {
  await runDshSmoke();
} else {
  console.error("set RUN_DSH_SMOKE=1 to run");
}
