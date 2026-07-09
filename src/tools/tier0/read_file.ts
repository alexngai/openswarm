/**
 * read_file — Claude Code-aligned file reader.
 *
 * Schema and semantics follow Claude Code's Read tool so trained models
 * work without fine-tuning (docs/04-tool-tiers.md, schema alignment):
 *   - canonical param is `file_path` (legacy alias `path` still accepted)
 *   - `offset` is a 1-based line number ("the line number to start reading
 *     from"), `limit` caps lines (default 2000)
 *   - output is cat-n formatted: 6-wide right-aligned line number + tab
 *   - lines longer than 2000 chars are truncated
 *   - empty files and out-of-range offsets return <system-reminder> warnings
 *   - default-cap truncation prepends a "[Truncated: PARTIAL view — ...]"
 *     system-reminder (Claude Code v2.1.198 shape)
 * Successful reads are recorded so edit_file/write_file can enforce the
 * read-before-edit contract.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { isUnderCwd, aliasParams } from "./internal.js";
import { recordFileRead } from "./read-state.js";

const paramsSchema = z.object({
  file_path: z.string(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});

const inputSchema = z.preprocess(aliasParams({ path: "file_path" }), paramsSchema);

type Input = z.infer<typeof paramsSchema>;

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
const BINARY_PROBE_BYTES = 8192;
const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
/**
 * Aggregate output byte cap (docs/53 TE-5, pi's dual-limit shape): the line
 * cap alone admits 2000 lines × 2000 chars ≈ 4MB into context. Whichever
 * limit hits first wins; truncation is always at a line boundary and the
 * notice carries the continuation offset. Override: OPENSWARM_READ_MAX_BYTES.
 */
const MAX_OUTPUT_BYTES = (() => {
  const env = Number(process.env.OPENSWARM_READ_MAX_BYTES);
  return Number.isFinite(env) && env > 0 ? env : 50 * 1024;
})();

/**
 * Cap `slice` (in place) so raw content stays within `maxBytes`, cutting at a
 * line boundary. Always keeps at least one line — MAX_LINE_CHARS bounds a
 * rendered line well below any sane byte cap. Returns true when it cut.
 */
function capSliceBytes(slice: string[], maxBytes: number): boolean {
  let used = 0;
  for (let i = 0; i < slice.length; i++) {
    const lineBytes = Buffer.byteLength(slice[i]!, "utf8") + 1; // +1 newline
    if (i > 0 && used + lineBytes > maxBytes) {
      slice.length = i;
      return true;
    }
    used += lineBytes;
  }
  return false;
}

const spec: ToolSpec = {
  name: "read_file",
  description:
    "Read a text file. `file_path` may be absolute or relative to the working directory. " +
    "By default returns up to 2000 lines (and at most ~50KB) from the start of the file. " +
    "`offset` is the line number to start reading from (1-indexed); `limit` caps the number of lines. " +
    "When output is truncated, continue with the offset given in the truncation notice. " +
    "Output is cat -n formatted (line numbers prefixed). Lines longer than 2000 characters are truncated. " +
    "Binary files (NUL byte in first 8 KiB) and files larger than 10 MiB are rejected. " +
    "Call this tool in parallel when reading multiple files.",
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

  const resolved = path.resolve(ctx.cwd, input.file_path);

  // Workspace boundary — read_file honors the same boundary as write-side tools
  // so read-only permission mode is actually confined to the agent's workspace.
  if (!isUnderCwd(resolved, ctx.cwd)) {
    return {
      status: "error",
      message: `path "${input.file_path}" resolves outside the workspace boundary`,
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
          message: `path "${input.file_path}" is a symlink pointing outside the workspace boundary`,
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
  } catch {
    // Claude Code's exact phrasing — trained models recognize it.
    return { status: "error", message: "File does not exist." };
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

  // `offset` is 1-based (Claude Code convention). Accept 0 leniently as 1.
  const startLine = Math.max(1, input.offset ?? 1);
  const limit = input.limit ?? DEFAULT_LINE_LIMIT;
  const slice = lines.slice(startLine - 1, startLine - 1 + limit);
  // Dual limit (TE-5): the byte cap cuts even explicitly-limited reads — the
  // continuation notice below tells the model where to resume.
  const byteCapped = capSliceBytes(slice, MAX_OUTPUT_BYTES);

  recordFileRead(resolved);

  // Empty file / offset past EOF: Claude Code's exact system-reminder warnings.
  if (lines.length === 0) {
    return {
      status: "ok",
      output:
        "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>",
    };
  }
  if (slice.length === 0) {
    return {
      status: "ok",
      output:
        `<system-reminder>Warning: the file exists but is shorter than the provided offset ` +
        `(${startLine}). The file has ${lines.length} lines.</system-reminder>`,
    };
  }

  let output = slice
    .map((line, i) => {
      const lineNum = startLine + i;
      const shown =
        line.length > MAX_LINE_CHARS
          ? line.slice(0, MAX_LINE_CHARS) + `... (line truncated to ${MAX_LINE_CHARS} chars)`
          : line;
      return `${String(lineNum).padStart(6, " ")}\t${shown}`;
    })
    .join("\n");

  // When the default cap (no explicit limit) truncated the read, prepend a
  // Claude Code-style PARTIAL-view reminder so the model pages onward instead
  // of answering from an incomplete view.
  const lastShown = startLine + slice.length - 1;
  const capNote = byteCapped ? ` (${Math.round(MAX_OUTPUT_BYTES / 1024)}KB output cap)` : "";
  if (input.limit === undefined && lastShown < lines.length) {
    output =
      `<system-reminder>[Truncated: PARTIAL view \u2014 showing lines ${startLine}-${lastShown} ` +
      `of ${lines.length} total${capNote}. Call read_file with offset=${lastShown + 1} for the next page, ` +
      `or grep to find a specific section. Do NOT answer from this page alone if the answer ` +
      `may be further in the file.]</system-reminder>\n\n` +
      output;
  } else if (lastShown < lines.length) {
    output += `\n\n(Showing lines ${startLine}-${lastShown} of ${lines.length}${capNote}. Use offset=${lastShown + 1} to continue.)`;
  }

  return { status: "ok", output };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  return ToolAccesses.readFile(path.resolve(ctx.cwd, parsed.data.file_path));
}

export const readFileTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};
