import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { isUnderCwd } from "./internal.js";

const inputSchema = z.object({
  path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

type Input = z.infer<typeof inputSchema>;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
const BINARY_PROBE_BYTES = 8192;
const DEFAULT_LINE_LIMIT = 2000;

const spec: ToolSpec = {
  name: "read_file",
  description:
    "Read a text file. Path is resolved relative to the working directory. " +
    "Binary files (NUL byte in first 8 KiB) and files larger than 10 MiB are rejected. " +
    "Use `offset` (0-based line index) and `limit` (max lines) to page through large files. " +
    "Default limit is 2000 lines. Output is cat-n formatted: '  N\\t<line>'.",
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
  requiredPermission: "read",
  tier: 0,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const resolved = path.resolve(ctx.cwd, input.path);

  // Workspace boundary — read_file honors the same boundary as write-side tools
  // so read-only permission mode is actually confined to the agent's workspace.
  if (!isUnderCwd(resolved, ctx.cwd)) {
    return {
      status: "error",
      message: `path "${input.path}" resolves outside the workspace boundary`,
    };
  }
  // Symlink-escape guard (only when file exists and is a symlink).
  try {
    const lstat = await fs.lstat(resolved);
    if (lstat.isSymbolicLink()) {
      const real = await fs.realpath(resolved);
      if (!isUnderCwd(real, ctx.cwd)) {
        return {
          status: "error",
          message: `path "${input.path}" is a symlink pointing outside the workspace boundary`,
        };
      }
    }
  } catch {
    // File doesn't exist — stat/read below will produce the appropriate error.
  }

  // Stat first for size check.
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `cannot stat file: ${msg}` };
  }

  if (stat.size > MAX_FILE_BYTES) {
    return { status: "error", message: `file exceeds 10 MiB read cap: ${resolved}` };
  }

  // Read the whole file (size is within cap).
  let buf: Buffer;
  try {
    buf = await fs.readFile(resolved);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `cannot read file: ${msg}` };
  }

  // Binary detection: NUL byte in first 8 KiB.
  const probe = buf.slice(0, BINARY_PROBE_BYTES);
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0x00) {
      return {
        status: "error",
        message: `binary file detected (NUL byte in first 8KB): ${resolved}`,
      };
    }
  }

  const text = buf.toString("utf8");
  const lines = text.split("\n");

  // Remove trailing empty line produced by a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const offset = input.offset ?? 0;
  const limit = input.limit ?? DEFAULT_LINE_LIMIT;
  const slice = lines.slice(offset, offset + limit);

  const output = slice
    .map((line, i) => {
      const lineNum = offset + i + 1;
      const padded = String(lineNum).padStart(3, " ");
      return `${padded}\t${line}`;
    })
    .join("\n");

  return { status: "ok", output };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  return ToolAccesses.readFile(path.resolve(ctx.cwd, parsed.data.path));
}

export const readFileTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};
