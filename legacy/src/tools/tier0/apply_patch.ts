/**
 * apply_patch — apply a Codex-style, file-oriented patch envelope in one call.
 *
 * Borrowed from MiMoCode/OpenCode/Codex. A single `patch` string can create,
 * delete, and update multiple files atomically:
 *
 *   *** Begin Patch
 *   *** Add File: path/new.ts
 *   +line one
 *   +line two
 *   *** Update File: src/app.ts
 *   *** Move to: src/main.ts        (optional rename)
 *   @@ optional locator
 *    unchanged context line
 *   -removed line
 *   +added line
 *   *** Delete File: obsolete.ts
 *   *** End Patch
 *
 * Safety (mirrors edit_file / multi_edit):
 *   - ALL operations are validated before ANY are applied — a single failure
 *     aborts the whole patch, leaving the workspace untouched.
 *   - Every path is confined to the workspace (no traversal / symlink escape).
 *   - Update chunks require a UNIQUE match (like edit_file) — ambiguous context
 *     fails with an actionable error rather than editing the wrong site.
 *   - Writes are atomic (temp + rename) with a TOCTTOU hash guard.
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
import { atomicWrite, TocttouError } from "./edit_file.js";

const paramsSchema = z.object({
  patch: z.string().describe("A patch envelope: *** Begin Patch ... *** End Patch"),
});

// Codex's JSON function-tool variant of apply_patch names the parameter
// `input` — accept it as an alias so GPT-family models work unmodified.
const inputSchema = z.preprocess(aliasParams({ input: "patch" }), paramsSchema);

type Input = z.infer<typeof paramsSchema>;

const spec: ToolSpec = {
  name: "apply_patch",
  description:
    "Apply a Codex-style patch envelope that can Add/Update/Delete multiple files at once. " +
    "Format: `*** Begin Patch` / `*** End Patch` wrapping file sections headed by " +
    "`*** Add File: <p>`, `*** Delete File: <p>`, or `*** Update File: <p>` (with an optional " +
    "`*** Move to: <p>`). Add lines are prefixed `+`; Update hunks use ` ` context, `-` removals, " +
    "`+` additions, and `@@` chunk separators. All operations are validated before any are applied " +
    "(atomic); update chunks must match uniquely.",
  inputSchema: z.toJSONSchema(paramsSchema) as JsonSchema,
  requiredPermission: "write",
  tier: 0,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";

/** One located change within an Update section (built context strings). */
export interface PatchChunk {
  /** The text to find (context + removed lines). */
  readonly find: string;
  /** The text to substitute (context + added lines). */
  readonly replace: string;
}

export type PatchOp =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo?: string;
      readonly chunks: readonly PatchChunk[];
    };

export interface ParseResult {
  readonly ops?: readonly PatchOp[];
  readonly error?: string;
}

function isHeader(line: string): boolean {
  return line.startsWith("*** ");
}

/** Build a chunk's find/replace strings from raw hunk body lines. */
function buildChunk(lines: string[]): PatchChunk {
  const find: string[] = [];
  const replace: string[] = [];
  for (const line of lines) {
    if (line.startsWith("+")) {
      replace.push(line.slice(1));
    } else if (line.startsWith("-")) {
      find.push(line.slice(1));
    } else {
      // Context: a leading space is the convention; a fully empty line is a
      // blank context line.
      const ctx = line.startsWith(" ") ? line.slice(1) : line;
      find.push(ctx);
      replace.push(ctx);
    }
  }
  return { find: find.join("\n"), replace: replace.join("\n") };
}

/** Split an Update section body into chunks on `@@` separators. */
function parseUpdateChunks(body: string[]): PatchChunk[] {
  const chunks: PatchChunk[] = [];
  let current: string[] = [];
  let started = false;

  const flush = () => {
    if (current.length > 0) chunks.push(buildChunk(current));
    current = [];
  };

  for (const line of body) {
    if (line.startsWith("@@")) {
      if (started) flush();
      started = true;
      continue;
    }
    started = true;
    current.push(line);
  }
  flush();
  return chunks;
}

export function parsePatch(patch: string): ParseResult {
  const raw = patch.replace(/\r\n/g, "\n").split("\n");

  const beginIdx = raw.findIndex((l) => l.trim() === BEGIN);
  if (beginIdx === -1) return { error: `patch missing "${BEGIN}" header` };
  const endIdx = raw.findIndex((l, i) => i > beginIdx && l.trim() === END);
  if (endIdx === -1) return { error: `patch missing "${END}" trailer` };

  const lines = raw.slice(beginIdx + 1, endIdx);
  const ops: PatchOp[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith(ADD)) {
      const filePath = line.slice(ADD.length).trim();
      i++;
      const contentLines: string[] = [];
      while (i < lines.length && !isHeader(lines[i]!)) {
        const l = lines[i]!;
        if (!l.startsWith("+")) {
          return { error: `Add File "${filePath}": every line must start with "+" (got: ${JSON.stringify(l)})` };
        }
        contentLines.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", path: filePath, content: contentLines.join("\n") });
      continue;
    }

    if (line.startsWith(DELETE)) {
      const filePath = line.slice(DELETE.length).trim();
      ops.push({ kind: "delete", path: filePath });
      i++;
      continue;
    }

    if (line.startsWith(UPDATE)) {
      const filePath = line.slice(UPDATE.length).trim();
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && lines[i]!.startsWith(MOVE)) {
        moveTo = lines[i]!.slice(MOVE.length).trim();
        i++;
      }
      const body: string[] = [];
      while (i < lines.length && !isHeader(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      const chunks = parseUpdateChunks(body);
      if (chunks.length === 0) {
        return { error: `Update File "${filePath}": no change hunks found` };
      }
      ops.push({ kind: "update", path: filePath, moveTo, chunks });
      continue;
    }

    return { error: `unexpected line in patch (expected a *** header): ${JSON.stringify(line)}` };
  }

  if (ops.length === 0) return { error: "patch contains no file operations" };
  return { ops };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

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

async function checkBoundary(
  filePath: string,
  cwd: string,
): Promise<{ resolved: string } | { error: string }> {
  const contained = await resolveInWorkspace(filePath, cwd);
  return contained.ok ? { resolved: contained.path } : { error: contained.message };
}

/** Apply update chunks in order to `content`; returns new content or an error. */
function applyChunks(content: string, chunks: readonly PatchChunk[], filePath: string):
  | { content: string }
  | { error: string } {
  let current = content;
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]!;
    const n = countOccurrences(current, chunk.find);
    if (n === 0) {
      return { error: `Update File "${filePath}" chunk ${c}: context not found` };
    }
    if (n > 1) {
      return {
        error: `Update File "${filePath}" chunk ${c}: context matches ${n} places — add more surrounding context to disambiguate`,
      };
    }
    current = current.replace(chunk.find, chunk.replace);
  }
  return { content: current };
}

interface PlannedWrite {
  readonly resolved: string;
  readonly content: string;
  readonly expectedHash?: string;
}
interface PlannedDelete {
  readonly resolved: string;
}

async function execute(raw: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: Input = parsed.data;

  const parsedPatch = parsePatch(input.patch);
  if (parsedPatch.error || !parsedPatch.ops) {
    return { status: "error", message: `patch parse error: ${parsedPatch.error}` };
  }

  // Phase 1: validate everything, planning writes/deletes without touching disk.
  const writes: PlannedWrite[] = [];
  const deletes: PlannedDelete[] = [];
  const summary: string[] = [];

  for (const op of parsedPatch.ops) {
    const bound = await checkBoundary(op.path, ctx.cwd);
    if ("error" in bound) return { status: "error", message: bound.error };
    const resolved = bound.resolved;

    if (op.kind === "add") {
      try {
        await fs.access(resolved);
        return { status: "error", message: `Add File "${op.path}": file already exists` };
      } catch {
        // Good — does not exist.
      }
      writes.push({ resolved, content: op.content });
      summary.push(`add ${op.path}`);
      continue;
    }

    if (op.kind === "delete") {
      try {
        await fs.access(resolved);
      } catch {
        return { status: "error", message: `Delete File "${op.path}": file not found` };
      }
      deletes.push({ resolved });
      summary.push(`delete ${op.path}`);
      continue;
    }

    // update
    let original: string;
    try {
      original = await fs.readFile(resolved, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `Update File "${op.path}": failed to read: ${msg}` };
    }
    const applied = applyChunks(original, op.chunks, op.path);
    if ("error" in applied) return { status: "error", message: applied.error };

    const expectedHash = crypto.createHash("sha256").update(original).digest("hex");

    if (op.moveTo) {
      const moveBound = await checkBoundary(op.moveTo, ctx.cwd);
      if ("error" in moveBound) return { status: "error", message: moveBound.error };
      try {
        await fs.access(moveBound.resolved);
        return { status: "error", message: `Move to "${op.moveTo}": target already exists` };
      } catch {
        // Good.
      }
      // Write the new file, then delete the old (verified against its hash).
      writes.push({ resolved: moveBound.resolved, content: applied.content });
      deletes.push({ resolved });
      summary.push(`update ${op.path} -> ${op.moveTo}`);
    } else {
      writes.push({ resolved, content: applied.content, expectedHash });
      summary.push(`update ${op.path}`);
    }
  }

  // Phase 2: apply. Writes first (create parent dirs), then deletes.
  try {
    for (const w of writes) {
      await fs.mkdir(path.dirname(w.resolved), { recursive: true });
      await atomicWrite(w.resolved, w.content, ctx.cwd, w.expectedHash);
    }
    for (const d of deletes) {
      await fs.unlink(d.resolved);
    }
  } catch (err) {
    if (err instanceof TocttouError) {
      return { status: "error", message: `TOCTTOU: ${err.message}. Re-read the file(s) and retry.` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `failed to apply patch: ${msg}` };
  }

  return {
    status: "ok",
    output: `applied patch (${parsedPatch.ops.length} op(s)):\n${summary.map((s) => `  ${s}`).join("\n")}`,
  };
}

function accesses(raw: unknown, ctx: ToolExecutionContext): ToolAccessesType {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return ToolAccesses.all();
  const parsedPatch = parsePatch(parsed.data.patch);
  if (!parsedPatch.ops || parsedPatch.ops.length === 0) return ToolAccesses.all();
  // Any path referenced by the patch may be written/deleted — declare a write
  // access for every affected file so the scheduler serializes correctly.
  const files: string[] = [];
  for (const op of parsedPatch.ops) {
    files.push(path.resolve(ctx.cwd, op.path));
    if (op.kind === "update" && op.moveTo) files.push(path.resolve(ctx.cwd, op.moveTo));
  }
  return files.flatMap((f) => ToolAccesses.writeFile(f));
}

export const applyPatchTool: ToolImpl = {
  spec,
  execute,
  zodSchema: inputSchema,
  accesses,
};
