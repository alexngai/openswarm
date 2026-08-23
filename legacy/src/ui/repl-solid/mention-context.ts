/**
 * mention-context.ts — expand @-mentioned files into engine prompt context
 * (doc 49 Phase D1).
 *
 * The input UI tracks files the user referenced with `@path` in
 * state.mentionedFiles, but until now nothing fed them to the engine. On submit,
 * app.tsx calls buildMentionContext() to append the referenced files' contents to
 * the prompt string sent to the engine (the visible transcript still shows the
 * original `@path` text).
 *
 * Bounded: at most MAX_FILES files, MAX_BYTES per file, to avoid blowing up the
 * context window. Unreadable paths are noted inline rather than throwing.
 */

import { readFileSync } from "node:fs";

const MAX_FILES = 10;
const MAX_BYTES = 64 * 1024;

/**
 * Build an engine-facing context block for the given mentioned file paths.
 * Returns "" when there are no files, so callers can send the prompt unchanged.
 */
export function buildMentionContext(files: readonly string[]): string {
  if (files.length === 0) return "";
  const blocks: string[] = [];
  for (const path of files.slice(0, MAX_FILES)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const content =
        raw.length > MAX_BYTES
          ? `${raw.slice(0, MAX_BYTES)}\n… (truncated at ${MAX_BYTES} bytes)`
          : raw;
      blocks.push(`<file path="${path}">\n${content}\n</file>`);
    } catch (err) {
      blocks.push(`<file path="${path}" error="${String(err)}" />`);
    }
  }
  const omitted = files.length > MAX_FILES ? files.length - MAX_FILES : 0;
  const footer = omitted > 0 ? `\n(${omitted} more referenced file(s) omitted)` : "";
  return `\n\nReferenced files:\n${blocks.join("\n\n")}${footer}`;
}
