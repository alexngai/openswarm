/**
 * grep tool — ripgrep-backed file content search.
 *
 * Divergence from claw: this tool invokes the bundled @vscode/ripgrep binary
 * rather than a walkdir+regex approach. This means .gitignore is respected
 * automatically (ripgrep's default behavior), binary files are skipped, and
 * search is significantly faster on large trees.
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { rgPath } from "@vscode/ripgrep";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";

const inputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
  head_limit: z.number().int().positive().optional(),
  multiline: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

const DEFAULT_HEAD_LIMIT = 250;

const spec: ToolSpec = {
  name: "grep",
  description:
    "Search file contents using ripgrep. Supports regex patterns, glob filters, and multiple output modes. " +
    "Automatically respects .gitignore. " +
    "output_mode: 'content' (default) shows matching lines as path:line: text; " +
    "'files_with_matches' lists file paths; 'count' shows match counts per file. " +
    "head_limit caps output lines (default 250).",
  inputSchema: zodToJsonSchema(inputSchema as never) as JsonSchema,
  requiredPermission: "read",
  tier: 0,
};

/** Ripgrep JSON message types we care about. */
interface RgBegin {
  type: "begin";
  data: { path: { text: string } };
}
interface RgMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: unknown[];
  };
}
interface RgEnd {
  type: "end";
  data: { path: { text: string }; stats: { matches: number } };
}

type RgMessage = RgBegin | RgMatch | RgEnd | { type: string; data: unknown };

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const searchPath = input.path ?? ctx.cwd;
  const mode = input.output_mode ?? "content";
  const headLimit = input.head_limit ?? DEFAULT_HEAD_LIMIT;

  // --json only works for content mode; files_with_matches and count produce plain text output
  const useJson = mode === "content";
  const args: string[] = useJson ? ["--json"] : [];
  args.push(input.pattern, searchPath);

  if (input.glob) {
    args.push("-g", input.glob);
  }
  if (input.case_insensitive) {
    args.push("-i");
  }
  if (input.multiline) {
    args.push("-U", "--multiline-dotall");
  }
  if (mode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (mode === "count") {
    args.push("--count-matches");
  }

  return new Promise<ToolResult>((resolve) => {
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const onAbort = () => child.kill("SIGKILL");
    ctx.abort?.addEventListener("abort", onAbort);

    child.on("close", (code) => {
      ctx.abort?.removeEventListener("abort", onAbort);

      // Exit code 1 = no matches — not an error.
      if (code !== 0 && code !== 1 && code !== null) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        resolve({ status: "error", message: `ripgrep error: ${stderr}` });
        return;
      }

      const rawOutput = Buffer.concat(stdoutChunks).toString("utf8");

      if (!rawOutput.trim()) {
        resolve({ status: "ok", output: "" });
        return;
      }

      const lines = rawOutput.split("\n").filter((l) => l.trim());
      const resultLines: string[] = [];

      if (mode === "content") {
        for (const line of lines) {
          if (resultLines.length >= headLimit) break;
          let msg: RgMessage;
          try {
            msg = JSON.parse(line) as RgMessage;
          } catch {
            continue;
          }
          if (msg.type === "match") {
            const m = msg as RgMatch;
            const filePath = m.data.path.text;
            const lineNum = m.data.line_number;
            const text = m.data.lines.text.replace(/\n$/, "");
            resultLines.push(`${filePath}:${lineNum}: ${text}`);
          }
        }
      } else if (mode === "files_with_matches") {
        // Plain text: one file path per line
        for (const line of lines) {
          if (resultLines.length >= headLimit) break;
          if (line.trim()) resultLines.push(line.trim());
        }
      } else {
        // count mode: plain text "path:count" per line
        for (const line of lines) {
          if (resultLines.length >= headLimit) break;
          if (!line.trim()) continue;
          // ripgrep outputs "path:N" — reformat to "path: N"
          const colonIdx = line.lastIndexOf(":");
          if (colonIdx !== -1) {
            const filePath = line.slice(0, colonIdx);
            const count = line.slice(colonIdx + 1).trim();
            resultLines.push(`${filePath}: ${count}`);
          } else {
            resultLines.push(line.trim());
          }
        }
      }

      resolve({ status: "ok", output: resultLines.join("\n") });
    });

    child.on("error", (err) => {
      ctx.abort?.removeEventListener("abort", onAbort);
      resolve({ status: "error", message: err.message });
    });
  });
}

export const grepTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
