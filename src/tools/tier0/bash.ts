/**
 * bash — one-shot shell command execution, Claude Code-aligned.
 *
 * Output handling verified against the Claude Code v2.1.198 bundle
 * (docs/04-tool-tiers.md, "Claude Code schema alignment"):
 *   - stdout and stderr are collected separately; the result is stdout
 *     (leading blank lines stripped, trailing whitespace trimmed) followed
 *     by stderr on its own line — not interleaved, not labeled.
 *   - stdout is head-truncated at 30,000 chars with a
 *     "... [N lines truncated] ..." marker (BASH_MAX_OUTPUT_LENGTH).
 *   - non-zero exit is an error whose message is "Exit code N" first, then
 *     stderr, then stdout, middle-truncated at 10,000 chars with
 *     "... [N characters truncated] ...".
 *   - timeouts surface as "Command timed out after 2m 0s" (humanized).
 *   - aborts append "<error>Command was aborted before completion</error>".
 *   - background commands stream to an output file and return
 *     "Command running in background with ID: ...".
 */

import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { aliasParams } from "./internal.js";
import { getHardenedEnv } from "./process-hardening.js";
import { spawnSandboxed, type SandboxPolicy } from "./sandbox.js";
import { cleanOutput } from "./output-cleanse.js";

let _sandboxPolicy: SandboxPolicy = "prefer";

const paramsSchema = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z
    .number()
    .positive()
    .optional()
    .describe("Optional timeout in milliseconds (max 600000; default 120000)"),
  description: z
    .string()
    .optional()
    .describe("Clear, concise description of what this command does in 5-10 words"),
  workdir: z
    .string()
    .optional()
    .describe(
      "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe("Set to true to run this command in the background without waiting."),
});

const inputSchema = z.preprocess(
  aliasParams({ background: "run_in_background" }),
  paramsSchema,
);

type Input = z.infer<typeof paramsSchema>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Claude Code's BASH_MAX_OUTPUT_LENGTH default. */
const MAX_OUTPUT_CHARS = 30_000;
/** Error-result cap (Claude Code truncates error content at 10k chars). */
const MAX_ERROR_CHARS = 10_000;

const spec: ToolSpec = {
  name: "bash",
  description:
    "Run a one-shot shell command via /bin/bash. " +
    "Use `workdir` to run in a different directory instead of `cd <dir> && ...`. " +
    `If the output exceeds ${MAX_OUTPUT_CHARS} characters, output will be truncated before being returned to you. ` +
    "Default timeout is 120000 ms (2 minutes); override with `timeout` (ms, max 600000). " +
    "Commands that time out or exit non-zero return an error result that includes " +
    "the exit code and command output. " +
    "Set `run_in_background: true` to run without waiting; output is written to a file you can inspect. " +
    "For interactive workflows (REPLs, servers, debuggers), use `shell_exec` instead.",
  inputSchema: z.toJSONSchema(paramsSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 0,
};

/**
 * Humanized duration, matching Claude Code's formatter: "45s", "2m 0s",
 * "1h 2m 3s".
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    if (ms === 0) return "0s";
    if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 1000)}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

/**
 * Head truncation at `max` chars with a trailing lines-truncated marker —
 * Claude Code's stdout truncation shape.
 */
export function truncateOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let truncatedLines = 1;
  for (let i = max; i < text.length; i++) {
    if (text[i] === "\n") truncatedLines++;
  }
  return `${head}\n\n... [${truncatedLines} lines truncated] ...`;
}

/**
 * Middle truncation for error content: first 5000 + last 5000 chars with a
 * chars-truncated marker — Claude Code's error formatting shape.
 */
function truncateErrorContent(text: string): string {
  if (text.length <= MAX_ERROR_CHARS) return text;
  const keep = MAX_ERROR_CHARS / 2;
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n... [${omitted} characters truncated] ...\n\n${tail}`;
}

/** stdout normalization: strip leading blank lines, trim trailing whitespace. */
function normalizeStdout(text: string): string {
  return text.replace(/^(\s*\n)+/, "").trimEnd();
}

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const cwd = input.workdir !== undefined ? path.resolve(ctx.cwd, input.workdir) : ctx.cwd;
  const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const sandboxConfig = {
    writableRoots: [] as string[],
    cwd,
    env: getHardenedEnv(),
    policy: _sandboxPolicy,
  };

  // Background mode: stream combined output to a file and return immediately
  // (Claude Code shape: "Command running in background with ID: ...").
  if (input.run_in_background) {
    const rand = crypto.randomBytes(4).toString("hex");
    const outFile = path.join(os.tmpdir(), `openswarm-bash-${rand}.out`);
    const fd = fsSync.openSync(outFile, "w");
    const child = await spawnSandboxed(
      "/bin/bash",
      ["-c", input.command],
      { cwd, detached: true, stdio: ["ignore", fd, fd] },
      sandboxConfig,
    );
    fsSync.closeSync(fd);
    child.unref();
    return {
      status: "ok",
      output:
        `Command running in background with ID: ${child.pid}. ` +
        `Output is being written to: ${outFile}. ` +
        `To check interim output, read that file (e.g. \`tail ${outFile}\`).`,
    };
  }

  return new Promise<ToolResult>(async (resolve) => {
    // stdout and stderr are collected separately (Claude Code behavior):
    // the tool result is stdout followed by stderr, not an interleaved stream.
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

      // Cleanse (strip ANSI/progress noise, redact secrets) before truncating
      // so the preserved head carries signal, not escape codes.
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf8");
      const rawStderr = Buffer.concat(stderrChunks).toString("utf8");
      const stdout = truncateOutput(
        normalizeStdout(cleanOutput(rawStdout, { command: input.command }).text),
      );
      let stderr = cleanOutput(rawStderr, { command: input.command }).text.trim();

      if (timedOut) {
        stderr = `${stderr ? `${stderr}\n` : ""}Command timed out after ${formatDuration(timeoutMs)}`;
        resolve({
          status: "error",
          message: truncateErrorContent(
            [stderr, stdout].filter(Boolean).join("\n"),
          ),
        });
        return;
      }

      if (ctx.abort?.aborted) {
        const abortNote = `${stderr ? `${stderr}\n` : ""}<error>Command was aborted before completion</error>`;
        resolve({
          status: "error",
          message: [stdout, abortNote].filter(Boolean).join("\n"),
        });
        return;
      }

      // Non-zero exit is an error result (Claude Code behavior): "Exit code N"
      // first, then stderr, then stdout, middle-truncated at 10k chars.
      if (code !== 0 && code !== null) {
        const content =
          [`Exit code ${code}`, stderr, stdout].filter(Boolean).join("\n").trim() ||
          "Command failed with no output";
        resolve({ status: "error", message: truncateErrorContent(content) });
        return;
      }

      resolve({
        status: "ok",
        output: [stdout, stderr].filter(Boolean).join("\n"),
      });
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
