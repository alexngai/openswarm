import { spawn } from "node:child_process";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { truncateUtf8 } from "./internal.js";

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
    "Run a shell command via /bin/bash. " +
    "stdout and stderr are captured separately and each truncated to 16 KiB. " +
    "Default timeout is 30000 ms; override with `timeout` (ms). " +
    "On timeout the process is killed and output includes a [interrupted: timeout] marker. " +
    "Non-zero exit codes are returned as [exit <code>] in the output — the model decides what to do. " +
    "Set `background: true` to spawn detached without waiting; returns [backgroundTaskId: <pid>] immediately.",
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

  // Background mode: spawn detached, don't wait.
  if (input.background) {
    const child = spawn("/bin/bash", ["-c", input.command], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { status: "ok", output: `[backgroundTaskId: ${child.pid}]` };
  }

  return new Promise<ToolResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn("/bin/bash", ["-c", input.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

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

      const stdout = truncateUtf8(Buffer.concat(stdoutChunks));
      const stderr = truncateUtf8(Buffer.concat(stderrChunks));

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

export const bashTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
