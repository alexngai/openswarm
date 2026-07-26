/**
 * multi_edit — atomic batch of edits applied to a single file.
 *
 * ALL edits are validated before ANY are applied. If any edit fails
 * validation, the file is left unchanged. This prevents partial edits
 * that leave a file in a corrupt or inconsistent state.
 *
 * Each edit operates on the in-memory result of the previous edit,
 * so edits can be chained (edit N+1 targets text produced by edit N).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { aliasParams } from "./internal.js";
import { resolveInWorkspace } from "../workspace-path.js";
import { atomicWrite, TocttouError, STALE_FILE_ERROR } from "./edit_file.js";
import { hasFileBeenRead, recordFileRead, READ_BEFORE_EDIT_ERROR } from "./read-state.js";

const editSchema = z.object({
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const paramsSchema = z.object({
  file_path: z.string(),
  edits: z.array(editSchema).min(1),
});

const inputSchema = z.preprocess(aliasParams({ path: "file_path" }), paramsSchema);

type Input = z.infer<typeof paramsSchema>;
type Edit = z.infer<typeof editSchema>;

const spec: ToolSpec = {
  name: "multi_edit",
  description:
    "Apply multiple exact-string replacements to a single file atomically. " +
    "You must use the read_file tool at least once before editing — edits to unread files fail. " +
    "All edits are validated before any are written — if any edit fails " +
    "(old_string not found, or ambiguous without replace_all), no changes are applied. " +
    "Edits are applied in order; each subsequent edit operates on the output of the previous.",
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
 * Validate a single edit against the current content string.
 * Returns an error message if invalid, or null if valid.
 */
function validateEdit(content: string, edit: Edit, _filePath: string): string | null {
  if (edit.old_string === edit.new_string) {
    return "No changes to make: old_string and new_string are exactly the same.";
  }
  const count = countOccurrences(content, edit.old_string);
  if (count === 0) {
    return `String to replace not found in file.\nString: ${edit.old_string}`;
  }
  if (count > 1 && edit.replace_all !== true) {
    return (
      `Found ${count} matches of the string to replace, but replace_all is false. ` +
      `To replace all occurrences, set replace_all to true. To replace only one occurrence, ` +
      `please provide more context to uniquely identify the instance.\nString: ${edit.old_string}`
    );
  }
  return null;
}

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  // Resolve and enforce workspace boundary.
  const contained = await resolveInWorkspace(input.file_path, ctx.cwd);
  if (!contained.ok) {
    return { status: "error", message: contained.message };
  }
  const resolved = contained.path;

  // Read-before-edit contract (Claude Code alignment).
  if (!hasFileBeenRead(resolved)) {
    return { status: "error", message: READ_BEFORE_EDIT_ERROR };
  }

  // Read file once.
  let originalContent: string;
  try {
    originalContent = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to read "${input.file_path}": ${msg}` };
  }

  // Phase 1: validate ALL edits before applying any.
  // Simulate applying edits in order to validate each against the evolving content.
  let simulatedContent = originalContent;
  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i]!;
    const err = validateEdit(simulatedContent, edit, input.file_path);
    if (err !== null) {
      return {
        status: "error",
        message: `edit ${i} failed: ${err}; no edits applied`,
      };
    }
    // Advance simulated content for subsequent validations.
    simulatedContent = simulatedContent.split(edit.old_string).join(edit.new_string);
  }

  // Phase 2: apply all edits in order to produce the final content.
  // simulatedContent already holds the result after all valid edits.
  // S5: compute hash of original content for TOCTTOU check.
  const contentHash = crypto.createHash("sha256").update(originalContent).digest("hex");

  try {
    await atomicWrite(resolved, simulatedContent, contentHash);
  } catch (err) {
    if (err instanceof TocttouError) {
      return { status: "error", message: STALE_FILE_ERROR };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to write "${input.file_path}": ${msg}` };
  }

  // Post-edit content is known to the agent.
  recordFileRead(resolved);

  return {
    status: "ok",
    output: `Applied ${input.edits.length} edits to ${input.file_path}`,
  };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  return ToolAccesses.writeFile(path.resolve(ctx.cwd, parsed.data.file_path));
}

export const multiEditTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};
