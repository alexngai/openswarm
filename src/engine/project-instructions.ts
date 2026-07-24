/**
 * Project instruction file loading — CLAUDE.md / AGENTS.md ancestor walk.
 *
 * Claude Code (and claw) include the contents of instruction files from the
 * repo root down to the CWD "with the developer message". OpenSwarm's native /
 * hardened engines never loaded these (only the Claude SDK path did, via the
 * SDK's own `settingSources`), so native-model sessions silently ran without
 * project conventions. This module fills that gap and feeds two consumers:
 *
 *   1. startup — folded into the system prompt (buildSystemPrompt extensions)
 *   2. post-compaction — re-injected as an attachment via the recontextualize()
 *      hook (docs/48-compaction-design.md follow-up F1), mirroring CC's
 *      re-read-after-compaction behavior.
 *
 * Discovery walks CWD upward to the filesystem root; at each level it reads a
 * fixed set of filenames. Results are ordered root → CWD so the deepest
 * (most specific) scope appears last, deduped by a content hash, and clamped
 * to per-file / total budgets (see
 * docs/research/03-runtime.md §7).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Instruction filenames checked at each ancestor level, in precedence order. */
export const INSTRUCTION_FILENAMES: readonly string[] = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
];

/** MAX_INSTRUCTION_FILE_CHARS — per-file content budget. */
export const MAX_INSTRUCTION_FILE_CHARS = 4_000;
/** MAX_TOTAL_INSTRUCTION_CHARS — combined budget across all files. */
export const MAX_TOTAL_INSTRUCTION_CHARS = 12_000;

const TRUNCATION_MARKER = "\n\n[truncated]";
const BUDGET_EXHAUSTED_NOTE =
  "_Additional instruction content omitted after reaching the prompt budget._";

export interface ProjectInstructionFile {
  /** Absolute path of the instruction file. */
  readonly path: string;
  /** File content, clamped to MAX_INSTRUCTION_FILE_CHARS. */
  readonly content: string;
}

export interface ProjectInstructions {
  /** Discovered files, ordered root → CWD (deepest scope last). */
  readonly files: readonly ProjectInstructionFile[];
}

export interface LoadInstructionsOptions {
  /** Override the filename set (tests). */
  readonly filenames?: readonly string[];
  /** Override the per-file char budget (tests). */
  readonly maxFileChars?: number;
  /** Override the total char budget (tests). */
  readonly maxTotalChars?: number;
}

/** Whitespace-collapsed, trimmed hash for cross-level dedupe. */
function contentHash(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

/** Ancestor directories of `cwd`, ordered root → cwd (deepest last). */
function ancestorsRootFirst(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  while (true) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}

/**
 * Load project instruction files by walking `cwd` up to the filesystem root.
 * Pure apart from reading the filesystem; never throws (unreadable files are
 * skipped). Enforces per-file and total budgets and drops duplicate content
 * that appears at multiple levels.
 */
export function loadProjectInstructions(
  cwd: string,
  opts?: LoadInstructionsOptions,
): ProjectInstructions {
  const filenames = opts?.filenames ?? INSTRUCTION_FILENAMES;
  const maxFileChars = opts?.maxFileChars ?? MAX_INSTRUCTION_FILE_CHARS;
  const maxTotalChars = opts?.maxTotalChars ?? MAX_TOTAL_INSTRUCTION_CHARS;

  const files: ProjectInstructionFile[] = [];
  const seenHashes = new Set<string>();
  let totalChars = 0;
  let budgetExhausted = false;

  for (const dir of ancestorsRootFirst(cwd)) {
    for (const name of filenames) {
      if (budgetExhausted) break;
      const filePath = path.join(dir, name);
      let raw: string;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) continue;
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue; // missing / unreadable — skip
      }
      if (raw.trim() === "") continue;

      const hash = contentHash(raw);
      if (seenHashes.has(hash)) continue; // duplicate across levels
      seenHashes.add(hash);

      let content = raw;
      if (content.length > maxFileChars) {
        content = content.slice(0, maxFileChars) + TRUNCATION_MARKER;
      }

      if (totalChars + content.length > maxTotalChars) {
        const remaining = maxTotalChars - totalChars;
        if (remaining > BUDGET_EXHAUSTED_NOTE.length + 64) {
          content =
            content.slice(0, remaining - BUDGET_EXHAUSTED_NOTE.length - 2) +
            "\n\n" +
            BUDGET_EXHAUSTED_NOTE;
          files.push({ path: filePath, content });
          totalChars += content.length;
        }
        budgetExhausted = true;
        break;
      }

      files.push({ path: filePath, content });
      totalChars += content.length;
    }
    if (budgetExhausted) break;
  }

  return { files };
}

/** Render one `<instructions path="…">…</instructions>` block. */
function renderBlock(file: ProjectInstructionFile): string {
  return `<instructions path="${file.path}">\n${file.content}\n</instructions>`;
}

/**
 * Format instructions for inclusion in the system prompt (buildSystemPrompt
 * `extensions`). Empty string when there are no files, so callers can pass it
 * unconditionally.
 */
export function formatInstructionsForSystemPrompt(
  instructions: ProjectInstructions,
): string {
  if (instructions.files.length === 0) return "";
  const blocks = instructions.files.map(renderBlock).join("\n\n");
  return (
    `## Project instructions\n\n` +
    `The following instruction files apply to this workspace ` +
    `(deepest scope last). Follow them as you would direct user instructions, ` +
    `except where they conflict with an explicit user request.\n\n` +
    blocks
  );
}

/**
 * Format instructions as the inner text of a post-compaction system-reminder
 * attachment. Empty string when there are no files.
 */
export function formatInstructionsAsReminder(
  instructions: ProjectInstructions,
): string {
  if (instructions.files.length === 0) return "";
  const blocks = instructions.files.map(renderBlock).join("\n\n");
  return (
    `Project instruction files (re-attached after compaction — these still ` +
    `apply):\n\n${blocks}`
  );
}
