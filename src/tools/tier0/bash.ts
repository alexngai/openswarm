import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { headTailTruncate } from "./internal.js";
import { getHardenedEnv } from "./process-hardening.js";
import { spawnSandboxed, type SandboxPolicy } from "./sandbox.js";
import { cleanOutput } from "./output-cleanse.js";

let _sandboxPolicy: SandboxPolicy = "prefer";

const inputSchema = z.object({
  command: z.string(),
  timeout: z.number().positive().optional(),
  background: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

const DEFAULT_TIMEOUT_MS = 30_000;

const spec: ToolSpec = {
  name: "bash",
  description:
    "Run a one-shot shell command via /bin/bash. " +
    "Long output is smart-truncated: first 20 KiB + last 20 KiB are preserved. " +
    "Default timeout is 30000 ms; override with `timeout` (ms). " +
    "On timeout the process is killed and output includes a [interrupted: timeout] marker. " +
    "Non-zero exit codes are returned as [exit <code>] in the output — the model decides what to do. " +
    "Set `background: true` to spawn detached without waiting; returns [backgroundTaskId: <pid>] immediately. " +
    "For interactive workflows (REPLs, servers, debuggers), use `shell_exec` instead.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 0,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const cwd = ctx.cwd;
  const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;

  const sandboxConfig = {
    writableRoots: [] as string[],
    cwd,
    env: getHardenedEnv(),
    policy: _sandboxPolicy,
  };

  // Background mode: spawn detached, don't wait.
  if (input.background) {
    const child = await spawnSandboxed(
      "/bin/bash",
      ["-c", input.command],
      { cwd, detached: true, stdio: "ignore" },
      sandboxConfig,
    );
    child.unref();
    return { status: "ok", output: `[backgroundTaskId: ${child.pid}]` };
  }

  return new Promise<ToolResult>(async (resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = await spawnSandboxed(
      "/bin/bash",
      ["-c", input.command],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
      sandboxConfig,
    );

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Honor abort signal.
    const onAbort = () => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    };
    ctx.abort?.addEventListener("abort", onAbort);

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.abort?.removeEventListener("abort", onAbort);

      // Cleanse first (strip ANSI/progress noise, redact secrets, elide long
      // lines), then head/tail truncate the cleansed bytes. Cleansing before
      // truncation means the preserved head/tail carry signal, not escape codes.
      const cleanse = (chunks: Buffer[]): string => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const cleaned = cleanOutput(raw, { command: input.command }).text;
        return headTailTruncate(Buffer.from(cleaned, "utf8"));
      };

      const stdout = cleanse(stdoutChunks);
      const stderr = cleanse(stderrChunks);

      let output = stdout;
      if (stderr) {
        output += `\n---\nSTDERR:\n${stderr}`;
      }

      if (timedOut) {
        output += "\n[interrupted: timeout]";
        resolve({ status: "ok", output });
        return;
      }

      if (ctx.abort?.aborted) {
        output += "\n[interrupted: aborted]";
        resolve({ status: "ok", output });
        return;
      }

      if (code !== 0 && code !== null) {
        output += `\n[exit ${code}]`;
      }

      resolve({ status: "ok", output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.abort?.removeEventListener("abort", onAbort);
      resolve({ status: "error", message: err.message });
    });
  });
}

export function setBashSandboxPolicy(policy: SandboxPolicy): void {
  _sandboxPolicy = policy;
}

export const bashTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
