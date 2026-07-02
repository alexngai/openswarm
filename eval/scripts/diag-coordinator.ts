/**
 * diag-coordinator.ts — see what `openswarm topology coordinator --spec` actually does in-sandbox
 * (the team cell failed in 10s / 0 tokens). Run under NODE: tsx eval/scripts/diag-coordinator.ts [template]
 */
import { Sandbox } from "e2b";

const template = process.argv[2] ?? "sh-h1-astropy__astropy-12907";
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("set E2B_API_KEY (source ~/.zshrc)");
const MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const envs: Record<string, string> = { CLAUDE_CODE_USE_BEDROCK: "1" };
for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
  const v = process.env[k];
  if (v) envs[k] = v;
}
if (!envs.AWS_REGION && !envs.AWS_DEFAULT_REGION) envs.AWS_REGION = "us-east-1";
envs.OPENSWARM_MODEL = MODEL; // does pinning this make the spawned coordinator workers use Bedrock?

const spec = {
  name: "h1-team",
  topology: "coordinator",
  members: [
    { role: "architect", prompt: "Reply with the word hello. Change nothing.", longLived: true, model: MODEL },
    { role: "executor", prompt: "Implement the change.", model: MODEL },
    { role: "reviewer", prompt: "Review the change.", model: MODEL },
  ],
  coordination: { completion: { kind: "all" } },
};

const SH = "/opt/node/bin/openswarm";
async function run(sbx: Sandbox, label: string, cmd: string): Promise<void> {
  console.log(`\n===== ${label} =====\n$ ${cmd}`);
  try {
    const r = await sbx.commands.run(cmd, { envs, timeoutMs: 180_000, user: "root" });
    console.log(`exit=${r.exitCode}\n--stdout--\n${(r.stdout ?? "").slice(0, 4000)}\n--stderr--\n${(r.stderr ?? "").slice(0, 4000)}`);
  } catch (e) {
    const ce = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
    console.log(`exit=${ce.exitCode ?? "?"} (threw)\n--stdout--\n${(ce.stdout ?? "").slice(0, 4000)}\n--stderr--\n${(ce.stderr ?? "").slice(0, 4000)}`);
    if (!ce.stdout && !ce.stderr) console.log(`(no streams) ${ce.message}`);
  }
}

const sbx = await Sandbox.create(template, { apiKey });
console.error(`[diag] sandbox ${sbx.sandboxId}`);
try {
  await sbx.files.write("/tmp/team.json", JSON.stringify(spec, null, 2), { user: "root" });
  // Workaround test: redirect the worker's default model NAME(s) to the Bedrock id via user aliases.
  await sbx.commands.run("mkdir -p /root/.openswarm", { user: "root" }).catch(() => undefined);
  await sbx.files.write(
    "/root/.openswarm/settings.json",
    JSON.stringify({ aliases: { sonnet: MODEL, "claude-sonnet-4-6": MODEL, "claude-sonnet-4-5": MODEL } }),
    { user: "root" },
  );
  await run(sbx, "topology --help", `${SH} topology 2>&1 || true`);
  await run(sbx, "coordinator run", `cd /testbed && ${SH} topology coordinator --spec /tmp/team.json --output /tmp/res.jsonl --model ${MODEL} --permission-mode danger-full-access --headless --output-format json`);
  await run(sbx, "results file", `echo "--- /tmp/res.jsonl ---"; cat /tmp/res.jsonl 2>&1 | head -40; echo "--- cwd .sbx results? ---"; ls -la /testbed/.sbx 2>&1 | head`);
} finally {
  await sbx.kill();
  console.error("[diag] killed");
}
