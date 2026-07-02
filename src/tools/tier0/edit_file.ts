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
import * as crypto from "node:crypto";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
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
  inputSchema: z.toJSONSchema(inputSchema) as JsonSchema,
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
 *
 * When `expectedHash` is provided (S5 TOCTTOU protection), re-reads the
 * target file just before rename and verifies the content hash matches
 * what was read earlier. If the file changed between the initial read
 * and the write, the operation is aborted with an error.
 */
async function atomicWrite(
  targetPath: string,
  content: string,
  expectedHash?: string,
): Promise<void> {
  const dir = path.dirname(targetPath);
  // Random suffix (not pid+ms) so concurrent batch writes can't collide on
  // the temp name and lose to `fs.rename` after the writer has been
  // unlinked by a sibling.
  const rand = crypto.randomBytes(6).toString("hex");
  const tmp = path.join(dir, `.openswarm-tmp-${process.pid}-${rand}`);
  try {
    await fs.writeFile(tmp, content, "utf8");

    // S5: TOCTTOU guard — if we know the expected content hash, verify
    // the target hasn't been modified since we read it.
    if (expectedHash !== undefined) {
      try {
        const currentContent = await fs.readFile(targetPath, "utf8");
        const currentHash = crypto
          .createHash("sha256")
          .update(currentContent)
          .digest("hex");
        if (currentHash !== expectedHash) {
          throw new TocttouError(
            `file "${targetPath}" was modified between read and write ` +
              `(expected hash ${expectedHash.slice(0, 12)}…, got ${currentHash.slice(0, 12)}…)`,
          );
        }
      } catch (err) {
        if (err instanceof TocttouError) throw err;
        // File was deleted between our read and write — unusual but not TOCTTOU
      }
    }

    await fs.rename(tmp, targetPath);
  } catch (err) {
    // Best-effort cleanup of temp file on failure.
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Sentinel error for TOCTTOU detection (S5). */
export class TocttouError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TocttouError";
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

  // S5: compute hash of original content for TOCTTOU check.
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");

  try {
    await atomicWrite(resolved, newContent, contentHash);
  } catch (err) {
    if (err instanceof TocttouError) {
      return {
        status: "error",
        message: `TOCTTOU: ${err.message}. Re-read the file and retry.`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to write "${input.path}": ${msg}` };
  }

  return {
    status: "ok",
    output: `replaced ${count} occurrence(s) in ${input.path}`,
  };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  return ToolAccesses.writeFile(path.resolve(ctx.cwd, parsed.data.path));
}

export const editFileTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};

// Export atomicWrite for reuse by multi_edit.
export { atomicWrite };
