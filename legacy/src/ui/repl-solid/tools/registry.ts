/**
 * registry.ts — tool name → renderer dispatch.
 *
 * Each tool renderer provides three functions:
 *   chip()  — one-line summary suffix (e.g. "exit:0", "+5 -3", "42 lines")
 *   keyArg() — primary argument for the chip header (file path, command, pattern)
 *   body()  — expanded body content lines
 *
 * Phase 1a: only generic fallback. Phase 1b adds per-tool renderers.
 */

import type { ToolCallState } from "../../repl/state.js";
import { computeDiff, compactDiff, toUnifiedDiff } from "../diff/compute.js";
import { getStreamingArg } from "./streaming.js";
import { filetypeFromPath } from "../filetype.js";

export interface ToolRenderer {
  /** Numeric/status suffix for the chip header line. */
  chip(tc: ToolCallState): string;
  /** Primary argument extracted from args for the chip header. */
  keyArg(tc: ToolCallState): string;
  /** Body lines for expanded view. Returns empty array to suppress body. */
  bodyLines(tc: ToolCallState): readonly string[];
  /**
   * Tree-sitter filetype for the body content, when the body is source code
   * that should be syntax-highlighted via <code> (doc 49 Phase A2/A3). Returns
   * undefined for non-source bodies (bash/grep/glob output, JSON args) so the
   * chip falls back to plain <text>.
   */
  bodyFiletype?(tc: ToolCallState): string | undefined;
  /**
   * Unified-diff text for edit-style tools, rendered via <diff> when the chip is
   * expanded (doc 49 Phase B2) for line numbers + syntax-highlighted hunks.
   * Returns undefined/"" for non-edit tools so the chip uses body lines instead.
   */
  diffText?(tc: ToolCallState): string | undefined;
}

function getArg(tc: ToolCallState, key: string): string | undefined {
  if (tc.args !== null && typeof tc.args === "object") {
    const val = (tc.args as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  // Phase 4: fall back to streaming args for live preview during streaming.
  if (tc.pending && tc.streamingArgs.length > 0) {
    return getStreamingArg(tc.streamingArgs, key);
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

const genericRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    if (tc.isError) return "error";
    return "";
  },
  keyArg(tc) {
    if (tc.args === null || tc.args === undefined) return "";
    if (typeof tc.args === "object") {
      const entries = Object.entries(tc.args as Record<string, unknown>);
      if (entries.length > 0) {
        const [, val] = entries[0]!;
        if (typeof val === "string") return truncate(val, 60);
      }
    }
    return "";
  },
  bodyLines(tc) {
    const lines: string[] = [];
    if (tc.args !== undefined) {
      try {
        const argsText = JSON.stringify(tc.args, null, 2);
        lines.push(...argsText.split("\n").slice(0, 10));
        const total = argsText.split("\n").length;
        if (total > 10) lines.push(`… ${total - 10} more lines`);
      } catch {
        lines.push(String(tc.args));
      }
    }
    if (tc.result !== undefined) {
      lines.push("");
      const resultLines = tc.result.split("\n");
      lines.push(...resultLines.slice(0, 20));
      if (resultLines.length > 20) {
        lines.push(`… ${resultLines.length - 20} more lines`);
      }
    }
    return lines;
  },
};

const bashRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    if (tc.result === undefined) return "";
    // Try to extract exit code from result — tool_result for bash typically
    // starts with the output; exit code may be in the result or args.
    if (tc.isError) return "exit:1";
    return "exit:0";
  },
  keyArg(tc) {
    const cmd = getArg(tc, "command");
    if (cmd === undefined) return "";
    return truncate(cmd.split("\n")[0] ?? "", 60);
  },
  bodyLines(tc) {
    const lines: string[] = [];
    const cmd = getArg(tc, "command");
    if (cmd) lines.push(`$ ${cmd}`);
    if (tc.result !== undefined) {
      if (lines.length > 0) lines.push("");
      const resultLines = tc.result.split("\n");
      lines.push(...resultLines.slice(0, 30));
      if (resultLines.length > 30) {
        lines.push(`… ${resultLines.length - 30} more lines`);
      }
    }
    return lines;
  },
};

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

const readRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    if (tc.result === undefined) return "";
    return `${countLines(tc.result)} lines`;
  },
  keyArg(tc) {
    return getArg(tc, "file_path") ?? getArg(tc, "path") ?? "";
  },
  bodyLines(tc) {
    if (tc.result === undefined) return [];
    const lines = tc.result.split("\n");
    if (lines.length <= 30) return lines;
    return [...lines.slice(0, 30), `… ${lines.length - 30} more lines`];
  },
  bodyFiletype(tc) {
    return filetypeFromPath(
      getArg(tc, "file_path") ?? getArg(tc, "path"),
    );
  },
};

function parseDiffStats(tc: ToolCallState): string {
  if (tc.result === undefined) return "";
  const oldStr = getArg(tc, "old_string") ?? getArg(tc, "old_str") ?? "";
  const newStr = getArg(tc, "new_string") ?? getArg(tc, "new_str") ?? "";
  const added = countLines(newStr);
  const removed = countLines(oldStr);
  return `+${added} -${removed}`;
}

const editRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    if (tc.isError) return "error";
    return parseDiffStats(tc);
  },
  keyArg(tc) {
    return getArg(tc, "file_path") ?? getArg(tc, "path") ?? "";
  },
  bodyLines(tc) {
    const lines: string[] = [];
    const oldStr = getArg(tc, "old_string") ?? getArg(tc, "old_str") ?? "";
    const newStr = getArg(tc, "new_string") ?? getArg(tc, "new_str") ?? "";
    if (oldStr || newStr) {
      const diff = computeDiff(oldStr, newStr, { isIncomplete: tc.pending });
      const { lines: compacted, hiddenChanges } = compactDiff(diff, {
        contextLines: 3,
        maxChanges: 10,
      });
      for (const dl of compacted) {
        const prefix = dl.kind === "add" ? "+ " : dl.kind === "delete" ? "- " : "  ";
        lines.push(`${prefix}${dl.text}`);
      }
      if (hiddenChanges > 0) {
        lines.push(`  … ${hiddenChanges} more changes (ctrl+o to expand)`);
      }
    }
    if (tc.result !== undefined && tc.isError) {
      lines.push("");
      lines.push(tc.result);
    }
    return lines;
  },
  bodyFiletype(tc) {
    return filetypeFromPath(getArg(tc, "file_path") ?? getArg(tc, "path"));
  },
  diffText(tc) {
    const oldStr = getArg(tc, "old_string") ?? getArg(tc, "old_str") ?? "";
    const newStr = getArg(tc, "new_string") ?? getArg(tc, "new_str") ?? "";
    if (oldStr.length === 0 && newStr.length === 0) return undefined;
    const path = getArg(tc, "file_path") ?? getArg(tc, "path");
    return toUnifiedDiff(oldStr, newStr, path, { isIncomplete: tc.pending });
  },
};

const writeRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    const content = getArg(tc, "content") ?? "";
    return `${countLines(content)} lines`;
  },
  keyArg(tc) {
    return getArg(tc, "file_path") ?? getArg(tc, "path") ?? "";
  },
  bodyLines(tc) {
    const content = getArg(tc, "content") ?? "";
    if (content.length === 0) return [];
    const lines = content.split("\n");
    if (lines.length <= 30) return lines;
    return [...lines.slice(0, 30), `… ${lines.length - 30} more lines`];
  },
  bodyFiletype(tc) {
    return filetypeFromPath(
      getArg(tc, "file_path") ?? getArg(tc, "path"),
    );
  },
};

function parseMatchCount(result: string): number {
  return result.split("\n").filter((l) => l.length > 0).length;
}

const grepRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    if (tc.result === undefined) return "";
    const matches = parseMatchCount(tc.result);
    return `${matches} matches`;
  },
  keyArg(tc) {
    return getArg(tc, "pattern") ?? "";
  },
  bodyLines(tc) {
    if (tc.result === undefined) return [];
    const lines = tc.result.split("\n").filter((l) => l.length > 0);
    const sample = lines.slice(0, 5);
    if (lines.length > 5) {
      sample.push(`… +${lines.length - 5} more`);
    }
    return sample;
  },
};

const globRenderer: ToolRenderer = {
  chip(tc) {
    if (tc.pending) return "";
    if (tc.result === undefined) return "";
    const files = tc.result.split("\n").filter((l) => l.length > 0);
    return `${files.length} files`;
  },
  keyArg(tc) {
    return getArg(tc, "pattern") ?? "";
  },
  bodyLines(tc) {
    if (tc.result === undefined) return [];
    const files = tc.result.split("\n").filter((l) => l.length > 0);
    const sample = files.slice(0, 5);
    if (files.length > 5) {
      sample.push(`… +${files.length - 5} more`);
    }
    return sample;
  },
};

const REGISTRY: Record<string, ToolRenderer> = {
  bash: bashRenderer,
  shell_exec: bashRenderer,
  read_file: readRenderer,
  edit_file: editRenderer,
  multi_edit: editRenderer,
  write_file: writeRenderer,
  grep: grepRenderer,
  glob: globRenderer,
};

export function getRenderer(toolName: string): ToolRenderer {
  return REGISTRY[toolName] ?? genericRenderer;
}
