/**
 * file-mention.ts — File candidate provider for @ mentions.
 *
 * Phase 6: When the user types `@` in the input, this module provides
 * file path completions backed by `git ls-files`. Results are cached
 * and debounced to avoid hammering git on every keystroke.
 */

import { execSync } from "child_process";

let _cachedFiles: string[] | undefined;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000;

function loadGitFiles(): string[] {
  try {
    const output = execSync("git ls-files", {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5000,
    });
    return output
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function getCachedFiles(): string[] {
  const now = Date.now();
  if (_cachedFiles === undefined || now - _cacheTimestamp > CACHE_TTL_MS) {
    _cachedFiles = loadGitFiles();
    _cacheTimestamp = now;
  }
  return _cachedFiles;
}

/**
 * Returns file candidates matching the given prefix.
 * If prefix is empty, returns all git-tracked files (up to a limit).
 */
export function getFileCandidates(
  prefix: string,
  maxResults = 20,
): Array<{ name: string; description: string }> {
  const files = getCachedFiles();
  const lowerPrefix = prefix.toLowerCase();

  const matches = files
    .filter((f) => f.toLowerCase().includes(lowerPrefix))
    .slice(0, maxResults);

  return matches.map((f) => ({
    name: f,
    description: "",
  }));
}

/**
 * Extracts the @-mention prefix from the input value at the given cursor position.
 * Returns undefined if there's no active @-mention at the cursor.
 */
export function extractMentionPrefix(
  value: string,
  cursor: number,
): string | undefined {
  const beforeCursor = value.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return undefined;
  // Only trigger if @ is at start or preceded by whitespace.
  if (atIndex > 0 && !/\s/.test(beforeCursor[atIndex - 1]!)) return undefined;
  const prefix = beforeCursor.slice(atIndex + 1);
  // Don't trigger if there's a space after @ (mention is complete).
  if (prefix.includes(" ")) return undefined;
  return prefix;
}

/** Replaces the @prefix at cursor with the full file path. */
export function applyMention(
  value: string,
  cursor: number,
  filePath: string,
): { value: string; cursor: number } {
  const beforeCursor = value.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return { value, cursor };
  const before = value.slice(0, atIndex);
  const after = value.slice(cursor);
  const newValue = `${before}@${filePath} ${after}`;
  const newCursor = before.length + 1 + filePath.length + 1;
  return { value: newValue, cursor: newCursor };
}

/** Reset the file cache (for testing). */
export function _resetCache(): void {
  _cachedFiles = undefined;
  _cacheTimestamp = 0;
}

/** Inject file list for testing. */
export function _setCachedFiles(files: string[]): void {
  _cachedFiles = files;
  _cacheTimestamp = Date.now();
}
