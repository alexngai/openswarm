/**
 * openswarm on RoadmapBench, Docker on a native x86 Linux host: the openswarm docs/05
 * pilot (D10). Arms: `single` (one agent), `sharded` and `program` (hand-planned
 * threads; see openswarm docs/05 §7.5), and docs/07 §7.1's search arms: `attempt` (one
 * agent then a reviewer; seeds 1..N are the attempts arms a and c are built from) and
 * `rounds` (up to ROADMAP_ROUNDS agent rounds fed by the same reviewer: arm b), and
 * `selfrounds` (the same rounds, each opened by a self-check prompt instead: arm b0); and
 * docs/07 §7's division arms rebuilt to its five conditions, `divsharded` (d) and
 * `divprogram` (e), one gated writer per plan thread (division.mjs), and their control,
 * `onethread4` / `onethread8` (f): the same pipeline with one thread owning the whole
 * roadmap, capped at 4 or 8 rounds. A run's arms must share one driver: the CLI,
 * search.mjs or division.mjs. `gated` is the product's own gate on the CLI's single path
 * (docs/05 B6, OPENSWARM_GATE=1). `landtrain` is docs/05 Phase B's exit criterion 1: the CLI
 * runs a peer-team of two members from a spec generated off the plan (OPENSWARM_TEAM_SPEC), one
 * board task per thread, landed through the train on the task's check (landing-checks.json); a
 * last weight-0 checkpoint (landing.mjs) replays today's sequential queue on the same branches
 * and writes `<host>.landing.json` beside the graded output (landing-report.py reads them).
 *
 * The system under test is a BUILT openswarm checkout on the host (the pilot pins the
 * self-modification line), mounted read-only at /opt/openswarm, with the host's Node at
 * /opt/node. Every arm runs that one artifact. Team members are dsh subprocesses, which
 * a single-file bundle cannot launch, so the bundle path is gone.
 *
 *   (host) build openswarm at $OPENSWARM_ROOT; Node 24 at /opt/node
 *   ROADMAP_TASKS=vbt-1.3.0 ROADMAP_ARMS=single,sharded,program node examples/openswarm-roadmap-docker.mjs
 *
 * Task dirs come from the HF dataset (`UnipatAI/RoadmapBench`) under ROADMAP_DIR
 * (default eval/pilot/.roadmap, gitignored): `<task>-roadmap/{instruction.md,task.toml,tests/}`;
 * plans under ROADMAP_PLANS (default eval/pilot/plans) as `<task>/plan.json`;
 * reference slices under ROADMAP_REFS (default <ROADMAP_DIR>/refs) as `<task>/<thread>.patch`. The agent sees instruction.md (and, for team arms, the plan).
 * Grading is RoadmapBench's own `tests/test.sh`, seeded into /tests only after the
 * agent finishes: one checkpoint per roadmap target, weighted as test.sh weights it,
 * so `earned/total` is the benchmark's reward and `full` is "resolved". test.sh's own
 * reward.json and log are kept under `.eval-runs/<run>/verifier-out/<cell>/` for audit.
 *
 * Zero-token plumbing check: ROADMAP_REF=1 seeds `<task>/<thread>.patch` from ROADMAP_REFS at
 * /opt/pilot/ref, and OPENSWARM_LLM_BASE_URL points the SUT at pilot-mock.mjs, whose
 * scripted members apply their thread's slice of the reference solution.
 *
 * Every arm gets the same container (ROADMAP_CPUS / ROADMAP_MEM, default 8 / 16g), so
 * contention among a program's agents is not a confound. /app is made a git repo when
 * the image lacks one, so the diff capture and the team arms' worktrees have a base.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval, harnessOf, openSwarmSpec, DockerBackend, LocalResultStore } from "swarmkit-eval";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// Task data and reference slices hold the benchmark's gold solutions, so they
// live in a gitignored directory and are never committed (RoadmapBench carries
// a training-corpus canary). Plans are ours and are committed.
const ROADMAP_DIR = resolve(process.env.ROADMAP_DIR ?? join(HERE, ".roadmap"));
const PLANS = resolve(process.env.ROADMAP_PLANS ?? join(HERE, "plans"));
const REFS = resolve(process.env.ROADMAP_REFS ?? join(ROADMAP_DIR, "refs"));
const OPENSWARM_ROOT = resolve(process.env.OPENSWARM_ROOT ?? `${process.env.HOME}/openswarm`);
const MOCK = process.env.OPENSWARM_LLM_BASE_URL;
const MODEL = process.env.OPENSWARM_MODEL ?? (MOCK ? "mock-model" : "azureoai/gpt-5.5");
const TASKS = (process.env.ROADMAP_TASKS ?? "").split(",").filter(Boolean);
const ARMS = (process.env.ROADMAP_ARMS ?? "single").split(",").filter(Boolean);
const SEEDS = (process.env.ROADMAP_SEEDS ?? "1").split(",").map(Number);
const RUN_ID = process.env.ROADMAP_RUN_ID ?? "openswarm-roadmap-pilot";
/** Gated rounds per thread in the division arms. */
const THREAD_ROUNDS = Number(process.env.ROADMAP_THREAD_ROUNDS ?? 3);
const REF = process.env.ROADMAP_REF === "1";
const VERIFIER_OUT = resolve(`.eval-runs/${RUN_ID}/verifier-out`);
mkdirSync(VERIFIER_OUT, { recursive: true });

if (!MOCK) for (const key of ["AZURE_API_BASE", "AZURE_API_KEY"]) {
  if (!process.env[key]) { console.error(`missing ${key} (or set OPENSWARM_LLM_BASE_URL for the mock)`); process.exit(2); }
}
if (!existsSync(join(OPENSWARM_ROOT, "packages/cli/dist/index.js"))) { console.error(`no built openswarm at ${OPENSWARM_ROOT}`); process.exit(2); }
if (!existsSync("/opt/node/bin/node")) { console.error("no Node at /opt/node on the host"); process.exit(2); }
if (TASKS.length === 0) { console.error("set ROADMAP_TASKS=<task>[,<task>…] (e.g. opt-4.4.0)"); process.exit(2); }
const DRIVER = { single: "openswarm", gated: "openswarm", sharded: "openswarm", program: "openswarm", landtrain: "openswarm", attempt: "search", rounds: "search", selfrounds: "search", divsharded: "division", divprogram: "division", onethread4: "division", onethread8: "division" };
for (const arm of ARMS) if (!DRIVER[arm]) { console.error(`unknown arm ${arm}`); process.exit(2); }
const DRIVERS = new Set(ARMS.map((a) => DRIVER[a]));
if (DRIVERS.size > 1) { console.error(`arms ${ARMS.join(",")} need different drivers (${[...DRIVERS].join(", ")}); run them apart`); process.exit(2); }
const BIN = [...DRIVERS][0];
const SEARCH = BIN !== "openswarm";

const INIT = [
  "cd /app && (git rev-parse --is-inside-work-tree >/dev/null 2>&1 || (git init -q && git add -A && git -c user.email=eval@local -c user.name=eval commit -qm base))",
  // Team members' worktrees hard-link the checkout's ignored node_modules. In a
  // Docker image the first link of each file forces an overlayfs copy-up (about
  // 3 min for 35k files); later links take a second. Pay it here, in EVERY arm,
  // so it is never inside a team arm's timed run.
  "cd /app && git config --global --add safe.directory '*' && git ls-files -z --others --ignored --exclude-standard --directory | tr '\\0' '\\n' | grep -E '(^|/)node_modules/$' | while IFS= read -r d; do cp -al \"$d\" /tmp/.osw-warm && rm -rf /tmp/.osw-warm; done; true",
];

/** The built CLI exports runCli without running it; this is the process entry. */
const ENTRY = "import { runCli } from '/opt/openswarm/packages/cli/dist/index.js'\nprocess.exit(await runCli(process.argv.slice(2)))\n";

/** Exit 0 iff test.sh reported phase k PASSED (its last PASSED/FAILED line in that phase's block). */
const phasePassed = (k) =>
  `awk '/^=== Phase ${k}:/{f=1;next} /^=== Phase |^Result:/{f=0} f&&/^(PASSED|FAILED)$/{s=$0} END{exit s=="PASSED"?0:1}' /logs/verifier/stdout.txt`;

const LANDING_CHECKS = JSON.parse(readFileSync(join(HERE, "landing-checks.json"), "utf8"));

/**
 * The landtrain arm's team: two dsh members on the CLI's route, one board task per plan thread
 * framed as plan mode frames a thread (the CLI puts the task's instruction ahead of each), the
 * others after t0, landed through the train on the task's check.
 */
function landtrainSpec(name, plan) {
  const checks = LANDING_CHECKS[name];
  if (!checks) throw new Error(`${name}: arm landtrain needs a check in landing-checks.json`);
  return {
    topology: "peer-team",
    members: [{ name: "member-0" }, { name: "member-1" }],
    tasks: plan.threads.map((t, i) => ({
      subject: t.id,
      prompt: `## Your thread: ${t.id}\n${t.assignment}\nOther threads own the rest of the roadmap; stay within your assignment.`,
      ...(i === 0 ? {} : { blockedBy: [0] }),
    })),
    worktrees: { train: { checks, batchSize: 4, maxRepairs: 1 } },
  };
}

const seedDir = (dir, to) =>
  readdirSync(dir).map((f) => ({ path: `${to}/${f}`, content: readFileSync(join(dir, f), "utf8") }));

function loadTask(name) {
  const dir = join(ROADMAP_DIR, `${name}-roadmap`);
  const image = /docker_image\s*=\s*"([^"]+)"/.exec(readFileSync(join(dir, "task.toml"), "utf8"))?.[1];
  const testSh = readFileSync(join(dir, "tests/test.sh"), "utf8");
  const weights = /weights\s*=\s*\[([^\]]+)\]/.exec(testSh)?.[1].split(",").map(Number);
  if (!image || !weights?.length || weights.some(Number.isNaN)) throw new Error(`${name}: cannot read image or weights`);

  const files = [{ path: "/opt/pilot/openswarm.mjs", content: ENTRY }];
  if (SEARCH) for (const f of ["gate.mjs", `${BIN}.mjs`]) files.push({ path: `/opt/pilot/${f}`, content: readFileSync(join(HERE, f), "utf8") });
  const plan = join(PLANS, name, "plan.json");
  if (ARMS.some((a) => ["sharded", "program", "divsharded", "divprogram"].includes(a))) {
    if (!existsSync(plan)) throw new Error(`${name}: team arms need ${plan}`);
    files.push({ path: "/opt/pilot/plan.json", content: readFileSync(plan, "utf8") });
  }
  if (REF) files.push(...seedDir(join(REFS, name), "/opt/pilot/ref"));
  const landtrain = ARMS.includes("landtrain");
  if (landtrain) {
    if (!existsSync(plan)) throw new Error(`${name}: arm landtrain needs ${plan}`);
    files.push(
      { path: "/opt/pilot/spec.json", content: JSON.stringify(landtrainSpec(name, JSON.parse(readFileSync(plan, "utf8"))), null, 1) },
      { path: "/opt/pilot/landing.mjs", content: readFileSync(join(HERE, "landing.mjs"), "utf8") },
    );
  }

  return {
    id: `roadmap-bench/${name}`,
    benchmark: "roadmap-bench",
    prompt: readFileSync(join(dir, "instruction.md"), "utf8"),
    setup: { image, files, initCommands: INIT },
    checkpoints: [
      // landtrain, weight 0 and first: /app as it is graded (HEAD, then any change), so landing.mjs pairs the
      // graded reward with the train's landed tree only when /app was that tree, clean.
      ...(landtrain ? [{ id: "app-state", weight: 0, check: { type: "cmd", cmd:
        `cd /app && { git rev-parse HEAD; git status --porcelain; } > /verifier-out/${name}.$HOSTNAME.app-state.txt 2>&1; true` } }] : []),
      // Weight 0: runs the sealed tests once; the weighted phase checks below read its output.
      { id: "verifier", weight: 0, check: { type: "cmd", writeFiles: seedDir(join(dir, "tests"), "/tests"), cmd:
        "mkdir -p /logs/verifier && bash /tests/test.sh > /logs/verifier/stdout.txt 2>&1; " +
        `for f in reward.json stdout.txt; do cp /logs/verifier/$f /verifier-out/${name}.$HOSTNAME.$f 2>/dev/null; done; true` } },
      ...weights.map((w, i) => ({ id: `phase-${i + 1}`, weight: w, check: { type: "cmd", cmd: phasePassed(i + 1) } })),
      // Weight 0 and last, after the graded checks: the counterfactual queue on the same branches.
      // It swaps /app to the queue's tree for its own test.sh run and restores it; another arm's cell is a no-op.
      ...(landtrain ? [{ id: "landing", weight: 0, check: { type: "cmd", cmd:
        `/opt/node/bin/node /opt/pilot/landing.mjs ${name} > /verifier-out/${name}.$HOSTNAME.landing.log 2>&1; true` } }] : []),
    ],
  };
}

const tasks = TASKS.map(loadTask);
const benchmark = { id: "roadmap-bench", execution: "native", load: async () => tasks };

const passEnv = (keys) => Object.fromEntries(keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const harness = harnessOf(
  { ...openSwarmSpec, install: [], readyCmd: undefined },
  {
    bin: `/opt/node/bin/node /opt/pilot/${BIN}.mjs`,
    // Otherwise a model name the adapter reads as a placeholder (e.g. "mock-model") is
    // silently replaced by the spec default, which has no route here.
    defaultModel: MODEL,
    captureSubmissionDiff: true,
    // The task allows 2h per agent. A search cell is an agent then a reviewer, N times
    // for `rounds`, and a timeout mid-review would grade the reviewer's edits. A division
    // cell runs at most two thread waves of gated rounds, then the landing repairs.
    // landtrain: t0, then two waves of threads over two members, then the train's repairs.
    timeoutMs: (ARMS.includes("gated") ? 2 * 4 : ARMS.includes("landtrain") ? 2 : BIN === "division" ? 2 * Math.max(2 * THREAD_ROUNDS, ARMS.includes("onethread8") ? 8 : 4) + 2 : ARMS.some((a) => a.endsWith("rounds")) ? 2 * Number(process.env.ROADMAP_ROUNDS ?? 4) : SEARCH ? 2 : 1) * 2 * 60 * 60 * 1000,
    // A backstop, not the budget: cache reads count toward it, and the 2h clock is the real cap.
    maxTokens: Number(process.env.ROADMAP_MAX_TOKENS ?? 40_000_000),
    env: {
      ...passEnv(["AZURE_API_BASE", "AZURE_API_KEY", "OPENSWARM_LLM_BASE_URL", "OPENSWARM_LLM_API_KEY"]),
      OPENSWARM_HOME: "/tmp/openswarm-home",
      // No PATH override: the harness and its members run /opt/node by absolute path, and
      // the agent's shell must keep the image's own node/python for the task's toolchain.
      HOME: "/root",
    },
  },
);

const SCAFFOLD = {
  single: {},
  // docs/05 B6's exit criterion 6: the product's own completion gate on the single path.
  // ROADMAP_GATE_SANDBOX=danger-full-access for hosts whose containers cannot sandbox.
  gated: { env: { OPENSWARM_GATE: "1", ...(process.env.ROADMAP_GATE_SANDBOX ? { OPENSWARM_GATE_REVIEWER_SANDBOX: process.env.ROADMAP_GATE_SANDBOX } : {}) } },
  // docs/05 Phase B exit criterion 1: the team spec loadTask generates, landed through the train.
  landtrain: { env: { OPENSWARM_TEAM_SPEC: "/opt/pilot/spec.json" } },
  attempt: { env: { PILOT_SEARCH: "review" } },
  rounds: { env: { PILOT_SEARCH: "rounds", PILOT_ROUNDS: process.env.ROADMAP_ROUNDS ?? "4" } },
  selfrounds: { env: { PILOT_SEARCH: "self", PILOT_ROUNDS: process.env.ROADMAP_ROUNDS ?? "4" } },
  divsharded: { env: { PILOT_DIVISION: "sharded", PILOT_ROUNDS: String(THREAD_ROUNDS), PILOT_PLAN: "/opt/pilot/plan.json" } },
  divprogram: { env: { PILOT_DIVISION: "program", PILOT_ROUNDS: String(THREAD_ROUNDS), PILOT_PLAN: "/opt/pilot/plan.json" } },
  onethread4: { env: { PILOT_DIVISION: "program", PILOT_ONE_THREAD: "1", PILOT_ROUNDS: "4" } },
  onethread8: { env: { PILOT_DIVISION: "program", PILOT_ONE_THREAD: "1", PILOT_ROUNDS: "8" } },
};
const armOf = (id) => ({
  id,
  label: id,
  scaffold: SCAFFOLD[id] ?? { env: { OPENSWARM_PILOT_ARM: id, OPENSWARM_PILOT_PLAN: "/opt/pilot/plan.json" } },
});

/**
 * swarmkit-eval 0.2.0's DockerWorkspace.run drops `opts.env` (fixed in its
 * source, not yet published), so the harness's route and each arm's
 * OPENSWARM_PILOT_* never reached the CLI and every cell ran as a bare single
 * agent with no model route. Re-add the env as exports ahead of the command.
 * Delete once a published swarmkit-eval passes it.
 */
class EnvDockerBackend extends DockerBackend {
  constructor(opts) {
    super(opts);
    this.sharedRunArgs = opts.runArgs;
  }

  async acquire(cell) {
    // Each cell mounts only its own verifier-out: the run's shared one would show a later
    // cell the held-out test output of the cells graded before it. super.acquire reads
    // runArgs before its first await, so concurrent acquires cannot swap each other's.
    const own = join(VERIFIER_OUT, `${cell.task.id.split("/").pop()}.${cell.arm.id}.s${cell.seed}.${Date.now().toString(36)}`);
    mkdirSync(own, { recursive: true });
    this.opts.runArgs = [...this.sharedRunArgs, "-v", `${own}:/verifier-out`];
    const ws = await super.acquire(cell);
    const run = ws.run.bind(ws);
    const quote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    ws.run = (cmd, opts = {}) => {
      const env = Object.entries(opts.env ?? {}).map(([k, v]) => `export ${k}=${quote(v)};`).join(" ");
      return run(env === "" ? cmd : `${env} ${cmd}`, opts);
    };
    return ws;
  }
}

const dir = `.eval-runs/${RUN_ID}`;
const results = await runEval(
  {
    runId: RUN_ID,
    configVersion: "pilot-v1",
    benchmark: benchmark.id,
    arms: ARMS.map(armOf),
    models: [{ name: MODEL }],
    seeds: SEEDS,
    backend: "docker",
    concurrency: { cells: Number(process.env.ROADMAP_CONCURRENCY ?? 1), modelConnections: 12 },
    output: { dir, trace: true },
  },
  {
    benchmark,
    adapter: harness.adapter,
    backend: new EnvDockerBackend({
      root: "/app",
      runArgs: [
        "--cpus", process.env.ROADMAP_CPUS ?? "8", "--memory", process.env.ROADMAP_MEM ?? "16g",
        "-v", `${OPENSWARM_ROOT}:/opt/openswarm:ro`,
        "-v", "/opt/node:/opt/node:ro",
        ...(MOCK ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      ],
    }),
    store: new LocalResultStore(dir),
  },
);

for (const c of results) {
  const u = c.usage ?? {};
  const reward = c.score ? (c.score.earned / c.score.total).toFixed(3) : "n/a";
  console.log(
    `${c.taskId} arm=${c.armId} seed=${c.seed} status=${c.status} resolved=${c.score?.full} reward=${reward} ` +
      `in=${u.inputTokens ?? 0} cacheRead=${u.cacheReadTokens ?? 0} out=${u.outputTokens ?? 0} ` +
      `${Math.round((c.durationMs ?? 0) / 60000)}min` + (c.envError ? `\n   env_error: ${c.envError.message}` : ""),
  );
}
