import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { aliasParams } from "./internal.js";
import { resolveInWorkspace, atomicWriteInWorkspace } from "../workspace-path.js";
import { hasFileBeenRead, recordFileRead, READ_BEFORE_EDIT_ERROR } from "./read-state.js";
import { FILE_STATE_CURRENT_SUFFIX } from "./edit_file.js";

const paramsSchema = z.object({
  file_path: z.string(),
  content: z.string(),
});

const inputSchema = z.preprocess(aliasParams({ path: "file_path" }), paramsSchema);

type Input = z.infer<typeof paramsSchema>;

const MAX_CONTENT_BYTES = 10 * 1024 * 1024; // 10 MiB

const spec: ToolSpec = {
  name: "write_file",
  description:
    "Write content to a file. `file_path` may be absolute or relative to the working directory. " +
    "Overwriting an existing file requires reading it first with the read_file tool. " +
    "ALWAYS prefer editing existing files; use this for new files or complete rewrites. " +
    "The resolved path must remain inside the workspace (cwd); path-traversal attempts are rejected. " +
    "Symlinks that point outside the workspace are also rejected. " +
    "Content must not exceed 10 MiB. Parent directories are created if missing. " +
    "Writes are atomic (temp-file + rename).",
  inputSchema: z.toJSONSchema(paramsSchema) as JsonSchema,
  requiredPermission: "write",
  tier: 0,
};

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  // Workspace boundary check, including any symlink along the way.
  const contained = await resolveInWorkspace(input.file_path, ctx.cwd);
  if (!contained.ok) {
    return { status: "error", message: contained.message };
  }
  const resolved = contained.path;

  // Existence drives the read-before-overwrite contract below, so the question
  // is whether content would be lost, not whether a directory entry is there.
  // Those differ for a link with nothing at the far end: lstat sees the link
  // and demands a prior read, but read_file follows the link and finds
  // nothing, so the demand can never be met. stat asks the question the
  // contract actually cares about. Containment already followed the link and
  // judged its target, so following it again here cannot widen reach.
  let fileExists = false;
  try {
    await fs.stat(resolved);
    fileExists = true;
  } catch {
    // Nothing to overwrite — either the name is free or the link dangles.
  }

  // Read-before-overwrite contract (Claude Code alignment): overwriting an
  // existing file requires the agent to have read it this session.
  if (fileExists && !hasFileBeenRead(resolved)) {
    return { status: "error", message: READ_BEFORE_EDIT_ERROR };
  }

  // Content size check (UTF-8 byte length).
  const contentBytes = Buffer.byteLength(input.content, "utf8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    return { status: "error", message: "content exceeds 10 MiB write cap" };
  }

  // Create parent directories if missing. Recursive mkdir stats after an
  // EEXIST to confirm the entry is a directory, so an ancestor that is being
  // swapped concurrently makes it throw rather than return — and a tool that
  // throws leaves its caller with an exception where a refusal belongs.
  const dir = path.dirname(resolved);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `could not create parent directory: ${msg}` };
  }

  // Atomic write, with the swap race handled by the shared helper: the
  // directory can be replaced between the check above and the rename below,
  // and only verifying where the bytes landed catches that.
  const written = await atomicWriteInWorkspace(resolved, input.content, ctx.cwd);
  if (!written.ok) {
    return { status: "error", message: written.message };
  }

  // Post-write content is known to the agent.
  recordFileRead(resolved);

  // Claude Code's exact success sentences (v2.1.198) — both variants carry
  // the "file state is current" suffix that suppresses read-backs.
  return {
    status: "ok",
    output: fileExists
      ? `The file ${resolved} has been updated successfully.${FILE_STATE_CURRENT_SUFFIX}`
      : `File created successfully at: ${resolved}${FILE_STATE_CURRENT_SUFFIX}`,
  };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  return ToolAccesses.writeFile(path.resolve(ctx.cwd, parsed.data.file_path));
}

export const writeFileTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};
