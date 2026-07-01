/**
 * tac.ts — run TheAgentCompany on the SHARED swarmkit-eval TAC adapter (Phase 4).
 *
 * Proves the migration: swarm-coder runs TAC via swarmkit-eval's ported `TacDockerAdapter`
 * (single agent × stock/notes/opentasks coordination arms — the autonomation RCT), with NO
 * opentasks dependency. The multi-agent single-vs-team variant lives in tac-single-vs-team.ts (marble).
 *
 * Backends: in-process (fake plumbing), e2b, ec2 (Docker-capable). Self-grading (TAC result.json → S_partial).
 *
 * EC2 worker bringup (IMPORTANT — verified 2026-06-25): the baked AMI carries the TAC images, but a
 * BARE Ec2Backend LAUNCH does NOT bring the service containers up — with bootstrap_tac=false the
 * user-data only starts Docker; start_gitlab_direct/api-server run only under bootstrap_tac=true (or a
 * preseeded docker-volume snapshot), and the AMI's baked container state is inconsistent after the
 * bake's instance-stop. So for EC2 use either: (a) ATTACH mode (EC2_HOST=<a worker already brought up
 * by run-ec2-pool.sh / bootstrap_tac=true>), or (b) pass bootstrap user-data to the launch. The bare
 * EC2_AMI_ID launch below validates the infra chain (launch→SSH→workspace→readiness) but stops at TAC
 * init because GitLab isn't up; use swarmkit-eval adapters/tac/scripts/run-ec2-pool.sh for real runs.
 *
 * Run under node/tsx (never bun):
 *   # fake plumbing smoke (no Docker, no spend):
 *   EVAL_FAKE=1 TAC_ROLE=sde TAC_DEPS=gitlab EVAL_TASK_LIMIT=2 RUN_TAC=1 tsx eval/experiments/tac.ts
 *   # real on EC2 — ATTACH to a brought-up worker + wait for the baked services to be healthy:
 *   EVAL_BACKEND=ec2 EC2_HOST=<worker-ip> EC2_SSH_KEY_PATH=<key> EC2_ROOT=/home/ubuntu/tac-run \
 *     EC2_SECURITY_GROUP_IDS=<ssh-sg> TAC_ROLE=sde TAC_DEPS=gitlab EVAL_ARMS=stock \
 *     EC2_SETUP_COMMANDS='for i in $(seq 1 72); do curl -fsS http://127.0.0.1:2999/api/healthcheck/gitlab >/dev/null 2>&1 && break; sleep 10; done; curl -fsS http://127.0.0.1:2999/api/healthcheck/gitlab >/dev/null' \
 *     RUN_TAC=1 tsx eval/experiments/tac.ts
 *
 * Env: EVAL_FAKE, EVAL_BACKEND(in-process|e2b|ec2), EVAL_ARMS(stock,notes,opentasks,acceptance), EVAL_MODEL,
 *   EVAL_REPEATS/EVAL_SEEDS, EVAL_TASK_LIMIT, TAC_ROOT(default ~/GitHub/TheAgentCompany), the TAC selector
 *   (TAC_ROLE/TAC_DEPS/EVAL_TASKS), and the backend env (EC2_ and E2B_ vars, — see swarmkit-eval).
 */
import * as path from "node:path";
import {
  E2BBackend,
  Ec2Backend,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  runEval,
  tacDockerBenchmark,
  tacSelectorFromEnv,
  tacDockerAdapterFromEnv,
  TacFakeAdapter,
  type BackendId,
  type EvalConfig,
  type ExecutionBackend,
  type RunDeps,
} from "swarmkit-eval";
import { tacExperimentArms } from "./tac-arms.js";

const MODEL = process.env.EVAL_MODEL ?? "haiku";
const ARM_IDS = (process.env.EVAL_ARMS ?? "stock,notes,opentasks").split(",").map((s) => s.trim());
const REPEATS = Number(process.env.EVAL_REPEATS ?? 1);
const SEEDS = process.env.EVAL_SEEDS
  ? process.env.EVAL_SEEDS.split(",").map((s) => Number(s.trim()))
  : Array.from({ length: REPEATS }, (_, i) => i + 1);
const LIMIT = process.env.EVAL_TASK_LIMIT ? Number(process.env.EVAL_TASK_LIMIT) : undefined;
const FAKE = process.env.EVAL_FAKE === "1";
const TAC_ROOT = process.env.TAC_ROOT ?? `${process.env.HOME}/GitHub/TheAgentCompany`;
const BACKEND = (process.env.EVAL_BACKEND ?? "in-process") as BackendId;
const OUT = path.resolve(process.cwd(), process.env.EVAL_OUT_DIR ?? ".eval-runs/tac");

function buildBackend(): ExecutionBackend {
  if (BACKEND === "in-process") return new InProcessBackend();
  if (BACKEND === "e2b") {
    return new E2BBackend({
      template: process.env.E2B_TEMPLATE ?? "",
      timeoutMs: Number(process.env.E2B_TIMEOUT ?? 1_800_000),
      ...(process.env.E2B_ROOT ? { root: process.env.E2B_ROOT } : {}),
    });
  }
  if (BACKEND === "ec2") {
    return new Ec2Backend({
      region: process.env.EC2_REGION ?? process.env.AWS_REGION,
      host: process.env.EC2_HOST,
      instanceId: process.env.EC2_INSTANCE_ID,
      amiId: process.env.EC2_AMI_ID,
      instanceType: process.env.EC2_INSTANCE_TYPE,
      keyName: process.env.EC2_KEY_NAME,
      securityGroupIds: process.env.EC2_SECURITY_GROUP_IDS?.split(","),
      sshKeyPath: process.env.EC2_SSH_KEY_PATH,
      root: process.env.EC2_ROOT ?? "/workspace",
      // Forward the agent's model creds + grader-proxy config INTO the instance (the agent calls
      // Bedrock from the EC2 box). Mirrors opentasks run.ts passEc2Env.
      env: passEc2Env(),
      // Setup commands run after SSH-ready, before the cell — used to WAIT for the baked TAC
      // services (gitlab + api-server, --restart always) to become healthy on a fresh boot.
      // Separate multiple commands with ';;'. See header for the readiness-wait one-liner.
      setupCommands: process.env.EC2_SETUP_COMMANDS
        ? process.env.EC2_SETUP_COMMANDS.split(";;").map((s) => s.trim()).filter(Boolean)
        : undefined,
      setupTimeoutMs: process.env.EC2_SETUP_TIMEOUT ? Number(process.env.EC2_SETUP_TIMEOUT) : undefined,
    } as ConstructorParameters<typeof Ec2Backend>[0]);
  }
  throw new Error(`Unsupported EVAL_BACKEND=${BACKEND} (use in-process|e2b|ec2)`);
}

/** Env forwarded into the EC2 instance so the in-box agent + grader reach Bedrock/litellm. */
function passEc2Env(): Record<string, string> {
  const keys = [
    "CLAUDE_CODE_USE_BEDROCK", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
    "LITELLM_API_KEY", "LITELLM_BASE_URL", "LITELLM_MODEL",
    "TAC_GRADER_PROXY", "TAC_GRADER_PROXY_HOST", "TAC_GRADER_PROXY_PORT", "TAC_GRADER_PROXY_MODEL",
    "TAC_GRADER_PROXY_KEY", "TAC_GRADER_BEDROCK_MODEL", "TAC_GRADER_BEDROCK_REGION",
    "TAC_AGENT_SETUP_CMD", "TAC_PREFLIGHT_ONLY", "TAC_ENV_PREFLIGHT", "TAC_EVAL_LLM_PREFLIGHT",
    "TAC_GITLAB_SERVICE_RESET", "TAC_GITLAB_TOKEN_REFRESH", "TAC_GITLAB_WIKI_SMOKE",
    "TAC_GITLAB_WIKI_SMOKE_REQUIRE_GIT", "TAC_GITLAB_WIKI_TARGET_SMOKE_PROJECT",
    "TAC_SWARM_HARNESS_VERSION", "TAC_SWARM_HARNESS_MODE", "TAC_SWARM_HARNESS_CONCURRENCY",
    "TAC_SWARM_HARNESS_TASKS", "TAC_SWARM_HARNESS_AGENTS",
    "TAC_SWARM_HARNESS_MULTIAGENT_PROMPT", "TAC_SWARM_HARNESS_ROLE_POLICY", "TAC_SWARM_HARNESS_OPENTASKS",
    "TAC_TEAM_PROTOCOL",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

async function main(): Promise<void> {
  if (FAKE && BACKEND !== "in-process") throw new Error("EVAL_FAKE=1 only supports EVAL_BACKEND=in-process");
  // The in-sandbox agent must run as a NON-root user (claude-code refuses --dangerously-skip-permissions
  // as root). opentasks's run-pool defaults this; mirror it so the docker-adapter never runs the agent as
  // root. tacDefaultAgentSetupCommand then creates this user.
  process.env.TAC_AGENT_USER ??= "agent";

  const selector = tacSelectorFromEnv();
  const benchmark = tacDockerBenchmark({ root: TAC_ROOT, selector });
  const arms = tacExperimentArms(ARM_IDS);

  const config: EvalConfig = {
    runId: `tac-${MODEL}-${FAKE ? "fake" : BACKEND}`,
    configVersion: process.env.EVAL_CONFIG_VERSION ?? "tac-v2",
    benchmark: "theagentcompany",
    arms,
    models: [{ name: MODEL }],
    seeds: SEEDS,
    backend: BACKEND,
    concurrency: { cells: Number(process.env.EVAL_CONCURRENCY ?? 1), modelConnections: Number(process.env.EVAL_CONCURRENCY ?? 1) },
    output: { dir: OUT, trace: true },
    ...(LIMIT !== undefined ? { taskLimit: LIMIT } : {}),
  };
  const deps: RunDeps = {
    benchmark,
    adapter: FAKE ? new TacFakeAdapter() : tacDockerAdapterFromEnv(),
    backend: buildBackend(),
    store: new LocalResultStore(OUT),
  };

  console.error(`[tac] model=${MODEL} arms=${ARM_IDS.join(",")} seeds=${SEEDS.join(",")} root=${TAC_ROOT} [${FAKE ? "FAKE" : `DOCKER:${BACKEND}`}]`);
  const results = await runEval(config, deps);
  for (const r of results) {
    console.error(`  ${r.taskId} | ${r.armId.padEnd(9)} seed${r.seed}: ${r.status} S_partial=${(r.score?.partial ?? 0).toFixed(2)} full=${r.score?.full ?? false}`);
  }
  const baseline = ARM_IDS.includes("stock") ? "stock" : ARM_IDS[0]!;
  console.log("\n" + renderMarkdownReport(buildReport(results, config, { baselineArmId: baseline, accuracyMetric: "sPartial" })));
}

if (process.env.RUN_TAC) {
  await main();
} else {
  console.error("[tac] dry: set RUN_TAC=1 (+ EVAL_FAKE=1 for the no-spend plumbing smoke). See header.");
}
