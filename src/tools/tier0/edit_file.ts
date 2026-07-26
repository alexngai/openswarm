/**
 * edit_file — exact-string replacement with mandatory uniqueness check.
 *
 * Schema and error strings follow Claude Code's Edit tool (canonical
 * `file_path` param, "String to replace not found in file." / "Found N
 * matches…" errors, read-before-edit enforcement) so trained models
 * recognize the contract and self-correct without fine-tuning. Like Claude
 * Code, ambiguous replacements are rejected: if `old_string` appears more
 * than once and `replace_all` is not true, the call fails with an
 * actionable error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { aliasParams } from "./internal.js";
import { resolveInWorkspace } from "../workspace-path.js";
import { hasFileBeenRead, recordFileRead, READ_BEFORE_EDIT_ERROR } from "./read-state.js";

const paramsSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const inputSchema = z.preprocess(aliasParams({ path: "file_path" }), paramsSchema);

type Input = z.infer<typeof paramsSchema>;

const spec: ToolSpec = {
  name: "edit_file",
  description:
    "Performs exact string replacements in files. " +
    "You must use the read_file tool at least once before editing — edits to unread files fail. " +
    "The edit fails if old_string is not found, or if it is found multiple times and replace_all is not true — " +
    "provide more surrounding context to make old_string unique, or pass replace_all: true. " +
    "Uses atomic write (temp file + rename) so partial writes never corrupt the target.",
  inputSchema: z.toJSONSchema(paramsSchema) as JsonSchema,
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

/**
 * Claude Code's success-message suffix: tells the model the post-edit file
 * state is already in context, suppressing wasteful read-backs.
 */
export const FILE_STATE_CURRENT_SUFFIX =
  " (file state is current in your context \u2014 no need to Read it back)";

/**
 * Claude Code's stale-file error: the model responds by re-reading and
 * retrying the edit.
 */
export const STALE_FILE_ERROR =
  "File has been modified since read, either by the user or by a linter. " +
  "Read it again before attempting to write it.";

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  if (input.old_string === input.new_string) {
    return {
      status: "error",
      message: "No changes to make: old_string and new_string are exactly the same.",
    };
  }

  // Resolve and enforce workspace boundary.
  const contained = await resolveInWorkspace(input.file_path, ctx.cwd);
  if (!contained.ok) {
    return { status: "error", message: contained.message };
  }
  const resolved = contained.path;

  // Read-before-edit contract (Claude Code alignment): the model must have
  // read the file this session so the edit operates on known content.
  if (!hasFileBeenRead(resolved)) {
    return { status: "error", message: READ_BEFORE_EDIT_ERROR };
  }

  // Read existing content.
  let content: string;
  try {
    content = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to read "${input.file_path}": ${msg}` };
  }

  // Uniqueness check.
  const count = countOccurrences(content, input.old_string);

  if (count === 0) {
    return {
      status: "error",
      message: `String to replace not found in file.\nString: ${input.old_string}`,
    };
  }

  if (count > 1 && input.replace_all !== true) {
    return {
      status: "error",
      message:
        `Found ${count} matches of the string to replace, but replace_all is false. ` +
        `To replace all occurrences, set replace_all to true. To replace only one occurrence, ` +
        `please provide more context to uniquely identify the instance.\nString: ${input.old_string}`,
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
      return { status: "error", message: STALE_FILE_ERROR };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to write "${input.file_path}": ${msg}` };
  }

  // Post-edit content is known to the agent.
  recordFileRead(resolved);

  // Claude Code's exact success sentences (v2.1.198).
  return {
    status: "ok",
    output:
      input.replace_all === true
        ? `The file ${input.file_path} has been updated. All occurrences were successfully replaced.${FILE_STATE_CURRENT_SUFFIX}`
        : `The file ${input.file_path} has been updated successfully.${FILE_STATE_CURRENT_SUFFIX}`,
  };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  return ToolAccesses.writeFile(path.resolve(ctx.cwd, parsed.data.file_path));
}

export const editFileTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};

// Export atomicWrite for reuse by multi_edit.
export { atomicWrite };
