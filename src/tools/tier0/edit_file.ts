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
import { resolveInWorkspace, atomicWriteInWorkspace } from "../workspace-path.js";
import {
  hasFileBeenRead,
  recordFileRead,
  recordedHash,
  READ_BEFORE_EDIT_ERROR,
} from "./read-state.js";

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
 * Atomic write with a stale-content guard, throwing where the shared helper
 * returns. Three tools reach this through `multi_edit` and `apply_patch` and
 * all three distinguish a lost race from a hard failure by catching
 * `TocttouError`, so the exception is the contract rather than an accident.
 *
 * The containment and swap-race handling live in `atomicWriteInWorkspace`;
 * this only adapts the result shape.
 */
async function atomicWrite(
  targetPath: string,
  content: string,
  cwd: string,
  expectedHash?: string,
): Promise<void> {
  const written = await atomicWriteInWorkspace(targetPath, content, cwd, expectedHash);
  if (written.ok) return;
  if (written.reason === "stale") throw new TocttouError(written.message);
  throw new Error(written.message);
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

  // The hash check below and the one in `atomicWrite` answer different
  // questions. That one guards this function's own read-modify-write window;
  // this one asks whether the content the *agent* read is still there. Matching
  // `old_string` against a freshly-read file makes a stale edit look clean
  // whenever the anchor survived somebody else's rewrite, and the edit then
  // lands in a file the agent has never seen (docs/63 `WP-11`).
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  const known = recordedHash(resolved);
  if (known !== null && known !== contentHash) {
    return { status: "error", message: STALE_FILE_ERROR };
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

  try {
    await atomicWrite(resolved, newContent, ctx.cwd, contentHash);
  } catch (err) {
    if (err instanceof TocttouError) {
      return { status: "error", message: STALE_FILE_ERROR };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to write "${input.file_path}": ${msg}` };
  }

  // Post-edit content is known to the agent.
  recordFileRead(resolved, newContent);

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
