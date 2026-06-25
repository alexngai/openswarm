/**
 * fixit.ts — FixIt-N breadth study (single vs specialized team vs equal-budget ensemble).
 *
 * The breadth hypothesis (docs/45): an embarrassingly-parallel task — N independent, individually-trivial
 * bug-fix modules across 4 skill families — should reward a TEAM that fans out over a single long-lived
 * agent, and an equal-budget ENSEMBLE of K independent single agents should recover broad coverage by
 * UNION (different seeds solve disjoint modules). FixIt-N (swarmkit-eval `benchmarks/fixit.ts`) is the
 * controlled substrate: each module is a sealed-test checkpoint, so coverage = passed/total is a clean
 * breadth metric (purer than the TAC-blended S_partial).
 *
 * Runs LOCALLY end-to-end — `InProcessBackend` mkdtemps a workspace per cell, seeds `setup.files`, runs
 * commands via child_process. No E2B/EC2/Modal. Two arms (different adapters → one runEval pass each):
 *   - single : one swarm-harness agent (the generic CLI adapter).
 *   - team   : a SwarmCoordinatorAdapter — an architect that spawns a FAMILY-SPECIALIST roster
 *              (string / numeric / datetime / validation), the specialization treatment.
 * ensemble@K is POST-HOC: union the per-module checkpoints across the first K `single` seeds.
 *
 * Run:
 *   FIXIT_FAKE=1 RUN_FIXIT=1 npx tsx eval/experiments/fixit.ts        # no-spend smoke (2a)
 *   RUN_FIXIT=1 [AWS creds + swarm-harness on PATH] npx tsx eval/experiments/fixit.ts   # real (2b)
 * Without RUN_FIXIT it prints a dry summary (arms / N / seeds / roster) and exits.
 *
 * FAKE mode (FIXIT_FAKE=1): a no-LLM mock adapter writes the GOLDEN fix for a per-arm deterministic
 * fraction of modules (single ~0.55, team ~0.9). The REAL CheckpointGrader then runs the sealed tests →
 * the seeded modules pass, the rest fail → coverage reflects the fraction, exercising the whole
 * matrix→grader→report→ensemble path with zero spend.
 */
import {
  runEval,
  buildReport,
  renderMarkdownReport,
  InProcessBackend,
  LocalResultStore,
  fixitBenchmark,
  fixitGoldenFiles,
  swarmHarness,
  type EvalConfig,
  type Arm,
  type FixitConfig,
  type ExecutionAdapter,
  type PublicCell,
  type RunContext,
  type RawRun,
  type CellResult,
} from "swarmkit-eval";
import { SwarmCoordinatorAdapter } from "../harness/swarm-coordinator-adapter.js";

// ─── Knobs ───────────────────────────────────────────────────────────────────────────────────────
const FIXIT_N = process.env.FIXIT_N ? Number(process.env.FIXIT_N) : 12;
// SEEDS are the K INDEPENDENT ATTEMPT seeds (the eval-matrix seed axis): the ensemble@K unions these
// per-attempt results of the SAME task. The benchmark itself is pinned to a single TASK seed
// (FIXIT_TASK_SEED) so all attempts solve the same N modules — that's what makes a per-module union
// meaningful (different attempts cover disjoint subsets of one fixed module set).
const SEEDS = (process.env.FIXIT_SEEDS ?? "1,2,3,4").split(",").map((s) => Number(s.trim()));
const FIXIT_TASK_SEED = process.env.FIXIT_TASK_SEED ? Number(process.env.FIXIT_TASK_SEED) : 7;
const ARM_IDS = (process.env.FIXIT_ARMS ?? "single,team").split(",").map((s) => s.trim()).filter(Boolean);
const FIXIT_K = process.env.FIXIT_K ? Number(process.env.FIXIT_K) : 4;
const FIXIT_MODEL = process.env.FIXIT_MODEL ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
/** Local swarm-harness CLI (the study runs in-process on this machine — no sandbox install). Both the
 *  single (swarmHarness) and team (SwarmCoordinatorAdapter) adapters accept this `bin` override. */
const FIXIT_HARNESS_BIN =
  process.env.FIXIT_HARNESS_BIN ?? new URL("../../bin/swarm-harness.mjs", import.meta.url).pathname;
const FAKE = process.env.FIXIT_FAKE === "1";
const AGENT_TIMEOUT_MS = process.env.FIXIT_AGENT_TIMEOUT_MS ? Number(process.env.FIXIT_AGENT_TIMEOUT_MS) : 1_200_000;
const CONCURRENCY = process.env.FIXIT_CONCURRENCY ? Number(process.env.FIXIT_CONCURRENCY) : 2;

/**
 * Bedrock-direct auth for the in-process agent (docs/45: sandbox auth = Bedrock). swarm-harness routes
 * the Bedrock model id through the Claude Agent SDK's Bedrock mode. We set the mode + region and forward
 * any AWS creds present in OUR env (read at runtime — never hardcoded; secrets never printed).
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

// ─── The family-specialist roster (the team arm's specialization treatment) ──────────────────────
const TEAM_PREAMBLE =
  "You lead a team fixing independent buggy Python modules. The repo has modules in src/, each with a " +
  "failing test in tests/, grouped into 4 families by filename prefix: string_, numeric_, datetime_, " +
  "validation_. Assign each family's modules to its matching specialist; each specialist fixes EVERY " +
  "module in their family with a MINIMAL code change so its test passes (never edit tests). Integrate " +
  "and do NOT declare done until `python3 -m pytest -q` reports ALL tests passing. Your task:";
const TEAM_ROSTER = [
  { role: "string-specialist", prompt: "You fix string-manipulation bugs. For each assigned src/string_*.py: read tests/test_string_*.py and make the minimal fix so it passes. Do not modify tests." },
  { role: "numeric-specialist", prompt: "You fix numeric bugs. For each assigned src/numeric_*.py: read tests/test_numeric_*.py and make the minimal fix so it passes. Do not modify tests." },
  { role: "datetime-specialist", prompt: "You fix datetime bugs. For each assigned src/datetime_*.py: read tests/test_datetime_*.py and make the minimal fix so it passes. Do not modify tests." },
  { role: "validation-specialist", prompt: "You fix validation bugs. For each assigned src/validation_*.py: read tests/test_validation_*.py and make the minimal fix so it passes. Do not modify tests." },
];

/**
 * A no-LLM mock adapter (FIXIT_FAKE=1): write the GOLDEN-fixed src for a deterministic FRACTION of the
 * task's modules, leaving the rest buggy. The real CheckpointGrader then runs the sealed tests → the
 * seeded modules pass, the rest fail → coverage ≈ fraction. The seeded subset is derived from
 * (arm + seed) ONLY (no Math.random/Date), so single (~0.55) and team (~0.9) get DIFFERENT subsets per
 * seed — which is what makes the ensemble-union (over single's seeds) recover more than any one seed.
 */
class FixitMockAdapter implements ExecutionAdapter {
  readonly id = "fixit-mock";
  readonly placement = "backend" as const;
  constructor(
    private readonly cfg: FixitConfig,
    private readonly fraction: number,
  ) {}

  async run(cell: PublicCell, ctx: RunContext): Promise<RawRun> {
    const ws = ctx.workspace;
    if (!ws) throw new Error("FixitMockAdapter requires a backend-provisioned workspace");
    const attempt = cell.seed; // the eval-matrix attempt seed (what the ensemble unions)
    // The MODULE SET is fixed by the single task seed; the disjoint window rotates per (arm, attempt).
    const taskSeed = this.cfg.seeds[0]!;
    const golden = fixitGoldenFiles(this.cfg, taskSeed); // reference-fixed src/*.py, one per module (ordered)
    const total = golden.length;
    const take = Math.round(this.fraction * total);
    // Deterministic per-(arm,seed) rotation: pick a contiguous window of `take` modules starting at an
    // offset derived from a cheap hash of (armId + seed). Different arms/seeds → different windows → the
    // union over single's seeds covers strictly more modules than any single seed.
    const offset = hashOffset(`${cell.arm.id}:${attempt}`, total);
    const start = Date.now();
    const files = Array.from({ length: take }, (_, i) => golden[(offset + i) % total]!);
    await ws.writeFiles(files);
    return {
      output: `[fake] ${cell.arm.id} attempt=${attempt}: seeded ${take}/${total} golden modules (offset ${offset})`,
      workdir: ws.root,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      trajectory: [],
      durationMs: Date.now() - start,
    };
  }
}

/** Deterministic non-negative offset in [0, mod) from a string (no Math.random/Date). */
function hashOffset(s: string, mod: number): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return mod > 0 ? h % mod : 0;
}

// ─── Arm table (extensible: a `team-graph` atomic-claim arm can be added here later) ──────────────
interface ArmDef {
  id: string;
  label: string;
  /** Build the per-arm adapter. `fraction` is the FAKE seeding fraction (ignored in real mode). */
  makeAdapter(cfg: FixitConfig): ExecutionAdapter;
  fakeFraction: number;
}
const ARM_TABLE: Record<string, ArmDef> = {
  single: {
    id: "single",
    label: "single-agent",
    fakeFraction: 0.55,
    makeAdapter: () => swarmHarness({ env: bedrockEnv(), timeoutMs: AGENT_TIMEOUT_MS, bin: FIXIT_HARNESS_BIN }).adapter,
  },
  team: {
    id: "team",
    label: "family-specialist team",
    fakeFraction: 0.9,
    makeAdapter: () =>
      new SwarmCoordinatorAdapter({
        env: bedrockEnv(),
        defaultModel: FIXIT_MODEL,
        timeoutMs: AGENT_TIMEOUT_MS,
        name: "fixit-team",
        roster: TEAM_ROSTER,
        architectPreamble: TEAM_PREAMBLE,
        bin: FIXIT_HARNESS_BIN,
      }),
  },
};

function fixitEvalConfig(arms: Arm[]): EvalConfig {
  return {
    runId: "fixit",
    configVersion: process.env.FIXIT_CONFIG_VERSION ?? (FAKE ? "v0-fake" : "v0"),
    benchmark: "fixit",
    arms,
    models: [{ name: FIXIT_MODEL }],
    seeds: SEEDS,
    backend: "in-process",
    concurrency: { cells: CONCURRENCY, modelConnections: CONCURRENCY },
    output: { dir: ".eval-runs", trace: true },
  };
}

// ─── Coverage metrics (the clean breadth axis) ───────────────────────────────────────────────────
/** Per-cell coverage = passed checkpoints / total (purer than score.partial). */
function cellCoverage(r: CellResult): number | undefined {
  const cps = r.score?.checkpoints;
  if (!cps || cps.length === 0) return undefined;
  return cps.filter((c) => c.passed).length / cps.length;
}

/** Per-arm mean coverage over seeds + the per-seed spread (min/max). */
function armCoverage(results: CellResult[], armId: string): { mean: number; min: number; max: number; nSeeds: number } | undefined {
  const covs = results.filter((r) => r.armId === armId).map(cellCoverage).filter((c): c is number => c !== undefined);
  if (covs.length === 0) return undefined;
  const mean = covs.reduce((a, b) => a + b, 0) / covs.length;
  return { mean, min: Math.min(...covs), max: Math.max(...covs), nSeeds: covs.length };
}

/**
 * ensemble@K coverage by PER-MODULE UNION (cites `score.checkpoints: CheckpointResult[]` with {id, passed}):
 * group `single` results by task, take the first K seeds, and count a module solved iff ANY of those K
 * seeds passed that module's checkpoint. Coverage = (#modules solved by ≥1 of K) / N. This is the breadth
 * the ensemble recovers from K partial single attempts.
 */
function ensembleCoverage(results: CellResult[], armId: string, k: number): { coverage: number; n: number; tasks: number } | undefined {
  // taskId → seed → Map<checkpointId, passed>
  const byTask = new Map<string, { seed: number; passed: Map<string, boolean> }[]>();
  for (const r of results) {
    if (r.armId !== armId || !r.score?.checkpoints) continue;
    const passed = new Map(r.score.checkpoints.map((c) => [c.id, c.passed]));
    (byTask.get(r.taskId) ?? byTask.set(r.taskId, []).get(r.taskId)!).push({ seed: r.seed, passed });
  }
  if (byTask.size === 0) return undefined;
  let unionSolved = 0;
  let totalModules = 0;
  for (const attempts of byTask.values()) {
    const kAttempts = [...attempts].sort((a, b) => a.seed - b.seed).slice(0, k);
    const moduleIds = new Set<string>();
    for (const a of kAttempts) for (const id of a.passed.keys()) moduleIds.add(id);
    for (const id of moduleIds) {
      totalModules++;
      if (kAttempts.some((a) => a.passed.get(id) === true)) unionSolved++;
    }
  }
  return { coverage: totalModules > 0 ? unionSolved / totalModules : 0, n: totalModules, tasks: byTask.size };
}

function fmt(x: number): string {
  return x.toFixed(3);
}

// ─── Runner ──────────────────────────────────────────────────────────────────────────────────────
export async function runFixit(): Promise<void> {
  // One FIXED task (pinned by FIXIT_TASK_SEED); the eval-matrix `seeds` (SEEDS) replicate it as K
  // independent ATTEMPTS. So all attempts solve the same N modules → the per-module ensemble union is
  // well-defined. (`fixitBenchmark` makes one EvalTask per element of `seeds`, hence the singleton here.)
  const cfg: FixitConfig = { n: FIXIT_N, seeds: [FIXIT_TASK_SEED] };
  const benchmark = fixitBenchmark(cfg);
  const backend = new InProcessBackend();
  const store = new LocalResultStore(".eval-runs");

  const armDefs = ARM_IDS.map((id) => {
    const def = ARM_TABLE[id];
    if (!def) throw new Error(`runFixit: unknown arm "${id}" (known: ${Object.keys(ARM_TABLE).join(", ")})`);
    return def;
  });
  const arms: Record<string, Arm> = Object.fromEntries(
    armDefs.map((d) => [d.id, { id: d.id, label: d.label, scaffold: {} } as Arm]),
  );

  const allResults: CellResult[] = [];
  for (const def of armDefs) {
    const adapter = FAKE ? new FixitMockAdapter(cfg, def.fakeFraction) : def.makeAdapter(cfg);
    const results = await runEval(fixitEvalConfig([arms[def.id]!]), { benchmark, adapter, backend, store });
    allResults.push(...results);
    const cov = armCoverage(results, def.id);
    console.error(
      `[fixit] arm=${def.id} cells=${results.length}` +
        (cov ? ` coverage=${fmt(cov.mean)} (seeds ${cov.nSeeds}, spread ${fmt(cov.min)}–${fmt(cov.max)})` : " (no graded cells)"),
    );
  }

  // Standard paired report (baseline = single).
  const reportArms = armDefs.map((d) => arms[d.id]!);
  console.log(renderMarkdownReport(buildReport(allResults, fixitEvalConfig(reportArms), { baselineArmId: "single" })));

  // ─── Custom breadth summary: team vs single vs ensemble@K coverage ───
  console.log(`\n## FixIt-N breadth summary (coverage = passed_checkpoints / total)\n`);
  console.log(`| arm | mean coverage | per-seed spread | seeds | tokens |`);
  console.log(`| --- | --- | --- | --- | --- |`);
  for (const def of armDefs) {
    const cov = armCoverage(allResults, def.id);
    const toks = allResults.filter((r) => r.armId === def.id).reduce((a, r) => a + (r.usage?.totalTokens ?? 0), 0);
    console.log(
      cov
        ? `| ${def.id} | ${fmt(cov.mean)} | ${fmt(cov.min)}–${fmt(cov.max)} | ${cov.nSeeds} | ${toks} |`
        : `| ${def.id} | — | — | 0 | ${toks} |`,
    );
  }
  const ens = ensembleCoverage(allResults, "single", FIXIT_K);
  const singleCov = armCoverage(allResults, "single");
  if (ens) {
    console.log(`| ensemble@${FIXIT_K} (single ∪) | ${fmt(ens.coverage)} | — | ${ens.tasks} task(s) × ${FIXIT_K} | — |`);
  }

  // Headline comparison.
  const teamCov = armCoverage(allResults, "team");
  console.log(`\n### Headline`);
  if (teamCov && singleCov) {
    console.log(`- team coverage ${fmt(teamCov.mean)} vs single coverage ${fmt(singleCov.mean)} (Δ ${fmt(teamCov.mean - singleCov.mean)})`);
  }
  if (ens && singleCov) {
    console.log(`- ensemble@${FIXIT_K} coverage ${fmt(ens.coverage)} vs single per-seed coverage ${fmt(singleCov.mean)} (Δ ${fmt(ens.coverage - singleCov.mean)}) — union of ${FIXIT_K} partial single attempts`);
  }

  console.error(`\n[fixit] ${allResults.length} cells over N=${FIXIT_N} × ${SEEDS.length} seed(s) × ${armDefs.length} arm(s)${FAKE ? " [FAKE]" : ""}.`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────────────────────────
if (process.env.RUN_FIXIT) {
  await runFixit();
} else {
  console.error(
    `[fixit] dry: set RUN_FIXIT=1 to run.\n` +
      `  arms    : ${ARM_IDS.join(", ")}\n` +
      `  N       : ${FIXIT_N}\n` +
      `  seeds   : ${SEEDS.join(", ")}\n` +
      `  K       : ${FIXIT_K} (team/ensemble size)\n` +
      `  model   : ${FIXIT_MODEL}\n` +
      `  mode    : ${FAKE ? "FAKE (no-LLM mock)" : "REAL (needs swarm-harness on PATH + Bedrock creds)"}\n` +
      `  roster  : ${TEAM_ROSTER.map((r) => r.role).join(", ")}\n` +
      `  FIXIT_FAKE=1 RUN_FIXIT=1 npx tsx eval/experiments/fixit.ts   # no-spend smoke`,
  );
}
