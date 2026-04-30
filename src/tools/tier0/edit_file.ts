/**
 * edit_file — exact-string replacement with mandatory uniqueness check.
 *
 * CRITICAL DIVERGENCE FROM CLAW-CODE:
 * claw-code's Edit tool silently replaces only the first occurrence of
 * `old_string` when multiple matches exist. This tool rejects ambiguous
 * replacements: if `old_string` appears more than once and `replace_all`
 * is not true, the call fails with an actionable error. The caller must
 * either narrow `old_string` to be unique or pass `replace_all: true`.
 *
 * This is intentional. Silent first-match behavior hides bugs when the
 * model issues a replacement that matches the wrong site.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { isUnderCwd } from "./internal.js";

const inputSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

const spec: ToolSpec = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. " +
    "If old_string appears more than once and replace_all is not true, the call fails — " +
    "narrow old_string to be unique or pass replace_all: true. " +
    "Uses atomic write (temp file + rename) so partial writes never corrupt the target.",
  inputSchema: zodToJsonSchema(inputSchema as any) as JsonSchema,
  requiredPermission: "write",
  tier: 0,
};

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * Ensures the target is never left in a partial state.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.swarm-harness-tmp-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of temp file on failure.
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  // Resolve and enforce workspace boundary.
  const resolved = path.resolve(ctx.cwd, input.path);

  // Also check that the resolved path is not a symlink escaping the workspace.
  if (!isUnderCwd(resolved, ctx.cwd)) {
    return {
      status: "error",
      message: `path "${input.path}" resolves outside the workspace boundary`,
    };
  }
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
    // File doesn't exist; fall through — read below will error naturally.
  }

  // Read existing content.
  let content: string;
  try {
    content = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to read "${input.path}": ${msg}` };
  }

  // Uniqueness check.
  const count = countOccurrences(content, input.old_string);

  if (count === 0) {
    return {
      status: "error",
      message: `old_string not found in ${input.path}`,
    };
  }

  if (count > 1 && input.replace_all !== true) {
    return {
      status: "error",
      message:
        `old_string appears ${count} times in ${input.path}; ` +
        `pass replace_all: true to replace all occurrences, ` +
        `or narrow old_string to be unique`,
    };
  }

  // Apply replacement(s).
  const newContent = content.split(input.old_string).join(input.new_string);

  try {
    await atomicWrite(resolved, newContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to write "${input.path}": ${msg}` };
  }

  return {
    status: "ok",
    output: `replaced ${count} occurrence(s) in ${input.path}`,
  };
}

export const editFileTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};

// Export atomicWrite for reuse by multi_edit.
export { atomicWrite };
