/**
 * Post-compact history rebuild — attachment re-injection (Claude Code shape).
 *
 * After full compaction Claude Code keeps ZERO messages verbatim; instead it
 * re-injects working state as attachments after the continuation message
 * (docs/48-compaction-design.md §L4):
 *
 *   - the 5 most recently read files (CC H$n = 5), re-read from disk, within
 *     a 50k-token total budget (CC Z1m = 50000) and a per-file token cap
 *     (CC eNm = 5000); oversized files degrade to CC's compact_file_reference
 *     note instead of content
 *   - the latest todo_write snapshot
 *   - CLAUDE.md / memory re-injection is follow-up F1 (see design doc §L4 and
 *     Resolved questions #2) — TODO(F1): recontextualize() runtime callback.
 *
 * Attachments are user messages wrapped in <system-reminder> tags, mirroring
 * how our tool harness (and CC) deliver ambient context.
 */

import * as fs from "node:fs";
import type { ProviderMessage } from "../providers/index.js";
import {
  extractLatestTodos,
  renderTodoProgressBlock,
} from "./compactor.js";
import {
  clearReadState,
  recentReadFiles,
  recordFileRead,
} from "../tools/tier0/read-state.js";
import {
  loadProjectInstructions,
  formatInstructionsAsReminder,
} from "./project-instructions.js";

/**
 * Runtime callback that returns extra attachments to re-inject after
 * compaction — the F1 `recontextualize()` hook. Called once per full
 * compaction; returned messages are placed right after the continuation
 * message (ahead of file/todo attachments). Async so callers can re-read
 * files or query memory. See docs/48-compaction-design.md follow-up F1.
 */
export type RecontextualizeFn = () =>
  | readonly ProviderMessage[]
  | Promise<readonly ProviderMessage[]>;

/** CC H$n: number of recently-read files to re-inject. */
export const POST_COMPACT_FILE_COUNT = 5;
/** CC Z1m: total token budget across all re-injected files. */
export const POST_COMPACT_TOTAL_TOKEN_BUDGET = 50_000;
/** CC eNm: per-file token cap; larger files degrade to a reference note. */
export const POST_COMPACT_FILE_TOKEN_CAP = 5_000;

function estimateTextTokens(text: string): number {
  return Math.floor(text.length / 4) + 1;
}

/** CC compact_file_reference note (Read tool named read_file in our harness). */
export function compactFileReferenceNote(filename: string): string {
  return `Note: ${filename} was read before the last conversation was summarized, but the contents are too large to include. Use read_file tool if you need to access it.`;
}

function userReminder(text: string): ProviderMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` },
    ],
  };
}

/**
 * Build a `recontextualize()` callback that re-reads the project instruction
 * files (CLAUDE.md / AGENTS.md ancestor walk) and returns them as a
 * post-compaction attachment — CC re-reads these after every compaction.
 *
 * Curated memory is intentionally NOT re-injected here: OpenSwarm folds it
 * into the system prompt (resent every request, untouched by compaction), so
 * it already survives the boundary. Re-injecting it would duplicate context.
 */
export function makeProjectInstructionsRecontextualizer(
  cwd: string,
): RecontextualizeFn {
  return () => {
    const instructions = loadProjectInstructions(cwd);
    const text = formatInstructionsAsReminder(instructions);
    return text === "" ? [] : [userReminder(text)];
  };
}

/** cat -n numbering matching the read_file tool output format. */
function numberLines(content: string): string {
  return content
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(6)}\t${line}`)
    .join("\n");
}

/**
 * Build the post-compact attachment messages from the pre-compaction history
 * and the read-state module. Clears read state (CC clears readFileState) and
 * re-records the files that were re-injected so the read-before-edit contract
 * keeps working across the boundary.
 */
export function buildPostCompactAttachments(
  preCompactionMessages: readonly ProviderMessage[],
): ProviderMessage[] {
  const attachments: ProviderMessage[] = [];

  // --- File re-injection ---------------------------------------------------
  const recent = recentReadFiles(POST_COMPACT_FILE_COUNT);
  clearReadState();

  let budgetUsed = 0;
  for (const filePath of recent) {
    let content: string;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue; // deleted/unreadable since the read — skip silently
    }

    const tokens = estimateTextTokens(content);
    if (tokens > POST_COMPACT_FILE_TOKEN_CAP) {
      // CC: too large to include → reference note (no budget cost worth
      // tracking; the note is tiny).
      attachments.push(userReminder(compactFileReferenceNote(filePath)));
      continue;
    }
    if (budgetUsed + tokens > POST_COMPACT_TOTAL_TOKEN_BUDGET) continue;
    budgetUsed += tokens;

    attachments.push(
      userReminder(
        `The following file was read before the conversation was summarized and is re-attached for continuity:\n<file path="${filePath}">\n${numberLines(content)}\n</file>`,
      ),
    );
    recordFileRead(filePath);
  }

  // --- Todo re-injection ---------------------------------------------------
  const todos = extractLatestTodos(preCompactionMessages);
  if (todos !== null) {
    attachments.push(
      userReminder(
        `Your todo list from before the conversation was summarized:\n${renderTodoProgressBlock(todos)}\nContinue working through the remaining items.`,
      ),
    );
  }

  // Project instructions (CLAUDE.md / AGENTS.md) are re-injected by the
  // engine via the recontextualize() hook (see RecontextualizeFn /
  // makeProjectInstructionsRecontextualizer) rather than here — the hook keeps
  // this function decoupled from cwd/memory. Curated memory survives via the
  // system prompt and is deliberately not re-injected (docs/48 §L4, F1).

  return attachments;
}
