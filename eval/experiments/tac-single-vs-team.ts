/**
 * tac-single-vs-team.ts — TheAgentCompany (marble) single-vs-team on a FAN-OUT task, on EC2.
 *
 * WHY: SWE-bench is the "single-wins" cell (sequential, shared-context, high-tool). TheAgentCompany's
 * fan-out tasks (e.g. close EVERY issue across ALL projects) are genuinely PARALLEL-DECOMPOSABLE with a
 * shared mutable substrate (live GitLab) — the cell where context-management, specialization, and
 * parallelism are *predicted* to make multi-agent beat single (docs/47 §next; arXiv 2512.08296). This
 * is the experiment that can show a CLEAR multi-agent win — and measure WHY via coordination KPIs
 * (redundancy/overlap), which is exactly where an atomic-claim substrate (the `graph` arm) should win.
 *
 * DESIGN (two passes, compared):
 *   single = width 1, arm `stock`              — one agent does the whole fan-out task.
 *   team   = width N (TAC_TEAM_WIDTH), arms ∈ {stock, notes, graph}
 *            stock = no coordination aid · notes = shared NOTES.md · graph = OpenTasks atomic-claim MCP.
 *   Compare: single vs team-stock (does adding agents help at all?) and team-stock vs team-graph
 *   (does the coordination substrate convert raw parallelism into a real gain by killing redundant work?).
 *
 * INFRA (heavy — GitLab is ~4 GB RAM / 11.86 GB image, too big for an E2B microVM, so it runs EXTERNAL
 * and the agents reach it; per the user, the agent fleet runs on EC2 because E2B wasn't big enough):
 *   1. A GitLab server reachable by the agents + the grader — `ghcr.io/theagentcompany/servers-gitlab:1.0.0`
 *      (host `docker run`, a dedicated VM, or on the EC2 host). Set TAC_GITLAB_URL (agents) + graderGitlab.
 *   2. An EC2 instance for the agent workspaces (attach mode: pass TAC_EC2_HOST + TAC_EC2_SSH_KEY; or
 *      launch mode: TAC_EC2_AMI + instance type). Security group must allow SSH + the GitLab port.
 *   3. The TAC task image (`ghcr.io/theagentcompany/<task>-image:1.0.0`) available where the per-cell
 *      init (pre_init gate + populate_data) runs — host-gitlab.ts drives it before each cell.
 *   4. Provider creds: Bedrock (CLAUDE_CODE_USE_BEDROCK + AWS_* ) or swap the agent adapter to swarm-harness.
 *
 * ENV:
 *   TAC_GITLAB_URL     URL agents use to reach GitLab (required)
 *   TAC_GITLAB_PORT    grader/host GitLab port (default 8929)
 *   TAC_TASK           default sde-close-all-gitlab-issues (a fan-out task)
 *   TAC_TEAM_WIDTH     agents in the team arm (default 3)
 *   TAC_TEAM_ARMS      csv of {stock,notes,graph} for the team pass (default stock,notes,graph)
 *   TAC_REPEATS        trials per cell for the stats bootstrap (default 3)
 *   TAC_ARM            run only "single" or "team" (default both)
 *   EC2: TAC_EC2_HOST | TAC_EC2_INSTANCE_ID (attach) OR TAC_EC2_AMI (launch); TAC_EC2_SSH_KEY,
 *        TAC_EC2_INSTANCE_TYPE (default m5.2xlarge), TAC_EC2_REGION, TAC_EC2_ROOT (default /workspace),
 *        TAC_EC2_SECURITY_GROUPS (csv), TAC_EC2_KEY_NAME
 *   Bedrock: CLAUDE_CODE_USE_BEDROCK, AWS_REGION (default ap-northeast-1 — fresh quota), AWS_* , ANTHROPIC_MODEL
 *
 * RUN (node/tsx, never bun):  source ~/.zshrc && RUN_TAC=1 tsx eval/experiments/tac-single-vs-team.ts
 * NOTE: this provisions/uses real EC2 + a heavy GitLab + pulls TAC images — confirm infra is up first.
 */
import {
  runEval,
  tacMarbleBenchmark,
  TAC_ARMS,
  Ec2Backend,
  LocalResultStore,
  SandboxedCliAdapter,
  type Ec2BackendOptions,
} from "swarmkit-eval";

const TASK = process.env.TAC_TASK ?? "sde-close-all-gitlab-issues";
const TEAM_WIDTH = Number(process.env.TAC_TEAM_WIDTH ?? 3);
const REPEATS = Number(process.env.TAC_REPEATS ?? 3);
const TEAM_ARM_IDS = (process.env.TAC_TEAM_ARMS ?? "stock,notes,graph").split(",").map((s) => s.trim());
const WHICH = process.env.TAC_ARM; // "single" | "team" | undefined (both)
const OUT = process.env.TAC_OUT ?? ".eval-runs";

const GITLAB_URL = process.env.TAC_GITLAB_URL;
const GITLAB_PORT = Number(process.env.TAC_GITLAB_PORT ?? 8929);
const MODEL = process.env.ANTHROPIC_MODEL ?? "apac.anthropic.claude-sonnet-4-20250514-v1:0";

/** Bedrock env forwarded into each agent sandbox (swap for swarm-harness + Azure later — see docs/47). */
function bedrockEnv(): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: process.env.AWS_REGION ?? "ap-northeast-1",
    ANTHROPIC_MODEL: MODEL,
  };
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

/** EC2 backend — attach to a running instance (TAC_EC2_HOST/INSTANCE_ID) or launch one (TAC_EC2_AMI). */
function ec2Options(): Ec2BackendOptions {
  const o: Ec2BackendOptions = {
    root: process.env.TAC_EC2_ROOT ?? "/workspace",
    ...(process.env.TAC_EC2_REGION ? { region: process.env.TAC_EC2_REGION } : {}),
    ...(process.env.TAC_EC2_SSH_KEY ? { sshKeyPath: process.env.TAC_EC2_SSH_KEY } : {}),
  } as Ec2BackendOptions;
  const extra = o as Record<string, unknown>;
  if (process.env.TAC_EC2_HOST) extra.host = process.env.TAC_EC2_HOST;
  else if (process.env.TAC_EC2_INSTANCE_ID) extra.instanceId = process.env.TAC_EC2_INSTANCE_ID;
  else if (process.env.TAC_EC2_AMI) {
    extra.amiId = process.env.TAC_EC2_AMI;
    extra.instanceType = process.env.TAC_EC2_INSTANCE_TYPE ?? "m5.2xlarge";
    if (process.env.TAC_EC2_KEY_NAME) extra.keyName = process.env.TAC_EC2_KEY_NAME;
    if (process.env.TAC_EC2_SECURITY_GROUPS) extra.securityGroupIds = process.env.TAC_EC2_SECURITY_GROUPS.split(",");
  } else {
    throw new Error("set TAC_EC2_HOST or TAC_EC2_INSTANCE_ID (attach) or TAC_EC2_AMI (launch)");
  }
  return o;
}

async function runWidth(label: string, width: number, armIds: string[]): Promise<void> {
  if (!GITLAB_URL) throw new Error("TAC_GITLAB_URL required (URL the agents use to reach GitLab)");
  const benchmark = await tacMarbleBenchmark({
    taskId: TASK,
    width,
    repeats: REPEATS,
    gitlab: { url: GITLAB_URL },
    graderGitlab: { host: process.env.TAC_GRADER_GITLAB_HOST ?? "host.docker.internal", port: GITLAB_PORT },
  });
  const arms = TAC_ARMS.filter((a) => armIds.includes(a.id));
  if (!arms.length) throw new Error(`no arms matched ${armIds.join(",")}`);

  const config = {
    runId: `tac-${TASK.replace(/[^a-z0-9]+/gi, "-")}`,
    configVersion: `v0-w${width}`,
    benchmark: benchmark.id,
    arms,
    models: [{ name: MODEL }],
    seeds: [1],
    backend: "ec2" as const,
    concurrency: { cells: 1, modelConnections: 1 },
    output: { dir: OUT, trace: true },
  };

  console.error(`[tac] ${label}: task=${TASK} width=${width} arms=${armIds.join(",")} repeats=${REPEATS} gitlab=${GITLAB_URL}`);
  const results = await runEval(config, {
    benchmark,
    backend: new Ec2Backend(ec2Options()),
    store: new LocalResultStore(OUT),
    marble: { agentAdapter: new SandboxedCliAdapter({ env: bedrockEnv(), timeoutMs: 1_200_000 }), maxParallelCells: 1 },
  });
  for (const r of results) {
    console.log(
      `  [${label}] ${r.armId} seed${r.seed}: status=${r.status} full=${r.score?.full} ` +
        `partial=${r.score?.partial} kpis=${JSON.stringify(r.score?.metrics ?? {})}`,
    );
  }
}

async function main(): Promise<void> {
  // single = width 1 (one agent, no coordination); team = width N across coordination arms.
  if (WHICH !== "team") await runWidth("single", 1, ["stock"]);
  if (WHICH !== "single") await runWidth("team", TEAM_WIDTH, TEAM_ARM_IDS);
  console.error("[tac] done — compare single(stock) vs team(stock) vs team(graph); watch S_partial + redundancy KPIs.");
}

if (process.env.RUN_TAC) {
  await main();
} else {
  console.error("[tac] dry: set RUN_TAC=1 (+ TAC_GITLAB_URL, EC2 + Bedrock env, TAC services up). See header.");
}
