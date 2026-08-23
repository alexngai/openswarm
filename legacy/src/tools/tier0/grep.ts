/**
 * grep tool — ripgrep-backed file content search.
 *
 * This tool invokes the bundled @vscode/ripgrep binary
 * rather than a walkdir+regex approach. This means .gitignore is respected
 * automatically (ripgrep's default behavior), binary files are skipped, and
 * search is significantly faster on large trees.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import { rgPath } from "@vscode/ripgrep";
import * as path from "node:path";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { aliasParams } from "./internal.js";

const paramsSchema = z.object({
  pattern: z.string().describe("The regular expression pattern to search for in file contents"),
  path: z.string().optional().describe("File or directory to search in. Defaults to the working directory."),
  glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
  type: z.string().optional().describe("File type to search (rg --type), e.g. js, py, rust"),
  "-i": z.boolean().optional().describe("Case insensitive search"),
  "-n": z
    .boolean()
    .optional()
    .describe("Show line numbers in output (default true for content mode)"),
  "-A": z.number().int().nonnegative().optional().describe("Lines to show after each match (content mode)"),
  "-B": z.number().int().nonnegative().optional().describe("Lines to show before each match (content mode)"),
  "-C": z.number().int().nonnegative().optional().describe("Lines to show before and after each match (content mode)"),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  head_limit: z.number().int().positive().optional(),
  multiline: z.boolean().optional(),
});

// `case_insensitive` is the legacy openswarm spelling of `-i`.
const inputSchema = z.preprocess(aliasParams({ case_insensitive: "-i" }), paramsSchema);

type Input = z.infer<typeof paramsSchema>;

const DEFAULT_HEAD_LIMIT = 250;

const spec: ToolSpec = {
  name: "grep",
  description:
    "Search file contents using ripgrep. Supports full regex syntax, glob/type filters, " +
    "context lines (-A/-B/-C), and multiple output modes. Automatically respects .gitignore. " +
    "output_mode: 'content' (default) shows matching lines as path:line: text " +
    "(context lines use path-line- prefixes); " +
    "'files_with_matches' lists file paths; 'count' shows match counts per file. " +
    "head_limit caps output lines (default 250).",
  inputSchema: z.toJSONSchema(paramsSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 0,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const searchPath = input.path ?? ctx.cwd;
  const mode = input.output_mode ?? "content";
  const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;

  const args: string[] = [];
  if (mode === "content") {
    // Plain rg output: `path:line:text` matches, `path-line-text` context
    // lines — the format models trained on Claude Code / rg expect.
    // --max-columns matches Claude Code's long-line elision.
    args.push("--with-filename", "--max-columns", "500");
    if (input["-n"] !== false) args.push("--line-number");
    const after = input["-A"] ?? input["-C"];
    const before = input["-B"] ?? input["-C"];
    if (after !== undefined) args.push("-A", String(after));
    if (before !== undefined) args.push("-B", String(before));
  } else if (mode === "files_with_matches") {
    args.push("--files-with-matches");
  } else {
    // -c -H: per-file count of matching lines (Claude Code's count mode).
    args.push("-c", "-H");
  }

  if (input.glob) {
    args.push("-g", input.glob);
  }
  if (input.type) {
    args.push("--type", input.type);
  }
  if (input["-i"]) {
    args.push("-i");
  }
  if (input.multiline) {
    args.push("-U", "--multiline-dotall");
  }
  args.push("--", input.pattern, searchPath);

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const onAbort = () => child.kill("SIGKILL");
    ctx.abort?.addEventListener("abort", onAbort);

    // Without this handler a spawn failure (e.g. the bundled ripgrep binary is
    // not present — common in stripped/compiled deployments and sandboxes)
    // emits an unhandled 'error' event: the promise never resolves and the tool
    // call hangs/crashes. Resolve to a clear error so the model can immediately
    // fall back to a shell `grep -rn` instead of thrashing on a broken tool.
    child.on("error", (err: NodeJS.ErrnoException) => {
      ctx.abort?.removeEventListener("abort", onAbort);
      const detail = err.code === "ENOENT" ? "ripgrep binary not found" : err.message;
      resolve({
        status: "error",
        message:
          `grep unavailable (${detail}). Use the bash tool with ` +
          `\`grep -rn <pattern> <path>\` instead.`,
      });
    });

    child.on("close", (code) => {
      ctx.abort?.removeEventListener("abort", onAbort);

      // Exit code 1 = no matches — not an error.
      if (code !== 0 && code !== 1 && code !== null) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        resolve({ status: "error", message: `ripgrep error: ${stderr}` });
        return;
      }

      const rawOutput = Buffer.concat(stdoutChunks).toString("utf8");
      const allLines = rawOutput.split("\n").filter((l) => l.trim());

      // Empty results use Claude Code's exact phrasing per mode.
      if (allLines.length === 0) {
        resolve({
          status: "ok",
          output: mode === "files_with_matches" ? "No files found" : "No matches found",
        });
        return;
      }

      const capped = allLines.slice(0, headLimit);
      const limitApplied = allLines.length > headLimit;

      if (mode === "content") {
        // Plain rg output; when head_limit kicked in, append Claude Code's
        // pagination note so the model knows results continue.
        let output = capped.join("\n");
        if (limitApplied) {
          output += `\n\n[Showing results with pagination = limit: ${headLimit}]`;
        }
        resolve({ status: "ok", output });
      } else if (mode === "files_with_matches") {
        // Claude Code shape: "Found N files" header, then one path per line.
        const n = capped.length;
        const header = `Found ${n} ${n === 1 ? "file" : "files"}${limitApplied ? ` (limit: ${headLimit})` : ""}`;
        resolve({ status: "ok", output: `${header}\n${capped.join("\n")}` });
      } else {
        // count mode: raw `path:count` lines plus Claude Code's total summary.
        let totalMatches = 0;
        for (const line of capped) {
          const colonIdx = line.lastIndexOf(":");
          const n = colonIdx === -1 ? NaN : Number(line.slice(colonIdx + 1));
          if (Number.isFinite(n)) totalMatches += n;
        }
        const files = capped.length;
        const summary =
          `\n\nFound ${totalMatches} total ${totalMatches === 1 ? "occurrence" : "occurrences"} ` +
          `across ${files} ${files === 1 ? "file" : "files"}.${limitApplied ? ` with pagination = limit: ${headLimit}` : ""}`;
        resolve({ status: "ok", output: capped.join("\n") + summary });
      }
    });

    child.on("error", (err) => {
      ctx.abort?.removeEventListener("abort", onAbort);
      resolve({ status: "error", message: err.message });
    });
  });
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  const root = path.resolve(ctx.cwd, parsed.data.path ?? ".");
  return ToolAccesses.searchTree(root);
}

export const grepTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};
