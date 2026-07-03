/**
 * read-state — session-scoped tracking of which files the agent has read.
 *
 * Claude Code (and MiMoCode) enforce a read-before-edit contract: Edit/Write
 * on an existing file fails with a recoverable error unless the file was
 * Read earlier in the session. Models trained on those harnesses expect the
 * contract and self-correct when they hit the error, so we enforce the same
 * rule here (docs/04-tool-tiers.md, "Claude Code schema alignment").
 *
 * State is process-global: each openswarm agent runs its tools in its own
 * process, so a module-level set is effectively session scope. Writes also
 * record state — after write_file/edit_file succeed the agent knows the
 * file's content, so requiring a re-read would only add noise.
 */

import * as path from "node:path";

const readPaths = new Set<string>();

/** Normalize to an absolute path so relative/absolute callers agree. */
function normalize(absPath: string): string {
  return path.resolve(absPath);
}

/** Record that a file's current content is known to the agent. */
export function recordFileRead(absPath: string): void {
  readPaths.add(normalize(absPath));
}

/** True when the file was read (or written) earlier in this session. */
export function hasFileBeenRead(absPath: string): boolean {
  return readPaths.has(normalize(absPath));
}

/**
 * The Claude Code error string for read-before-edit violations. Trained
 * models recognize this exact phrasing and respond by reading the file.
 */
export const READ_BEFORE_EDIT_ERROR =
  "File has not been read yet. Read it first before writing to it.";

/** Reset all read state (test isolation). */
export function clearReadState(): void {
  readPaths.clear();
}
