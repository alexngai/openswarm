/**
 * tac-pool.ts — schedule TAC cells over a provisioned EC2 worker pool.
 *
 * This is the full-benchmark-safe launcher for TAC service hosts. It reads the
 * runner manifest produced by swarmkit-eval's adapters/tac/scripts/run-ec2-pool.sh
 * and runs exactly one TAC eval cell at a time on each worker. Each cell is
 * launched as an isolated tac.ts child process with one task, one arm, and one seed.
 *
 * Default safety policy:
 *   - one active cell per worker;
 *   - EVAL_CONCURRENCY=1 inside each child;
 *   - TAC_GITLAB_SERVICE_RESET=hard unless explicitly overridden, so GitLab
 *     dependent cells recreate GitLab with `docker rm -f -v gitlab` before init.
 *
 * Typical wrapper usage from swarmkit/src/eval:
 *   TAC_POOL_WORKER_COUNT=8 TAC_POOL_SERVICE_SLICE=gitlab-redis \
 *   TAC_POOL_RUNNER_CMD='cd /Users/alexngai/GitHub/swarm-coder && RUN_TAC_POOL=1 tsx eval/experiments/tac-pool.ts' \
 *   adapters/tac/scripts/run-ec2-pool.sh
 *
 * No-infra plan validation:
 *   RUN_TAC_POOL=1 TAC_POOL_DRY_PLAN=1 TAC_POOL_SERVICE_SLICE=full EVAL_ARMS=stock \
 *   tsx eval/experiments/tac-pool.ts
 */
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  tacDockerBenchmark,
  tacSelectorFromEnv,
  type Arm,
  type CellResult,
  type EvalTask,
} from "swarmkit-eval";
import { tacExperimentArms } from "./tac-arms.js";

interface PoolManifest {
  region?: string;
  workers?: Array<{
    id?: string;
    name?: string;
    public_ip?: string;
    public_dns?: string;
    ssh_user?: string;
    worker_index?: number;
  }>;
}

interface TacPoolJob {
  task: EvalTask;
  arm: Arm;
  seed: number;
}

interface JobSummary {
  taskId: string;
  armId: string;
  seed: number;
  worker: string;
  outDir: string;
  exitCode: number;
  durationMs: number;
  status?: string;
  partial?: number;
  full?: boolean;
  envErrorKind?: string;
  totalTokens?: number;
  processTimedOut?: boolean;
}

const MODEL = process.env.EVAL_MODEL ?? "haiku";
const ARM_IDS = (process.env.EVAL_ARMS ?? "stock,notes,opentasks").split(",").map((s) => s.trim()).filter(Boolean);
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const SEEDS = process.env.EVAL_SEEDS
  ? process.env.EVAL_SEEDS.split(",").map((s) => Number(s.trim()))
  : Array.from({ length: REPEATS }, (_, i) => i + 1);
const LIMIT = process.env.EVAL_TASK_LIMIT ? Number(process.env.EVAL_TASK_LIMIT) : undefined;
const TAC_ROOT = process.env.TAC_ROOT ?? `${process.env.HOME}/GitHub/TheAgentCompany`;
const OUT = path.resolve(process.cwd(), process.env.EVAL_OUT_DIR ?? ".eval-runs/tac-pool");
const MANIFEST = process.env.TAC_POOL_MANIFEST;
const CELL_CONCURRENCY = process.env.TAC_POOL_CELL_CONCURRENCY ? Number(process.env.TAC_POOL_CELL_CONCURRENCY) : undefined;
const FAIL_FAST = process.env.TAC_POOL_FAIL_FAST === "1";
const FAIL_ON_CELL_STATUS = process.env.TAC_POOL_FAIL_ON_CELL_STATUS === "1";
const SERVICE_RESET = process.env.TAC_GITLAB_SERVICE_RESET ?? process.env.TAC_POOL_GITLAB_SERVICE_RESET ?? "hard";
const CHILD_TIMEOUT_MS = process.env.TAC_POOL_CHILD_TIMEOUT_MS ? Number(process.env.TAC_POOL_CHILD_TIMEOUT_MS) : undefined;
const SWARM_HARNESS_TARBALL = process.env.TAC_SWARM_HARNESS_TARBALL;
const SKIP_COMPLETED = process.env.TAC_POOL_SKIP_COMPLETED === "1" || process.env.TAC_POOL_SKIP_COMPLETED === "true";
const DRY_PLAN = process.env.TAC_POOL_DRY_PLAN === "1" || process.env.TAC_POOL_DRY_PLAN === "true";
const SERVICE_SLICE = process.env.TAC_POOL_SERVICE_SLICE ?? "full";
const START_GRADER_PROXY = process.env.TAC_POOL_START_GRADER_PROXY
  ? process.env.TAC_POOL_START_GRADER_PROXY === "1"
  : process.env.TAC_GRADER_PROXY === "bedrock";
const GRADER_PROXY_HELPER = process.env.TAC_POOL_GRADER_PROXY_HELPER
  ?? process.env.TAC_GRADER_PROXY_HELPER
  ?? path.resolve("node_modules/swarmkit-eval/adapters/tac/scripts/start-litellm-bedrock-proxy.sh");
const REMOTE_POOL_ROOT = process.env.TAC_POOL_REMOTE_ROOT ?? "/home/ubuntu/tac-run/_pool";
const SUPPORTED_TAC_SERVICES = ["gitlab", "owncloud", "plane", "rocketchat"];

async function main(): Promise<void> {
  const benchmark = tacDockerBenchmark({ root: TAC_ROOT, selector: tacSelectorFromEnv() });
  const tasks = await benchmark.load({ limit: LIMIT });
  const arms = tacExperimentArms(ARM_IDS);
  const allJobs = buildJobs(tasks, arms, SEEDS);
  const validation = validatePlan(tasks, SERVICE_SLICE);

  let workers: NonNullable<PoolManifest["workers"]> = [];
  if (!DRY_PLAN) {
    if (!MANIFEST) throw new Error("TAC_POOL_MANIFEST is required; run via adapters/tac/scripts/run-ec2-pool.sh or pass the manifest path.");
    const manifest = JSON.parse(await fs.readFile(MANIFEST, "utf8")) as PoolManifest;
    workers = (manifest.workers ?? []).filter((w) => w.public_ip || w.public_dns);
    if (!workers.length) throw new Error(`No workers found in ${MANIFEST}`);
    if (!process.env.EC2_SSH_KEY_PATH) throw new Error("EC2_SSH_KEY_PATH is required for TAC pool child runs.");
  }

  await fs.mkdir(OUT, { recursive: true });
  const { jobs, cached } = SKIP_COMPLETED ? await partitionCachedJobs(allJobs) : { jobs: allJobs, cached: [] };
  const dryWorkerCount = Number(process.env.TAC_POOL_WORKER_COUNT ?? 1);
  const availableWorkers = DRY_PLAN ? Math.max(1, dryWorkerCount) : workers.length;
  const concurrency = Math.max(1, Math.min(CELL_CONCURRENCY ?? availableWorkers, availableWorkers, jobs.length || 1));
  await fs.writeFile(path.join(OUT, "plan.json"), JSON.stringify({
    model: MODEL,
    arms: arms.map((a) => a.id),
    seeds: SEEDS,
    tasks: tasks.map((t) => t.id),
    taskInventory: validation.inventory,
    workers,
    concurrency,
    serviceSlice: SERVICE_SLICE,
    serviceReset: SERVICE_RESET,
    skipCompleted: SKIP_COMPLETED,
    cachedCells: cached.length,
    pendingCells: jobs.length,
    dryPlan: DRY_PLAN,
    validation,
  }, null, 2));

  if (validation.errors.length) {
    console.error(`[tac-pool] plan validation failed:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`);
    process.exitCode = 1;
    if (DRY_PLAN) return;
    throw new Error("TAC pool plan validation failed");
  }

  if (DRY_PLAN) {
    console.error(
      `[tac-pool] dry plan jobs=${jobs.length} cached=${cached.length} tasks=${tasks.length} ` +
        `arms=${arms.map((a) => a.id).join(",")} seeds=${SEEDS.join(",")} serviceSlice=${SERVICE_SLICE} out=${OUT}`,
    );
    console.log(`\n[tac-pool] dry plan: ${path.join(OUT, "plan.json")}`);
    return;
  }

  console.error(
    `[tac-pool] jobs=${jobs.length} cached=${cached.length} workers=${workers.length} ` +
      `concurrency=${concurrency} reset=${SERVICE_RESET} out=${OUT}`,
  );
  if (START_GRADER_PROXY) {
    await startGraderProxyOnWorkers(workers.slice(0, concurrency));
  }
  const summaries = [...cached, ...(jobs.length ? await runPool(jobs, workers, concurrency) : [])];
  await writeSummary(summaries);

  const processFailures = summaries.filter((s) => s.exitCode !== 0);
  const cellFailures = summaries.filter((s) => FAIL_ON_CELL_STATUS && s.status && s.status !== "success");
  if (processFailures.length || cellFailures.length) {
    process.exitCode = 1;
  }
}

function buildJobs(tasks: EvalTask[], arms: Arm[], seeds: number[]): TacPoolJob[] {
  const jobs: TacPoolJob[] = [];
  for (const task of tasks) {
    for (const arm of arms) {
      for (const seed of seeds) jobs.push({ task, arm, seed });
    }
  }
  return jobs;
}

function validatePlan(tasks: EvalTask[], serviceSlice: string): {
  serviceSlice: string;
  supportedServices: string[];
  inventory: Record<string, unknown>;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const dependencySets = countBy(tasks, (task) => taskDependencies(task).join("+") || "(none)");
  const roles = countBy(tasks, (task) => String(task.publicMetadata?.role ?? task.id.split("-")[0] ?? "unknown"));
  const allDeps = [...new Set(tasks.flatMap(taskDependencies))].sort();
  const unknownDeps = allDeps.filter((dep) => !SUPPORTED_TAC_SERVICES.includes(dep));
  if (unknownDeps.length) errors.push(`unsupported TAC service dependencies: ${unknownDeps.join(", ")}`);
  if (serviceSlice !== "gitlab" && serviceSlice !== "gitlab-redis" && serviceSlice !== "full") {
    errors.push(`unsupported TAC_POOL_SERVICE_SLICE=${serviceSlice}; expected gitlab, gitlab-redis, or full`);
  }
  const fullOnlyDeps = new Set(["owncloud", "plane", "rocketchat"]);
  const needsFull = tasks.some((task) => taskDependencies(task).some((dep) => fullOnlyDeps.has(dep)));
  if ((serviceSlice === "gitlab" || serviceSlice === "gitlab-redis") && needsFull) {
    errors.push("selected tasks include owncloud/plane/rocketchat dependencies, so TAC_POOL_SERVICE_SLICE=full is required");
  }
  const noDependencyTasks = tasks.filter((task) => taskDependencies(task).length === 0).map((task) => task.id);
  if (noDependencyTasks.length) {
    warnings.push(`${noDependencyTasks.length} task(s) have no service dependencies: ${noDependencyTasks.join(", ")}`);
  }
  return {
    serviceSlice,
    supportedServices: SUPPORTED_TAC_SERVICES,
    inventory: {
      totalTasks: tasks.length,
      dependencySets,
      roles,
      uniqueDependencies: allDeps,
      fullServiceTasks: tasks.filter((task) => taskDependencies(task).some((dep) => fullOnlyDeps.has(dep))).length,
      gitlabDependentTasks: tasks.filter((task) => taskDependencies(task).includes("gitlab")).length,
      llmGraderTasks: tasks.filter((task) => task.publicMetadata?.usesLlmGrader === true).length,
      scenarioTasks: tasks.filter((task) => task.publicMetadata?.hasScenarios === true).length,
    },
    warnings,
    errors,
  };
}

function taskDependencies(task: EvalTask): string[] {
  const deps = task.publicMetadata?.dependencies;
  if (!Array.isArray(deps)) return [];
  return deps.filter((dep): dep is string => typeof dep === "string").sort();
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

async function partitionCachedJobs(jobs: TacPoolJob[]): Promise<{ jobs: TacPoolJob[]; cached: JobSummary[] }> {
  const pending: TacPoolJob[] = [];
  const cached: JobSummary[] = [];
  for (const job of jobs) {
    const result = await readSingleResult(jobOutDir(job));
    if (!result) {
      pending.push(job);
      continue;
    }
    cached.push({
      taskId: job.task.id,
      armId: job.arm.id,
      seed: job.seed,
      worker: "cached",
      outDir: jobOutDir(job),
      exitCode: 0,
      durationMs: 0,
      status: result.status,
      partial: result.score?.partial,
      full: result.score?.full,
      envErrorKind: result.envError?.kind,
      totalTokens: result.usage?.totalTokens,
    });
  }
  return { jobs: pending, cached };
}

async function runPool(
  jobs: TacPoolJob[],
  workers: NonNullable<PoolManifest["workers"]>,
  concurrency: number,
): Promise<JobSummary[]> {
  const queue = [...jobs];
  const summaries: JobSummary[] = [];
  let failed = false;
  const activeWorkers = workers.slice(0, concurrency);

  await Promise.all(activeWorkers.map(async (worker) => {
    while (queue.length && !(FAIL_FAST && failed)) {
      const job = queue.shift();
      if (!job) return;
      const summary = await runJob(job, worker);
      summaries.push(summary);
      if (summary.exitCode !== 0 || (FAIL_ON_CELL_STATUS && summary.status && summary.status !== "success")) failed = true;
    }
  }));

  return summaries.sort((a, b) =>
    a.taskId.localeCompare(b.taskId) || a.armId.localeCompare(b.armId) || a.seed - b.seed,
  );
}

async function runJob(job: TacPoolJob, worker: NonNullable<PoolManifest["workers"]>[number]): Promise<JobSummary> {
  const started = Date.now();
  const workerHost = worker.public_ip ?? worker.public_dns;
  if (!workerHost) throw new Error(`worker has no public host: ${JSON.stringify(worker)}`);
  const id = jobId(job);
  const cellOut = jobOutDir(job);
  await fs.mkdir(cellOut, { recursive: true });

  const log = createWriteStream(path.join(cellOut, "child.log"), { flags: "a" });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RUN_TAC: "1",
    EVAL_BACKEND: "ec2",
    EC2_HOST: workerHost,
    EC2_INSTANCE_ID: worker.id,
    EC2_REGION: process.env.EC2_REGION ?? process.env.AWS_REGION ?? readRegionFallback(),
    EC2_ROOT: `/home/ubuntu/tac-run/${slug(id).slice(0, 80)}`,
    EVAL_TASKS: job.task.id,
    EVAL_ARMS: job.arm.id,
    EVAL_SEEDS: String(job.seed),
    EVAL_REPEATS: "1",
    EVAL_TASK_LIMIT: "",
    EVAL_CONCURRENCY: "1",
    EVAL_MODEL: MODEL,
    EVAL_CONFIG_VERSION: `${process.env.EVAL_CONFIG_VERSION ?? "tac-pool"}-${SERVICE_RESET}`,
    EVAL_OUT_DIR: cellOut,
    TAC_SERVER_HOSTNAME: process.env.TAC_SERVER_HOSTNAME ?? "127.0.0.1",
    TAC_DOCKER_COMMAND: process.env.TAC_DOCKER_COMMAND ?? "sudo docker",
    TAC_GITLAB_SERVICE_RESET: SERVICE_RESET,
    TAC_INIT_TIMEOUT: process.env.TAC_INIT_TIMEOUT ?? (SERVICE_RESET === "hard" ? "1200000" : "600000"),
  };

  console.error(`[tac-pool] start ${id} on ${worker.name ?? workerHost}`);
  if (SWARM_HARNESS_TARBALL) {
    await syncSwarmHarnessTarball(workerHost, childEnv.EC2_ROOT, SWARM_HARNESS_TARBALL);
  }
  const processResult = await spawnTac(childEnv, log);
  const exitCode = processResult.exitCode;
  if (processResult.timedOut || exitCode !== 0) {
    await cleanupWorkerTacProcesses(workerHost, `${job.task.id}/${job.arm.id}/seed${job.seed}`, log);
  }
  log.end();
  const durationMs = Date.now() - started;
  const result = await readSingleResult(cellOut);
  console.error(
    `[tac-pool] done ${id} exit=${exitCode} status=${result?.status ?? "missing"} ` +
      `S_partial=${result?.score?.partial ?? "n/a"} worker=${worker.name ?? workerHost}`,
  );

  return {
    taskId: job.task.id,
    armId: job.arm.id,
    seed: job.seed,
    worker: worker.name ?? workerHost,
    outDir: cellOut,
    exitCode,
    durationMs,
    status: result?.status,
    partial: result?.score?.partial,
    full: result?.score?.full,
    envErrorKind: result?.envError?.kind,
    totalTokens: result?.usage?.totalTokens,
    processTimedOut: processResult.timedOut,
  };
}

function spawnTac(env: NodeJS.ProcessEnv, log: NodeJS.WritableStream): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("tsx", ["eval/experiments/tac.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    if (CHILD_TIMEOUT_MS && CHILD_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        log.write(`[tac-pool] child timeout after ${CHILD_TIMEOUT_MS}ms; sending SIGTERM\n`);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          log.write("[tac-pool] child still alive after SIGTERM; sending SIGKILL\n");
          child.kill("SIGKILL");
        }, 30_000);
      }, CHILD_TIMEOUT_MS);
    }
    child.stdout.on("data", (d) => {
      process.stdout.write(d);
      log.write(d);
    });
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
      log.write(d);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code ?? 1, timedOut });
    });
    child.on("error", (err) => {
      log.write(`${err.stack ?? err.message}\n`);
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: 1, timedOut });
    });
  });
}

async function cleanupWorkerTacProcesses(workerHost: string, label: string, log: NodeJS.WritableStream): Promise<void> {
  const key = process.env.EC2_SSH_KEY_PATH;
  if (!key) throw new Error("EC2_SSH_KEY_PATH is required to clean up TAC worker processes");
  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-i", key,
  ];
  log.write(`[tac-pool] cleaning remote TAC containers after ${label}\n`);
  try {
    await runLocal("ssh", [
      ...sshBase,
      `ubuntu@${workerHost}`,
      [
        "set +e",
        "containers=$(sudo docker ps -aq --filter 'name=^/tac-')",
        'if [ -n "$containers" ]; then sudo docker rm -f $containers >/dev/null 2>&1; fi',
        "pkill -f 'swarm-harness swarm run .*/eval/.tac/' >/dev/null 2>&1 || true",
        "pkill -f '@anthropic-ai/claude-agent-sdk.*/claude' >/dev/null 2>&1 || true",
        "exit 0",
      ].join("; "),
    ]);
  } catch (err) {
    log.write(`[tac-pool] remote cleanup failed after ${label}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function syncSwarmHarnessTarball(workerHost: string, remoteRoot: string | undefined, tarball: string): Promise<void> {
  if (!remoteRoot) throw new Error("EC2_ROOT is required to sync TAC_SWARM_HARNESS_TARBALL");
  const local = path.resolve(tarball);
  await fs.access(local);
  const key = process.env.EC2_SSH_KEY_PATH;
  if (!key) throw new Error("EC2_SSH_KEY_PATH is required to sync TAC_SWARM_HARNESS_TARBALL");
  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-i", key,
  ];
  await runLocal("ssh", [
    ...sshBase,
    `ubuntu@${workerHost}`,
    `mkdir -p ${shq(`${remoteRoot}/artifacts`)}`,
  ]);
  await runLocal("scp", [
    ...sshBase,
    local,
    `ubuntu@${workerHost}:${remoteRoot}/artifacts/swarm-harness.tgz`,
  ]);
}

async function startGraderProxyOnWorkers(workers: NonNullable<PoolManifest["workers"]>): Promise<void> {
  await fs.access(GRADER_PROXY_HELPER);
  await Promise.all(workers.map(async (worker) => {
    const workerHost = worker.public_ip ?? worker.public_dns;
    if (!workerHost) throw new Error(`worker has no public host: ${JSON.stringify(worker)}`);
    console.error(`[tac-pool] start grader proxy on ${worker.name ?? workerHost}`);
    await syncGraderProxyHelper(workerHost);
    await runRemoteGraderProxy(workerHost);
  }));
}

async function syncGraderProxyHelper(workerHost: string): Promise<void> {
  const key = process.env.EC2_SSH_KEY_PATH;
  if (!key) throw new Error("EC2_SSH_KEY_PATH is required to sync TAC grader proxy helper");
  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-i", key,
  ];
  const remoteScripts = `${REMOTE_POOL_ROOT}/scripts`;
  await runLocal("ssh", [
    ...sshBase,
    `ubuntu@${workerHost}`,
    `mkdir -p ${shq(remoteScripts)}`,
  ]);
  await runLocal("scp", [
    ...sshBase,
    path.resolve(GRADER_PROXY_HELPER),
    `ubuntu@${workerHost}:${remoteScripts}/start-litellm-bedrock-proxy.sh`,
  ]);
}

async function runRemoteGraderProxy(workerHost: string): Promise<void> {
  const key = process.env.EC2_SSH_KEY_PATH;
  if (!key) throw new Error("EC2_SSH_KEY_PATH is required to start TAC grader proxy");
  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-i", key,
  ];
  const envKeys = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "TAC_GRADER_PROXY_HOST",
    "TAC_GRADER_PROXY_PORT",
    "TAC_GRADER_PROXY_MODEL",
    "TAC_GRADER_PROXY_KEY",
    "TAC_GRADER_BEDROCK_MODEL",
    "TAC_GRADER_BEDROCK_REGION",
    "TAC_GRADER_PROXY_STATE_DIR",
    "TAC_GRADER_PROXY_START_TIMEOUT_SEC",
  ];
  const assignments = envKeys
    .flatMap((keyName) => process.env[keyName] ? [`${keyName}=${shq(process.env[keyName]!)}`] : [])
    .join(" ");
  const helper = `${REMOTE_POOL_ROOT}/scripts/start-litellm-bedrock-proxy.sh`;
  await runLocal("ssh", [
    ...sshBase,
    `ubuntu@${workerHost}`,
    `env ${assignments} bash ${shq(helper)}`,
  ]);
}

function runLocal(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += String(d); });
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${code ?? "signal"}): ${stderr || stdout}`));
    });
    child.on("error", reject);
  });
}

async function readSingleResult(outDir: string): Promise<CellResult | undefined> {
  const cacheDir = path.join(outDir, "cache");
  let files: string[];
  try {
    files = await fs.readdir(cacheDir);
  } catch {
    return undefined;
  }
  const jsons = files.filter((f) => f.endsWith(".json") && !f.endsWith(".trace.json"));
  for (const file of jsons) {
    try {
      return JSON.parse(await fs.readFile(path.join(cacheDir, file), "utf8")) as CellResult;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

async function writeSummary(summaries: JobSummary[]): Promise<void> {
  await fs.writeFile(path.join(OUT, "summary.json"), JSON.stringify(summaries, null, 2));
  const lines = [
    "# TAC Pool Summary",
    "",
    "| task | arm | seed | status | S_partial | full | env | tokens | worker | duration_s |",
    "|---|---:|---:|---|---:|---|---|---:|---|---:|",
    ...summaries.map((s) => [
      s.taskId,
      s.armId,
      String(s.seed),
      s.status ?? (s.processTimedOut ? `process_timeout_${s.exitCode}` : `process_exit_${s.exitCode}`),
      s.partial === undefined ? "" : s.partial.toFixed(3),
      s.full === undefined ? "" : String(s.full),
      s.envErrorKind ?? "",
      s.totalTokens === undefined ? "" : String(s.totalTokens),
      s.worker,
      (s.durationMs / 1000).toFixed(1),
    ].map(escapeCell).join("|").replace(/^/, "|").replace(/$/, "|")),
    "",
  ];
  await fs.writeFile(path.join(OUT, "summary.md"), lines.join("\n"));
  console.log(`\n[tac-pool] summary: ${path.join(OUT, "summary.md")}`);
}

function readRegionFallback(): string | undefined {
  return undefined;
}

function jobId(job: TacPoolJob): string {
  return `${job.task.id}__${job.arm.id}__seed${job.seed}`;
}

function jobOutDir(job: TacPoolJob): string {
  return path.join(OUT, "cells", slug(jobId(job)));
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 140);
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

if (process.env.RUN_TAC_POOL) {
  await main();
} else {
  console.error("[tac-pool] dry: set RUN_TAC_POOL=1 and TAC_POOL_MANIFEST. See header.");
}
