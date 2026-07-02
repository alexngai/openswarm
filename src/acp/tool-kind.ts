/**
 * Maps OpenSwarm Tier-0 tool calls onto ACP presentation: ToolKind (icon /
 * UI treatment), a human-readable title, follow-along file locations, and
 * inline diffs for edit-family tools. Built from the tool *input* args, which
 * are available before the tool runs. See docs/32 §4.
 */

import type {
  ToolKind,
  ToolCallLocation,
  ToolCallContent,
} from "@agentclientprotocol/sdk";
import { parsePatch } from "../tools/tier0/apply_patch.js";

const KIND: Record<string, ToolKind> = {
  read_file: "read",
  write_file: "edit",
  edit_file: "edit",
  multi_edit: "edit",
  apply_patch: "edit",
  glob: "search",
  grep: "search",
  bash: "execute",
  todo_write: "other",
};

export function toolKind(name: string): ToolKind {
  return KIND[name] ?? "other";
}

export function isEditTool(name: string): boolean {
  return (
    name === "edit_file" ||
    name === "write_file" ||
    name === "multi_edit" ||
    name === "apply_patch"
  );
}

function asRecord(input: unknown): Record<string, unknown> {
  return input != null && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function truncate(s: string, n = 60): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

export function toolTitle(name: string, input: unknown): string {
  const i = asRecord(input);
  const p = str(i.path);
  if (name === "apply_patch") {
    const patch = str(i.patch);
    const ops = patch ? parsePatch(patch).ops : undefined;
    return ops && ops.length > 0 ? `Apply patch (${ops.length} file${ops.length > 1 ? "s" : ""})` : "Apply patch";
  }
  switch (name) {
    case "read_file":
      return p ? `Read ${p}` : "Read file";
    case "write_file":
      return p ? `Write ${p}` : "Write file";
    case "edit_file":
    case "multi_edit":
      return p ? `Edit ${p}` : "Edit file";
    case "glob":
      return str(i.pattern) ? `Find ${str(i.pattern)}` : "Find files";
    case "grep":
      return str(i.pattern) ? `Search ${str(i.pattern)}` : "Search";
    case "bash":
      return str(i.command) ? `$ ${truncate(str(i.command)!)}` : "Run command";
    case "todo_write":
      return "Update plan";
    default:
      return name;
  }
}

export function toolLocations(
  name: string,
  input: unknown,
): ToolCallLocation[] | undefined {
  const i = asRecord(input);
  if (name === "apply_patch") {
    const patch = str(i.patch);
    const ops = patch ? parsePatch(patch).ops : undefined;
    if (!ops || ops.length === 0) return undefined;
    return ops.map((op) => ({ path: op.kind === "update" && op.moveTo ? op.moveTo : op.path }));
  }
  const p = str(i.path);
  if (p === undefined) return undefined;
  if (name === "read_file") {
    // read_file `offset` is a 0-based line index; ACP line is 1-based.
    const line = typeof i.offset === "number" ? i.offset + 1 : undefined;
    return [{ path: p, ...(line !== undefined ? { line } : {}) }];
  }
  if (isEditTool(name)) {
    return [{ path: p }];
  }
  return undefined;
}

/**
 * Inline diff content for edit-family tools, derived from the tool input args.
 * edit_file carries old/new strings; write_file is a whole-file write
 * (oldText: null = treat as new content); multi_edit yields one diff per edit.
 */
export function diffContent(
  name: string,
  input: unknown,
): ToolCallContent[] | undefined {
  const i = asRecord(input);
  if (name === "apply_patch") {
    const patch = str(i.patch);
    const ops = patch ? parsePatch(patch).ops : undefined;
    if (!ops || ops.length === 0) return undefined;
    const out: ToolCallContent[] = [];
    for (const op of ops) {
      if (op.kind === "add") {
        out.push({ type: "diff", path: op.path, oldText: null, newText: op.content });
      } else if (op.kind === "update") {
        const target = op.moveTo ?? op.path;
        for (const chunk of op.chunks) {
          out.push({ type: "diff", path: target, oldText: chunk.find, newText: chunk.replace });
        }
      }
      // delete: no reliable oldText from input args — omit from the diff view.
    }
    return out.length > 0 ? out : undefined;
  }
  const p = str(i.path);
  if (p === undefined) return undefined;
  if (name === "edit_file") {
    return [
      {
        type: "diff",
        path: p,
        oldText: String(i.old_string ?? ""),
        newText: String(i.new_string ?? ""),
      },
    ];
  }
  if (name === "write_file") {
    return [{ type: "diff", path: p, oldText: null, newText: String(i.content ?? "") }];
  }
  if (name === "multi_edit" && Array.isArray(i.edits)) {
    return i.edits.map((e) => {
      const ed = asRecord(e);
      return {
        type: "diff" as const,
        path: p,
        oldText: String(ed.old_string ?? ""),
        newText: String(ed.new_string ?? ""),
      };
    });
  }
  return undefined;
}
