/**
 * diag-sandbox.ts — one-off: boot the built H1 template and see what openswarm actually does
 * under Bedrock-direct auth (the cell graded 0-token/1.3s, so the model was never engaged).
 *
 * Run:  source ~/.zshrc; bun eval/scripts/diag-sandbox.ts [templateName]
 */
import { Sandbox } from "e2b";

const template = process.argv[2] ?? "sh-h1-django__django-11099";
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("set E2B_API_KEY (source ~/.zshrc)");

const envs: Record<string, string> = { CLAUDE_CODE_USE_BEDROCK: "1" };
for (const k of ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
  const v = process.env[k];
  if (v) envs[k] = v;
}
if (!envs.AWS_REGION && !envs.AWS_DEFAULT_REGION) envs.AWS_REGION = "us-east-1";
console.error(`[diag] bedrock env keys: ${Object.keys(envs).join(", ")}`);

const SH = "/opt/node/bin/openswarm";
async function run(sbx: Sandbox, label: string, cmd: string): Promise<void> {
  console.log(`\n========== ${label} ==========\n$ ${cmd}`);
  try {
    const r = await sbx.commands.run(cmd, { envs, timeoutMs: 120_000, user: "root" });
    console.log(`exit=${r.exitCode}`);
    console.log(`--- stdout ---\n${(r.stdout ?? "").slice(0, 4000)}`);
    console.log(`--- stderr ---\n${(r.stderr ?? "").slice(0, 4000)}`);
  } catch (e) {
    // e2b throws CommandExitError on non-zero exit — it carries stdout/stderr/exitCode.
    const ce = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
    console.log(`exit=${ce.exitCode ?? "?"} (threw)`);
    console.log(`--- stdout ---\n${(ce.stdout ?? "").slice(0, 4000)}`);
    console.log(`--- stderr ---\n${(ce.stderr ?? "").slice(0, 4000)}`);
    if (!ce.stdout && !ce.stderr) console.log(`(no streams) message=${ce.message}`);
  }
}

const sbx = await Sandbox.create(template, { apiKey });
console.error(`[diag] sandbox ${sbx.sandboxId} from template ${template}`);
try {
  await run(sbx, "version", `${SH} --version`);
  await run(sbx, "doctor", `${SH} doctor --output-format json || ${SH} doctor`);
  await run(sbx, "prompt-run", `cd /testbed && ${SH} --single --headless --output-format json --model claude-sonnet-4-6 --permission-mode danger-full-access "Reply with the single word hello. Do not modify any files."`);
} finally {
  await sbx.kill();
  console.error("[diag] sandbox killed");
}
