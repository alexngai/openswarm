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
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { isUnderCwd } from "./internal.js";
import { atomicWrite } from "./edit_file.js";

const editSchema = z.object({
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const inputSchema = z.object({
  path: z.string(),
  edits: z.array(editSchema).min(1),
});

type Input = z.infer<typeof inputSchema>;
type Edit = z.infer<typeof editSchema>;

const spec: ToolSpec = {
  name: "multi_edit",
  description:
    "Apply multiple exact-string replacements to a single file atomically. " +
    "All edits are validated before any are written — if any edit fails " +
    "(old_string not found, or ambiguous without replace_all), no changes are applied. " +
    "Edits are applied in order; each subsequent edit operates on the output of the previous.",
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
 * Validate a single edit against the current content string.
 * Returns an error message if invalid, or null if valid.
 */
function validateEdit(content: string, edit: Edit, filePath: string): string | null {
  const count = countOccurrences(content, edit.old_string);
  if (count === 0) {
    return `old_string not found in ${filePath}`;
  }
  if (count > 1 && edit.replace_all !== true) {
    return (
      `old_string appears ${count} times in ${filePath}; ` +
      `pass replace_all: true to replace all occurrences, ` +
      `or narrow old_string to be unique`
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
  const resolved = path.resolve(ctx.cwd, input.path);

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
    // File doesn't exist yet; fall through — subsequent read will error.
  }

  // Read file once.
  let originalContent: string;
  try {
    originalContent = await fs.readFile(resolved, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to read "${input.path}": ${msg}` };
  }

  // Phase 1: validate ALL edits before applying any.
  // Simulate applying edits in order to validate each against the evolving content.
  let simulatedContent = originalContent;
  for (let i = 0; i < input.edits.length; i++) {
    const edit = input.edits[i]!;
    const err = validateEdit(simulatedContent, edit, input.path);
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
  try {
    await atomicWrite(resolved, simulatedContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to write "${input.path}": ${msg}` };
  }

  return {
    status: "ok",
    output: `applied ${input.edits.length} edits to ${input.path}`,
  };
}

export const multiEditTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
};
