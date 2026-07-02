/**
 * h1-single-vs-team.ts — H1 negative control (docs/45 §6).
 *
 * H1: a HOMOGENEOUS Claude team is ≤ a single long-lived Claude agent on quality, at higher cost —
 * reproducing the "Strong Single-Agent Baseline" result (arXiv 2601.12307) on openswarm. Both arms
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
  openSwarm,
  buildSweTemplates,
  e2bSafeName,
  loadSweInstances,
  type EvalConfig,
  type ModelRef,
  type Harness,
  type SweInstance,
  type Arm,
} from "swarmkit-eval";
import { SwarmCoordinatorAdapter } from "../harness/swarm-coordinator-adapter.js";
import { sandboxInstallLocalHarness, LOCAL_HARNESS_TARBALL, LOCAL_SKILLTREE_TARBALL } from "../harness/local.js";

/** Provider for the in-sandbox agent, held constant within a run (H1 isolates topology, not model).
 *  "bedrock" (default) = Claude Sonnet-4.5 via CLAUDE_CODE_USE_BEDROCK; "azure" = GPT-4.1 via the
 *  azureoai/ DIRECT transport (cross-family replication). Override the id with H1_MODEL. */
const H1_PROVIDER = (process.env.H1_PROVIDER ?? "bedrock").toLowerCase();
const H1_MODEL =
  process.env.H1_MODEL ??
  // gpt-5.5 (reasoning) engages the agentic tool loop on open-ended SWE tasks; gpt-4.1 plans in text
  // and stops, so it's unsuitable for the agentic comparison.
  (H1_PROVIDER === "azure" ? "azureoai/gpt-5.5" : "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
export const H1_MODELS: ModelRef[] = [{ name: H1_MODEL }];
export const H1_SEEDS = [1, 2, 3];
const INSTANCES_DIR = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-instances";

/** Namespaced template name — keeps our builds off the shared `swe-<id>` templates. */
const h1TemplateName = (i: SweInstance): string => e2bSafeName(`sh-h1-${i.instanceId}`);

/**
 * Bedrock-direct auth for the in-sandbox agent (docs/45: sandbox auth = Bedrock). openswarm routes
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

/** Azure-direct auth — the `azureoai/` transport calls Azure OpenAI directly from the sandbox.
 *  Non-Claude models (gpt-4.1) plan in text and stop without acting on open-ended SWE tasks; the
 *  tool-use warmup nudges exact tool names + a proactive first bash call so the agentic loop engages.
 *  (A non-Claude-specific scaffolding addition — note as a comparison caveat.) */
function azureEnv(): Record<string, string> {
  const env: Record<string, string> = { OPENSWARM_TOOL_USE_WARMUP: "1" };
  for (const k of ["AZURE_API_BASE", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_VERSION"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  if (!env.AZURE_OPENAI_API_VERSION) env.AZURE_OPENAI_API_VERSION = "2024-08-01-preview";
  return env;
}

/** The in-sandbox agent env for the selected provider (H1_PROVIDER). */
function providerEnv(): Record<string, string> {
  return H1_PROVIDER === "azure" ? azureEnv() : bedrockEnv();
}

/** Cost-control knobs for a validation run: H1_INSTANCE_LIMIT=1 H1_ARM=single H1_SEEDS=1 → one cell. */
function sized<T>(xs: readonly T[], n?: number): T[] {
  return n && n > 0 ? xs.slice(0, n) : [...xs];
}

function h1Config(arms: Arm[], seeds: number[]): EvalConfig {
  return {
    runId: "h1",
    // Verified-completion runs get a distinct config version so their cells don't collide with the
    // non-verified baseline in the content-addressed cache (keeps both for comparison).
    configVersion:
      process.env.H1_CONFIG_VERSION ??
      (process.env.H1_VERIFY_ROUNDS ? `v0-vc${process.env.H1_VERIFY_ROUNDS}` : "v0"),
    benchmark: "swe",
    arms,
    models: H1_MODELS,
    seeds,
    backend: "e2b",
    // Bounded — good neighbor on the shared E2B account; H1_CONCURRENCY throttles Azure rate limits
    // (each team cell fans to 3–4 concurrent model calls, so lower this for the gpt-5.5 team arms).
    concurrency: {
      cells: process.env.H1_CONCURRENCY ? Number(process.env.H1_CONCURRENCY) : 2,
      modelConnections: process.env.H1_CONCURRENCY ? Number(process.env.H1_CONCURRENCY) : 2,
    },
    output: { dir: ".eval-runs", trace: true },
  };
}

// Heterogeneous team: a lead architect that orchestrates specialized roles, including a DEDICATED
// verification engineer (targets MAST FC3 "verification", ~21% of multi-agent failures). Same model as
// single/homo — this isolates ROLE/PROMPT heterogeneity + verification capacity (model diversity is a
// later ablation). Note: 4 agents vs homo's 3, so size is part of the treatment (size-matched ablation TBD).
const HETERO_PREAMBLE =
  "You are the technical lead of a specialist team resolving a software issue. Investigate first: " +
  "reproduce the problem, locate its root cause in the codebase, and form a minimal, precise fix plan. " +
  "Delegate implementation to the executor, verification to the resolver, and adversarial review to the " +
  "reviewer. Integrate their work and resolve disagreements. Do NOT declare the task complete until the " +
  "resolver confirms the fix passes the relevant tests with no regressions AND the reviewer has no " +
  "unaddressed correctness concerns. The issue to resolve:";
const HETERO_ROSTER = [
  { role: "executor", prompt: "Senior implementation engineer: implement the MINIMAL, correct code change for the planned fix, following the repository's existing conventions. Do not refactor unrelated code or over-engineer. Report precisely what you changed and why." },
  { role: "resolver", prompt: "Verification engineer: reproduce the reported bug, run the relevant existing tests, and verify the proposed fix resolves the issue with NO regressions. Add a focused test if coverage is missing. Report exact pass/fail evidence; if anything fails, name it and explain." },
  { role: "reviewer", prompt: "Adversarial reviewer: hunt for correctness bugs, missed edge cases, and regressions in the change. Be skeptical and demand evidence the fix is complete and minimal. Approve only when you cannot find a defect." },
];

export async function runH1(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("runH1: set E2B_API_KEY in env (source ~/.zshrc; ~/.e2b is the CLI token only)");
  }
  const local = process.env.HARNESS === "local";
  // Timeouts (env-overridable for harder instances). Keep agent timeouts < the sandbox lifetime so
  // grading has headroom; a genuine timeout is scored as a failure, not a batch crash.
  const AGENT_TIMEOUT_MS = process.env.H1_AGENT_TIMEOUT_MS ? Number(process.env.H1_AGENT_TIMEOUT_MS) : 1_200_000;
  const TEAM_TIMEOUT_MS = process.env.H1_TEAM_TIMEOUT_MS ? Number(process.env.H1_TEAM_TIMEOUT_MS) : 1_500_000;
  const SANDBOX_TIMEOUT_MS = process.env.H1_SANDBOX_TIMEOUT_MS ? Number(process.env.H1_SANDBOX_TIMEOUT_MS) : 1_800_000;
  // Coordinator verified-completion rounds (counters premature termination). Off unless H1_VERIFY_ROUNDS set.
  const VERIFY_ROUNDS = process.env.H1_VERIFY_ROUNDS ? Number(process.env.H1_VERIFY_ROUNDS) : undefined;
  const harness: Harness = openSwarm({ env: providerEnv(), timeoutMs: AGENT_TIMEOUT_MS });

  const limit = process.env.H1_INSTANCE_LIMIT ? Number(process.env.H1_INSTANCE_LIMIT) : undefined;
  const instances = sized(loadSweInstances(INSTANCES_DIR), limit);
  if (instances.length === 0) {
    throw new Error(`runH1: no instances in ${INSTANCES_DIR} — run eval/scripts/prep-swe-subset.sh`);
  }
  const armIds = process.env.H1_ARM ? [process.env.H1_ARM] : ["single", "team", "hetero"];
  const seeds = process.env.H1_SEEDS ? process.env.H1_SEEDS.split(",").map((s) => Number(s.trim())) : H1_SEEDS;

  // Build per-instance templates ONCE (shared by both arms), server-side — NO local Docker pull.
  // HARNESS=local stages our packed tarball into the template (no publishing); else install published npm.
  const SANDBOX_TGZ = "/opt/openswarm-local.tgz";
  const SANDBOX_ST = "/opt/skill-tree-local.tgz"; // unpublished sibling dep, co-installed
  // openswarm has a heavy dep tree (opentui/solid/ai-sdk) — the default E2B build memory OOM-kills
  // `npm i -g`. Give the build headroom (override with H1_BUILD_MEM).
  await buildSweTemplates(instances, {
    apiKey,
    nameOf: h1TemplateName, // ISOLATION: don't clobber shared `swe-<id>` templates
    memoryMB: process.env.H1_BUILD_MEM ? Number(process.env.H1_BUILD_MEM) : 8192,
    cpuCount: 2,
    log: (m) => console.error(`[tmpl] ${m}`),
    // Probe openswarm (NOT the default `claude` ready cmd — claude isn't installed here).
    readyCmd: harness.readyCmd ?? "/opt/node/bin/openswarm --version",
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
    e2b: { apiKey, user: "root", root: "/testbed", timeoutMs: SANDBOX_TIMEOUT_MS },
  });
  const store = new LocalResultStore(".eval-runs");

  // `single` = one openswarm agent (generic CLI adapter). `team` = a real coordinator team
  // (architect + executor + reviewer via `topology coordinator`, the SwarmCoordinatorAdapter). Different
  // adapters → separate runEval passes over the SAME templates/benchmark/backend; buildReport's paired
  // row is the H1 single-vs-team verdict.
  const SINGLE: Arm = { id: "single", label: "single-agent", scaffold: {} };
  const TEAM: Arm = { id: "team", label: "homogeneous team", scaffold: {} };
  const HETERO: Arm = { id: "hetero", label: "heterogeneous team", scaffold: {} };
  const allResults: Awaited<ReturnType<typeof runEval>> = [];

  if (armIds.includes("single")) {
    allResults.push(
      ...(await runEval(h1Config([SINGLE], seeds), { benchmark, adapter: harness.adapter, backend, store })),
    );
  }
  if (armIds.includes("team")) {
    const teamAdapter = new SwarmCoordinatorAdapter({
      env: providerEnv(),
      defaultModel: H1_MODEL,
      timeoutMs: TEAM_TIMEOUT_MS, // a 3-agent team is slower; keep < the sandbox lifetime
      verifiedCompletionRounds: VERIFY_ROUNDS,
    });
    allResults.push(
      ...(await runEval(h1Config([TEAM], seeds), { benchmark, adapter: teamAdapter, backend, store })),
    );
  }
  if (armIds.includes("hetero")) {
    const heteroAdapter = new SwarmCoordinatorAdapter({
      env: providerEnv(),
      defaultModel: H1_MODEL,
      timeoutMs: TEAM_TIMEOUT_MS,
      name: "h1-hetero",
      roster: HETERO_ROSTER,
      architectPreamble: HETERO_PREAMBLE,
      verifiedCompletionRounds: VERIFY_ROUNDS,
    });
    allResults.push(
      ...(await runEval(h1Config([HETERO], seeds), { benchmark, adapter: heteroAdapter, backend, store })),
    );
  }

  const reportCfg = h1Config([SINGLE, TEAM, HETERO], seeds);
  console.log(renderMarkdownReport(buildReport(allResults, reportCfg, { baselineArmId: "single" })));
  console.error(`[h1] ${allResults.length} cells over ${instances.length} instances × ${armIds.length} arm(s) × ${seeds.length} seed(s).`);
}

if (process.env.RUN_H1) {
  await runH1();
} else {
  console.error("[h1] dry: set RUN_H1=1 (+ E2B_API_KEY, prepped SWE_INSTANCES_DIR) to run. See file header.");
}
