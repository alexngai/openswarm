import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses, type ToolAccesses as ToolAccessesType } from "../access.js";
import { isUnderCwd, aliasParams } from "./internal.js";
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

  const resolved = path.resolve(ctx.cwd, input.file_path);

  // Workspace boundary check.
  if (!isUnderCwd(resolved, ctx.cwd)) {
    return { status: "error", message: `path escapes workspace: ${resolved}` };
  }

  // Symlink-escape guard: if the path already exists as a symlink,
  // follow it to its real target and re-check. Also detect existence for
  // the read-before-overwrite contract below.
  let fileExists = false;
  try {
    const lstat = await fs.lstat(resolved);
    fileExists = true;
    if (lstat.isSymbolicLink()) {
      const real = await fs.realpath(resolved);
      if (!isUnderCwd(real, ctx.cwd)) {
        return { status: "error", message: `path escapes workspace: ${resolved}` };
      }
    }
  } catch {
    // File doesn't exist yet — that's fine, we'll create it.
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

  // Create parent directories if missing.
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });

  // S5: Re-validate parent directory after mkdir to prevent TOCTTOU
  // (directory could be replaced with a symlink between mkdir and write).
  // Canonicalize both paths via realpath so that symlink-prefixed OS temp
  // directories (e.g. /var/folders → /private/var/folders on macOS) compare
  // correctly against each other.
  try {
    const parentReal = await fs.realpath(dir);
    const cwdReal = await fs.realpath(ctx.cwd);
    if (!isUnderCwd(parentReal, cwdReal)) {
      return {
        status: "error",
        message: `parent directory was replaced outside workspace after mkdir`,
      };
    }
  } catch {
    // realpath failed — directory doesn't exist anymore, write below will fail naturally
  }

  // Atomic write: write to a temp file then rename.
  const rand = crypto.randomBytes(6).toString("hex");
  const basename = path.basename(resolved);
  const tmpPath = path.join(dir, `.${basename}.tmp-${rand}`);

  try {
    await fs.writeFile(tmpPath, input.content, "utf8");
    await fs.rename(tmpPath, resolved);
  } catch (err: unknown) {
    // Attempt cleanup of temp file; ignore secondary errors.
    await fs.unlink(tmpPath).catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `write failed: ${msg}` };
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
