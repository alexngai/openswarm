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
 *
 * BACKEND=docker (self-hosted x86 box, no E2B): same recipe minus E2B_API_KEY; the per-instance
 * bake runs locally via `docker build` (eval/scripts/bake-swe-docker-image.sh) instead of E2B's
 * server-side buildSweTemplates. Bedrock/Azure creds are forwarded into each container. The default
 * (BACKEND unset ⇒ e2b) path is unchanged.
 */
import { execFileSync } from "node:child_process";
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
  swebenchImageName,
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
/** Compile-gate (docs/50 §10.4 step 3): every changed .py must still byte-compile. Exit≠0 ⇒
 *  confidence 0 (escalate). Cheap syntax guard, composited weakest-link with the repro. */
const COMPILE_CMD =
  "cd /testbed 2>/dev/null; git diff --name-only -- '*.py' | xargs -r -n1 python3 -m py_compile";

/** Bedrock (haiku) + Azure (gpt-5.5) creds forwarded to the sandbox for the cross-provider cascade. */
function providerEnv(): Record<string, string> {
  // OPENSWARM_NODE_CLI=1 forces the launcher (bin/openswarm.mjs) to run the freshly
  // built `dist/cli.js` instead of a STALE bun-compiled platform binary. Without it,
  // every sandbox ran old code that predated the usage-capture fixes, so team_usage
  // reported $0/empty regardless of the tarball — the entire heterogeneity study's
  // cost axis was measuring the wrong binary (docs/52).
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    OPENSWARM_TOOL_USE_WARMUP: "1",
    OPENSWARM_NODE_CLI: "1",
  };
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

/**
 * Backend switch (default `e2b` — the E2B path is byte-identical when BACKEND≠docker). `docker` runs
 * the same bake on a self-hosted x86 box: instead of E2B's server-side `buildSweTemplates`, we
 * `docker build` a per-instance image locally (see `bakeDockerImage`) and drive `createBackend("docker")`.
 */
const BACKEND = (process.env.BACKEND ?? "e2b").toLowerCase();

/** Namespaced template — never clobber the shared `swe-<id>` templates (docs/47 E2B etiquette). */
const templateName = (i: SweInstance): string => e2bSafeName(`cs-${i.instanceId}`);

/** The local docker tag the bake produces for an instance (mirrors `templateName`'s namespacing). */
const dockerTag = (i: SweInstance): string => `cs-${e2bSafeName(i.instanceId)}:baked`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BAKE_SCRIPT = resolve(REPO_ROOT, "eval", "scripts", "bake-swe-docker-image.sh");

/**
 * Pre-bake one local docker image reproducing the E2B `installCommands`/`copyFiles`/`readyCmd` bake:
 * FROM the swebench per-instance image (ships no node) → node + the two local tarballs + `openswarm`
 * symlink. Delegates to `eval/scripts/bake-swe-docker-image.sh`, whose RUN steps are copied verbatim
 * from swarmkit-eval `npmCliInstall`. Bake-once (fast N containers) over per-cell initCommands.
 */
function bakeDockerImage(i: SweInstance): void {
  const base = i.image ?? swebenchImageName(i.instanceId);
  const tag = dockerTag(i);
  console.error(`[bake] ${i.instanceId}: FROM ${base} → ${tag}`);
  execFileSync("bash", [BAKE_SCRIPT, i.instanceId, base, tag], {
    stdio: ["ignore", "inherit", "inherit"],
    // The swebench x86_64 images run under emulation on arm64 dev hosts; on x86 EC2 leave unset.
    env: process.env,
  });
}

function config(arms: Arm[]): EvalConfig {
  return {
    runId: "cascade-swe",
    configVersion: process.env.CS_CONFIG_VERSION ?? "v0",
    benchmark: "swe",
    arms,
    models: [{ name: "cascade" }], // model axis unused — tiers live in the adapter
    seeds: SEEDS,
    backend: BACKEND === "docker" ? "docker" : "e2b",
    concurrency: {
      cells: process.env.CS_CONCURRENCY ? Number(process.env.CS_CONCURRENCY) : 2,
      modelConnections: process.env.CS_CONCURRENCY ? Number(process.env.CS_CONCURRENCY) : 2,
    },
    output: { dir: ".eval-runs", trace: true },
  };
}

export async function runCascadeSwe(): Promise<void> {
  const docker = BACKEND === "docker";
  const apiKey = process.env.E2B_API_KEY;
  if (!docker && !apiKey) throw new Error("runCascadeSwe: set E2B_API_KEY (source ~/.zshrc)");
  if (process.env.HARNESS !== "local") {
    throw new Error(
      "runCascadeSwe: HARNESS=local required — the cascade topology only exists in the working-tree CLI; " +
        "run `npm run build && bash eval/scripts/pack-local-harness.sh` first.",
    );
  }
  const env = providerEnv();
  // docs/50 §10.4 step 2: 20-min agent cap lost a successful-but-slow advisor rescue
  // (pytest-6197, exit 124). Raise to 40 min agent / 45 min sandbox; the periodic team_usage
  // flush (team.ts) now also salvages cost from any run that still gets killed.
  const AGENT_TIMEOUT_MS = Number(process.env.CS_AGENT_TIMEOUT_MS ?? 2_400_000);
  const SANDBOX_TIMEOUT_MS = Number(process.env.CS_SANDBOX_TIMEOUT_MS ?? 2_700_000);

  const instances = loadSweInstances(INSTANCES_DIR);
  if (instances.length === 0) {
    throw new Error(`runCascadeSwe: no instances in ${INSTANCES_DIR} — run eval/scripts/prep-swe-subset.sh`);
  }

  if (docker) {
    // Self-hosted x86 path: skip E2B's server-side `buildSweTemplates`; instead `docker build` a
    // per-instance image locally (same node + tarballs + `openswarm` symlink bake). Bake-once so the
    // N containers the eval spins up are cheap. imageOf → the baked tag; the docker backend forwards
    // providerEnv() into every container so the agents' Bedrock/Azure calls work from inside.
    for (const i of instances) bakeDockerImage(i);
  } else {
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
  }

  const benchmark = sweBenchmark({
    instances,
    imageOf: docker ? dockerTag : templateName,
    graderPythonBin: process.env.SWE_PYTHON_BIN ?? "python3",
  });
  const backend = docker
    ? await createBackend("docker", {
        docker: { root: "/testbed", env, execTimeoutMs: SANDBOX_TIMEOUT_MS },
      })
    : await createBackend("e2b", {
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
        // Composite gate (docs/50 §10.4 step 3): escalate unless the fix compiles AND its
        // authored repro passes — weakest-link, so a broken patch can't clear the gate.
        escalationCommands: [COMPILE_CMD, REPRO_CMD],
        promptPrefix: REPRO_PREFIX,
        env,
        timeoutMs: AGENT_TIMEOUT_MS,
        bin: BIN,
      }),
    })),
    // advise-don't-redo (docs/50 §10.4): cheap executor + bounded read-only critic
    // (reviewer role). The strong model advises, never authors — the Advisor-tool
    // economics, reproduced cross-provider via the critic-loop topology. Step 1: the
    // executor authors a repro; when it passes, the loop STOPS on green so the critic
    // can't regress a correct fix (the django-12708 failure) — the critic fires only on red.
    {
      arm: { id: "advisor", label: `advisor exec=${SMALL} critic=${LARGE}`, scaffold: {} },
      adapter: new CriticLoopAdapter({
        executorModel: SMALL,
        criticModel: LARGE,
        maxIterations: ADVISOR_ITERS,
        executorPromptPrefix: REPRO_PREFIX,
        greenCommand: REPRO_CMD,
        env,
        timeoutMs: AGENT_TIMEOUT_MS,
        bin: BIN,
      }),
    },
    // docs/52 Phase B ①a — advisor with RESIDENT dialogue (executor + critic stay alive across
    // rounds via runMore, accumulating context). The A/B vs cold `advisor` isolates the
    // coordination-fidelity effect. Opt-in (CS_RESIDENT=1) so the default run's cost is unchanged.
    ...(process.env.CS_RESIDENT === "1"
      ? [
          {
            arm: {
              id: "advisor-resident",
              label: `advisor-resident exec=${SMALL} critic=${LARGE}`,
              scaffold: {},
            } as Arm,
            adapter: new CriticLoopAdapter({
              executorModel: SMALL,
              criticModel: LARGE,
              maxIterations: ADVISOR_ITERS,
              executorPromptPrefix: REPRO_PREFIX,
              greenCommand: REPRO_CMD,
              residentDialogue: true,
              env,
              timeoutMs: AGENT_TIMEOUT_MS,
              bin: BIN,
            }),
          },
        ]
      : []),
  ];

  // CS_ARM filters to a subset — accepts a single id or a comma list (e.g. a
  // dual mono screen: CS_ARM=mono-small,mono-large). Empty ⇒ all arms.
  const armIds = process.env.CS_ARM
    ? process.env.CS_ARM.split(",").map((s) => s.trim()).filter(Boolean)
    : arms.map((a) => a.arm.id);
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
