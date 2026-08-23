/**
 * bash — one-shot shell command execution, Claude Code-aligned.
 *
 * Output handling verified against the Claude Code v2.1.198 bundle
 * (docs/04-tool-tiers.md, "Claude Code schema alignment"):
 *   - stdout and stderr are collected separately; the result is stdout
 *     (leading blank lines stripped, trailing whitespace trimmed) followed
 *     by stderr on its own line — not interleaved, not labeled.
 *   - stdout is truncated at 30,000 chars (BASH_MAX_OUTPUT_LENGTH), keeping
 *     head AND tail with a middle "... [N lines truncated] ..." marker —
 *     deliberate deviation from Claude Code's head-only shape (docs/53 TE-6):
 *     test/build verdicts live at the END of long output. The full output is
 *     spilled to a temp file the marker points at, so nothing is lost.
 *   - non-zero exit is an error whose message is "Exit code N" first, then
 *     stderr, then stdout, middle-truncated at 10,000 chars with
 *     "... [N characters truncated] ..." (also spilled when truncated).
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
import { ToolAccesses } from "../access.js";
import { aliasParams } from "./internal.js";
import { BoundedOutput, DEFAULT_RETAIN_BYTES } from "./bounded-output.js";
import { getHardenedEnv } from "./process-hardening.js";
import type { SandboxPolicy } from "./sandbox.js";
import { getProcessBroker } from "../../process/broker.js";
import { cleanOutput } from "./output-cleanse.js";

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
    `If the output exceeds ${MAX_OUTPUT_CHARS} characters, the middle is truncated (start and end kept) ` +
    "and the complete output is saved to a file whose path appears in the truncation marker — " +
    "read or grep that file instead of re-running the command. " +
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
 * Head+tail truncation at `max` chars with a middle lines-truncated marker.
 * Keeps the start (command banner/context) AND the end (errors, test verdicts)
 * of long output — docs/53 TE-6; pi keeps the tail for the same reason. When
 * `fullOutputPath` is set the marker names it so the elided middle is
 * recoverable without re-running the command.
 */
export function truncateOutput(
  text: string,
  max: number = MAX_OUTPUT_CHARS,
  fullOutputPath?: string,
): string {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  let truncatedLines = 1;
  for (let i = keep; i < text.length - keep; i++) {
    if (text[i] === "\n") truncatedLines++;
  }
  const where = fullOutputPath !== undefined ? `; full output: ${fullOutputPath}` : "";
  return `${head}\n\n... [${truncatedLines} lines truncated${where}] ...\n\n${tail}`;
}

/**
 * Middle truncation for error content: first 5000 + last 5000 chars with a
 * chars-truncated marker — Claude Code's error formatting shape. The optional
 * `fullOutputPath` names the spilled complete content (docs/53 TE-6).
 */
function truncateErrorContent(text: string, fullOutputPath?: string): string {
  if (text.length <= MAX_ERROR_CHARS) return text;
  const keep = MAX_ERROR_CHARS / 2;
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const omitted = text.length - head.length - tail.length;
  const where = fullOutputPath !== undefined ? `; full output: ${fullOutputPath}` : "";
  return `${head}\n\n... [${omitted} characters truncated${where}] ...\n\n${tail}`;
}

/**
 * Best-effort spill of full (cleansed) output to a temp file so truncation is
 * lossless. Returns undefined when the write fails — the marker then simply
 * omits the path.
 */
function spillFullOutput(text: string): string | undefined {
  try {
    const rand = crypto.randomBytes(4).toString("hex");
    const p = path.join(os.tmpdir(), `openswarm-bash-${rand}.out`);
    fsSync.writeFileSync(p, text);
    return p;
  } catch {
    return undefined;
  }
}

/** stdout normalization: strip leading blank lines, trim trailing whitespace. */
function normalizeStdout(text: string): string {
  return text.replace(/^(\s*\n)+/, "").trimEnd();
}

/**
 * A note describing what the read path discarded, or "" when it kept
 * everything.
 *
 * Appended rather than inserted at the seam because the seam is in the middle,
 * and the middle is exactly what the later truncation removes — a note there
 * would describe a loss using text that gets lost. At the end it survives into
 * the tail, and into the spilled file, so the "full output" the truncation
 * marker promises is qualified in the same place it is offered.
 */
function dropNote(buf: BoundedOutput, stream: "stdout" | "stderr"): string {
  if (!buf.truncated) return "";
  return (
    `\n\n... [${buf.droppedBytes} bytes of ${stream} discarded while reading; ` +
    `${buf.totalBytes} bytes were produced, and ${DEFAULT_RETAIN_BYTES} bytes ` +
    `from each end were kept] ...`
  );
}

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const cwd = input.workdir !== undefined ? path.resolve(ctx.cwd, input.workdir) : ctx.cwd;
  const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  const broker = getProcessBroker();
  const request = {
    kind: "shell" as const,
    command: "/bin/bash",
    args: ["-c", input.command],
    cwd,
    env: getHardenedEnv(),
    label: input.command,
  };

  // Background mode: stream combined output to a file and return immediately
  // (Claude Code shape: "Command running in background with ID: ...").
  if (input.run_in_background) {
    const rand = crypto.randomBytes(4).toString("hex");
    const outFile = path.join(os.tmpdir(), `openswarm-bash-${rand}.out`);
    const fd = fsSync.openSync(outFile, "w");
    let bg;
    try {
      bg = await broker.spawn({ ...request, stdio: ["ignore", fd, fd] });
    } finally {
      fsSync.closeSync(fd);
    }
    // unref so a backgrounded command does not hold the event loop open; the
    // broker's registry, not the handle, is what keeps it reachable and gets
    // it reaped at exit.
    bg.child.unref();
    return {
      status: "ok",
      output:
        `Command running in background with ID: ${bg.child.pid}. ` +
        `Output is being written to: ${outFile}. ` +
        `To check interim output, read that file (e.g. \`tail ${outFile}\`).`,
    };
  }

  return new Promise<ToolResult>(async (resolve) => {
    // stdout and stderr are collected separately (Claude Code behavior):
    // the tool result is stdout followed by stderr, not an interleaved stream.
    //
    // Bounded on the read path rather than at close. Truncating at close bounds
    // what the model sees but not what the command can make us hold, and a
    // command that outruns its own exit exhausts memory before that truncation
    // ever runs. The retained window is far wider than the result cap, so any
    // output that would have survived truncation survives this unchanged.
    const stdoutBuf = new BoundedOutput();
    const stderrBuf = new BoundedOutput();

    const proc = await broker.spawn({ ...request, stdio: ["ignore", "pipe", "pipe"] });
    const child = proc.child;

    child.stdout?.on("data", (chunk: Buffer) => stdoutBuf.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrBuf.push(chunk));

    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    // Honor abort signal.
    const onAbort = () => {
      clearTimeout(timer);
      proc.kill();
    };
    ctx.abort?.addEventListener("abort", onAbort);

    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.abort?.removeEventListener("abort", onAbort);

      // Cleanse (strip ANSI/progress noise, redact secrets) before truncating
      // so the preserved head carries signal, not escape codes.
      const rawStdout = stdoutBuf.text() + dropNote(stdoutBuf, "stdout");
      const rawStderr = stderrBuf.text() + dropNote(stderrBuf, "stderr");
      const cleanedStdout = normalizeStdout(
        cleanOutput(rawStdout, { command: input.command }).text,
      );
      // Spill BEFORE truncating so the elided middle stays recoverable (TE-6).
      const stdoutSpill =
        cleanedStdout.length > MAX_OUTPUT_CHARS ? spillFullOutput(cleanedStdout) : undefined;
      const stdout = truncateOutput(cleanedStdout, MAX_OUTPUT_CHARS, stdoutSpill);
      let stderr = cleanOutput(rawStderr, { command: input.command }).text.trim();

      if (timedOut) {
        stderr = `${stderr ? `${stderr}\n` : ""}Command timed out after ${formatDuration(timeoutMs)}`;
        const content = [stderr, stdout].filter(Boolean).join("\n");
        resolve({
          status: "error",
          message: truncateErrorContent(
            content,
            content.length > MAX_ERROR_CHARS ? spillFullOutput(content) : undefined,
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
        resolve({
          status: "error",
          message: truncateErrorContent(
            content,
            content.length > MAX_ERROR_CHARS ? spillFullOutput(content) : undefined,
          ),
        });
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

/**
 * @deprecated The sandbox policy belongs to the broker, which applies it to
 * every untrusted child rather than to bash alone. Kept as a forwarder so the
 * name does not silently become a no-op for any caller still holding it.
 */
export function setBashSandboxPolicy(policy: SandboxPolicy): void {
  getProcessBroker().setPolicy(policy);
}

export const bashTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  // An arbitrary command's side effects cannot be described in terms of files,
  // so bash is a global barrier rather than something to schedule around.
  accesses: () => ToolAccesses.all(),
};
