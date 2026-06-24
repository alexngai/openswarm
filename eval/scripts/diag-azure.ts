/** diag-azure.ts — probe why the single-agent azureoai run fast-fails in the sandbox.
 *  Run under node: source ~/.zshrc && tsx eval/scripts/diag-azure.ts */
import { Sandbox } from "e2b";

const template = process.argv[2] ?? "sh-h1-astropy__astropy-13398";
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error("set E2B_API_KEY");

const envs: Record<string, string> = {};
for (const k of ["AZURE_API_BASE", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_VERSION"]) {
  const v = process.env[k];
  if (v) envs[k] = v;
}
if (!envs.AZURE_OPENAI_API_VERSION) envs.AZURE_OPENAI_API_VERSION = "2024-08-01-preview";
console.error(`[diag] azure env keys: ${Object.keys(envs).join(", ")}`);

const SH = "/opt/node/bin/swarm-harness";
const sbx = await Sandbox.create(template, { apiKey });
console.error(`[diag] sandbox ${sbx.sandboxId}`);
async function run(label: string, cmd: string): Promise<void> {
  console.log(`\n===== ${label} =====\n$ ${cmd}`);
  try {
    const r = await sbx.commands.run(cmd, { envs, timeoutMs: 120_000, user: "root" });
    console.log(`exit=${r.exitCode}\n--stdout--\n${(r.stdout ?? "").slice(0, 2500)}\n--stderr--\n${(r.stderr ?? "").slice(0, 2500)}`);
  } catch (e) {
    const ce = e as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
    console.log(`exit=${ce.exitCode ?? "?"} (threw)\n--stdout--\n${(ce.stdout ?? "").slice(0, 2500)}\n--stderr--\n${(ce.stderr ?? "").slice(0, 2500)}\n${ce.stdout || ce.stderr ? "" : ce.message}`);
  }
}
try {
  await run("which + version", `${SH} --version 2>&1; echo "bin: $(command -v swarm-harness)"`);
  await run("azure tool-use run", `cd /testbed && ${SH} "Use your bash tool to run 'ls' here, then use your file-writing tool to create a file named PROOF.txt containing the single word DONE. Then stop." --model azureoai/gpt-4.1 --permission-mode danger-full-access --headless --output-format json`);
  await run("did it create the file?", `cat /testbed/PROOF.txt 2>&1 || echo "PROOF.txt NOT created"`);
} finally {
  await sbx.kill();
  console.error("[diag] killed");
}
