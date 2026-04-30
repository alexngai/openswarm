/**
 * history.ts — persistent prompt history for the swarm-harness REPL.
 *
 * Pure Node module: no UI deps, no Solid, no @opentui imports. File I/O is
 * intentionally synchronous so the submit flow stays simple — `appendFileSync`
 * is a single atomic call and doesn't require awaiting before the next dispatch.
 *
 * File format: plain newline-delimited UTF-8. One entry per line.
 * Multi-line entries are flattened on save:
 *   \n → \x01 (SOH)
 *   \r → \x02 (STX)
 * and restored on load. Blank entries and consecutive duplicates are skipped.
 *
 * Cap: HISTORY_CAP entries. On overflow, the file is rewritten keeping the
 * most recent HISTORY_CAP entries (truncate-from-front).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const HISTORY_CAP = 10_000;

export const DEFAULT_HISTORY_PATH = path.join(
  os.homedir(),
  ".swarm-harness",
  "history",
);

/** Resolve path: prefer SWARM_HARNESS_HISTORY_PATH env override, then default. */
function resolvePath(filePath?: string): string {
  return filePath ?? process.env["SWARM_HARNESS_HISTORY_PATH"] ?? DEFAULT_HISTORY_PATH;
}

/**
 * Load history from the given file (or default path).
 * Missing file → []. Malformed lines are silently skipped.
 * Restores \x01 → \n and \x02 → \r per entry.
 */
export function loadHistory(filePath?: string): string[] {
  const resolved = resolvePath(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    // Missing file or unreadable — start with empty history.
    return [];
  }

  const lines = raw.split("\n");
  // Drop trailing empty line produced by a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const result: string[] = [];
  for (const line of lines) {
    try {
      // Restore escaped control chars.
      const entry = line.replace(/\x01/g, "\n").replace(/\x02/g, "\r");
      result.push(entry);
    } catch {
      // Skip lines that fail to decode (shouldn't happen with UTF-8 readFileSync).
    }
  }
  return result;
}

/**
 * Append a single entry to the history file.
 * - Skips blank entries (entry.trim() === "").
 * - Skips if entry is identical to the last line already in the file (consecutive dedup).
 * - Flattens internal \n → \x01, \r → \x02 before writing.
 * - If the file is at/above cap after the append, rewrites with the most recent HISTORY_CAP entries.
 */
export function appendHistoryEntry(entry: string, filePath?: string): void {
  if (entry.trim() === "") return;

  const resolved = resolvePath(filePath);

  // Ensure the directory exists.
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  // Escape internal newlines.
  const escaped = entry.replace(/\n/g, "\x01").replace(/\r/g, "\x02");

  // Read current file to check for consecutive duplicate and current length.
  let existing: string[] = [];
  try {
    const raw = fs.readFileSync(resolved, "utf8");
    const lines = raw.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    existing = lines;
  } catch {
    // File doesn't exist yet — existing stays [].
  }

  // Consecutive dedup: skip if last entry matches.
  if (existing.length > 0 && existing[existing.length - 1] === escaped) {
    return;
  }

  existing.push(escaped);

  // If over cap, rewrite with the tail (most recent HISTORY_CAP entries).
  if (existing.length > HISTORY_CAP) {
    const trimmed = existing.slice(existing.length - HISTORY_CAP);
    fs.writeFileSync(resolved, trimmed.join("\n") + "\n", "utf8");
    return;
  }

  // Happy path: simple append.
  fs.appendFileSync(resolved, escaped + "\n", "utf8");
}
