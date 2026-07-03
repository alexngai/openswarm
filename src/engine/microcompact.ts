/**
 * Microcompaction — clear old tool_result contents without a model call.
 *
 * Port of Claude Code v2.1.198's microcompaction (docs/48-compaction-design.md
 * §L2), corroborated by MiMoCode's prune.ts. Runs when context usage crosses
 * the warn threshold and as a cheap first attempt when full compaction
 * triggers — if it saves enough, the expensive summarization is deferred.
 *
 * CC semantics, MiMoCode guards:
 *  - protect the 5 most recent tool results (CC keepRecent = 5)
 *  - protect everything in the last 2 user turns (MiMoCode `turns < 2`)
 *  - only act when total savings ≥ 20_000 estimated tokens (CC wpo / MiMoCode
 *    PRUNE_MINIMUM — both 20k)
 *  - replace cleared content with CC's byte-exact placeholder; contents larger
 *    than 2k chars are persisted to disk first and replaced with CC's
 *    persisted-output pointer instead.
 *
 * Message identity is preserved (only tool_result block contents change), so
 * provider replay and prompt-cache prefixes stay valid up to the first
 * cleared block.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderMessage } from "../providers/index.js";

// ---------------------------------------------------------------------------
// Claude Code byte-exact strings + constants
// ---------------------------------------------------------------------------

/** CC placeholder for cleared tool results (b_c / a$n in the binary). */
export const CLEARED_TOOL_RESULT_PLACEHOLDER =
  "[Old tool result content cleared]";

/** CC persisted-output wrapper tags (ubp / closing tag). */
export const PERSISTED_OUTPUT_OPEN = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSE = "</persisted-output>";

/** CC keepRecent: never clear the N most recent tool results. */
export const MICROCOMPACT_KEEP_RECENT = 5;
/** MiMoCode guard: never clear results inside the last N user turns. */
export const MICROCOMPACT_PROTECT_TURNS = 2;
/** CC wpo = 20000: only microcompact when it saves at least this much. */
export const MICROCOMPACT_MIN_SAVINGS_TOKENS = 20_000;
/** CC dbp = 2000: persist cleared contents larger than this (chars). */
export const MICROCOMPACT_PERSIST_MIN_CHARS = 2_000;

/** CC persisted-output pointer (Read tool renamed to our read_file). */
export function persistedOutputPointer(filePath: string): string {
  return `${PERSISTED_OUTPUT_OPEN}Tool result saved to: ${filePath}\n\nUse read_file to view${PERSISTED_OUTPUT_CLOSE}`;
}

// ---------------------------------------------------------------------------
// Options / result
// ---------------------------------------------------------------------------

export interface MicrocompactOptions {
  /**
   * Directory for persisted cleared outputs (`<stateDir>/cleared-tool-results/`).
   * When unset, everything becomes the bare placeholder.
   */
  readonly stateDir?: string;
  /** Override CC's keep-recent count (tests). */
  readonly keepRecent?: number;
  /** Override the 20k minimum-savings gate (tests). */
  readonly minSavingsTokens?: number;
}

export interface MicrocompactResult {
  readonly messages: ProviderMessage[];
  readonly tokensSaved: number;
  readonly toolsCleared: number;
  readonly toolsKept: number;
}

// ---------------------------------------------------------------------------
// Microcompaction
// ---------------------------------------------------------------------------

interface Candidate {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly toolUseId: string;
  readonly content: string;
}

function isCleared(content: string): boolean {
  return (
    content === CLEARED_TOOL_RESULT_PLACEHOLDER ||
    content.startsWith(PERSISTED_OUTPUT_OPEN)
  );
}

/** True when the message is a real user turn (text, not a tool_result carrier). */
function isUserTextTurn(msg: ProviderMessage): boolean {
  return (
    msg.role === "user" &&
    msg.content.some((b) => b.type === "text") &&
    !msg.content.some((b) => b.type === "tool_result")
  );
}

/**
 * Clear old tool_result contents. Returns null when nothing qualifies (fewer
 * candidates than the savings gate requires). Pure apart from persisting
 * oversized contents to `<stateDir>/cleared-tool-results/`.
 */
export function microcompactMessages(
  messages: readonly ProviderMessage[],
  opts?: MicrocompactOptions,
): MicrocompactResult | null {
  const keepRecent = opts?.keepRecent ?? MICROCOMPACT_KEEP_RECENT;
  const minSavings = opts?.minSavingsTokens ?? MICROCOMPACT_MIN_SAVINGS_TOKENS;

  // Turn protection (MiMoCode `turns < 2`): everything at or after the
  // PROTECT_TURNS-th user text turn from the end is protected. Sessions with
  // fewer user turns (e.g. single-prompt headless agent loops) rely on the
  // keepRecent guard alone — otherwise a one-prompt session could never
  // microcompact at all.
  let protectFrom = Number.POSITIVE_INFINITY;
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserTextTurn(messages[i]!)) {
      turnsSeen++;
      if (turnsSeen >= MICROCOMPACT_PROTECT_TURNS) {
        protectFrom = i;
        break;
      }
    }
  }

  // Collect all uncleared tool results oldest → newest.
  const all: Candidate[] = [];
  for (let m = 0; m < messages.length; m++) {
    const msg = messages[m]!;
    if (msg.role !== "user") continue;
    for (let b = 0; b < msg.content.length; b++) {
      const block = msg.content[b]!;
      if (block.type !== "tool_result") continue;
      if (isCleared(block.content)) continue;
      all.push({
        messageIndex: m,
        blockIndex: b,
        toolUseId: block.tool_use_id,
        content: block.content,
      });
    }
  }

  // Candidates: everything except the keepRecent newest and the protected
  // trailing turns.
  const cutoff = Math.max(0, all.length - keepRecent);
  const candidates = all
    .slice(0, cutoff)
    .filter((c) => c.messageIndex < protectFrom);

  if (candidates.length === 0) return null;

  // char/4 savings estimate (same estimator as compactor.ts).
  let tokensSaved = 0;
  for (const c of candidates) {
    tokensSaved += Math.floor(c.content.length / 4) + 1;
  }
  if (tokensSaved < minSavings) return null;

  // Persist + replace.
  let persistDir: string | undefined;
  if (opts?.stateDir !== undefined) {
    persistDir = path.join(opts.stateDir, "cleared-tool-results");
  }

  const replacements = new Map<string, string>(); // "m:b" → new content
  for (const c of candidates) {
    let replacement = CLEARED_TOOL_RESULT_PLACEHOLDER;
    if (
      persistDir !== undefined &&
      c.content.length > MICROCOMPACT_PERSIST_MIN_CHARS
    ) {
      try {
        fs.mkdirSync(persistDir, { recursive: true });
        const safeId = c.toolUseId.replace(/[^A-Za-z0-9_-]/g, "_");
        const filePath = path.join(persistDir, `${safeId}.txt`);
        fs.writeFileSync(filePath, c.content);
        replacement = persistedOutputPointer(filePath);
      } catch {
        // Persist failure → bare placeholder; clearing must never fail.
        replacement = CLEARED_TOOL_RESULT_PLACEHOLDER;
      }
    }
    replacements.set(`${c.messageIndex}:${c.blockIndex}`, replacement);
  }

  const next: ProviderMessage[] = messages.map((msg, m) => {
    let touched = false;
    const content = msg.content.map((block, b) => {
      const repl = replacements.get(`${m}:${b}`);
      if (repl === undefined || block.type !== "tool_result") return block;
      touched = true;
      return { ...block, content: repl };
    });
    return touched ? { ...msg, content } : msg;
  }) as ProviderMessage[];

  return {
    messages: next,
    tokensSaved,
    toolsCleared: candidates.length,
    toolsKept: all.length - candidates.length,
  };
}
