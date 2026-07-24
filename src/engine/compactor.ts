/**
 * Mechanical session compactor — originally derived from a reference implementation (since evolved independently);
 * continuation-message strings aligned byte-for-byte with Claude Code v2.1.198
 * (docs/48-compaction-design.md; docs/39-codex-parity-gap-analysis.md §11).
 *
 * Pure functions only. No side effects, no global state, no lane-event emission.
 * Token estimation: char.length / 4 + 1 (intentionally matches the reference estimator, NOT the M3b ratio).
 */

import type { ProviderMessage } from "../providers/index.js";

// ---------------------------------------------------------------------------
// String constants (byte-exact Claude Code v2.1.198)
// ---------------------------------------------------------------------------

const COMPACT_CONTINUATION_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const COMPACT_RECENT_MESSAGES_NOTE = "Recent messages are preserved verbatim.";
const COMPACT_TRANSCRIPT_NOTE_PREFIX =
  "If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ";
const COMPACT_DIRECT_RESUME_INSTRUCTION =
  'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';

/** Claude Code's error when a manual compact has nothing to summarize. */
export const NOT_ENOUGH_MESSAGES_TO_COMPACT = "Not enough messages to compact.";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  preserveRecentMessages: number;
  maxEstimatedTokens: number;
  /**
   * Absolute path of the session transcript (events.jsonl). When set, the
   * continuation message includes Claude Code's "read the full transcript
   * at: …" pointer so the model can recover pre-compaction details.
   */
  transcriptPath?: string;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  preserveRecentMessages: 4,
  maxEstimatedTokens: 10_000,
};

// ---------------------------------------------------------------------------
// Usage-token trigger thresholds (Claude Code v2.1.198)
//
// CC compacts on real API token counts, not estimates: auto-compact fires at
// contextWindow − 13k, a "context low" warning at threshold − 20k, and input
// is blocked at contextWindow − 3k. The char/4 estimator below remains as the
// fallback for providers that do not report usage (and for emergency sizing).
// ---------------------------------------------------------------------------

/** CC reserve: auto-compact when context tokens reach window − 13k. */
export const DEFAULT_COMPACT_RESERVE_TOKENS = 13_000;
/** CC warn margin: "Context low" at threshold − 20k. */
export const COMPACT_WARN_MARGIN_TOKENS = 20_000;
/** CC blocked margin: refuse new input at window − 3k. */
export const COMPACT_BLOCKED_RESERVE_TOKENS = 3_000;

/** Resolve the compact reserve, honouring OPENSWARM_COMPACT_RESERVE. */
export function compactReserveTokens(): number {
  const raw = process.env.OPENSWARM_COMPACT_RESERVE;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_COMPACT_RESERVE_TOKENS;
}

/**
 * The auto-compact threshold for a context window: window − reserve, floored
 * at half the window so tiny-context models keep a sane margin.
 */
export function autoCompactThreshold(contextWindow: number): number {
  return Math.max(
    Math.floor(contextWindow / 2),
    contextWindow - compactReserveTokens(),
  );
}

export type ContextUsageLevel = "ok" | "warn" | "compact" | "blocked";

export interface ContextUsageStatus {
  readonly level: ContextUsageLevel;
  readonly contextTokens: number;
  readonly threshold: number;
  /** Percent of usable window remaining (0–100), CC-style. */
  readonly pctLeft: number;
}

/**
 * Classify current context occupancy against the CC thresholds. `contextTokens`
 * is the real usage from the provider's last finish event (input + cache read
 * + cache write + output), i.e. the approximate size of the next request.
 */
export function contextUsageStatus(
  contextTokens: number,
  contextWindow: number,
): ContextUsageStatus {
  const threshold = autoCompactThreshold(contextWindow);
  const blocked = contextWindow - COMPACT_BLOCKED_RESERVE_TOKENS;
  const warn = threshold - COMPACT_WARN_MARGIN_TOKENS;
  const pctLeft = Math.max(
    0,
    Math.round(((threshold - contextTokens) / threshold) * 100),
  );
  if (contextTokens >= blocked) {
    return { level: "blocked", contextTokens, threshold, pctLeft };
  }
  if (contextTokens >= threshold) {
    return { level: "compact", contextTokens, threshold, pctLeft };
  }
  if (contextTokens >= warn) {
    return { level: "warn", contextTokens, threshold, pctLeft };
  }
  return { level: "ok", contextTokens, threshold, pctLeft };
}

export interface Session {
  readonly messages: readonly ProviderMessage[];
}

export interface CompactionResult {
  readonly summary: string;
  readonly compactedSession: Session;
  readonly removedMessageCount: number;
  readonly boundaryWalkedBack: boolean;
  /**
   * True when the model-based summarizer failed and the mechanical fallback
   * produced the summary. Feeds the consecutive-failure circuit breaker
   * (docs/48-compaction-design.md §L5). Absent on the mechanical path.
   */
  readonly summarizerFailed?: boolean;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Tokens-per-character used by the char-based estimator. The default is char/4
 * (the historical default) — the fallback before any real usage is available to calibrate
 * against. `calibrateTokensPerChar` derives a live ratio from the last turn's
 * real prompt-token count so estimates track the provider's tokenizer (CJK and
 * dense code trend well off 4 chars/token) without shipping one (docs/55 TE-24,
 * modeled on DeepSeek-Reasonix's tokPerChar). The bounds reject absurd ratios
 * (a truncated/garbled usage report) and keep the estimator conservative.
 */
export const DEFAULT_TOKENS_PER_CHAR = 0.25;
const MIN_TOKENS_PER_CHAR = 0.05;
const MAX_TOKENS_PER_CHAR = 2;

export function estimateTokens(
  msg: ProviderMessage,
  tokensPerChar: number = DEFAULT_TOKENS_PER_CHAR,
): number {
  // At the default 0.25, `len * 0.25` and `len / 4` floor identically, so an
  // uncalibrated call is byte-for-byte the prior char/4 behavior.
  let total = 0;
  for (const block of msg.content) {
    if (block.type === "text") {
      total += Math.floor(block.text.length * tokensPerChar) + 1;
    } else if (block.type === "tool_use") {
      const inputStr = JSON.stringify(block.input);
      total += Math.floor((block.name.length + inputStr.length) * tokensPerChar) + 1;
    } else if (block.type === "tool_result") {
      total +=
        Math.floor((block.tool_use_id.length + block.content.length) * tokensPerChar) + 1;
    } else if (block.type === "reasoning") {
      // The encrypted reasoning blob is real wire payload (often KBs) and is
      // replayed on the codex path — count it so compaction triggers on time.
      total += Math.floor(block.signature.length * tokensPerChar) + 1;
    }
  }
  return total;
}

/**
 * Characters of a message that ride to the provider — the same fields
 * `estimateTokens` divides. Shared with `calibrateTokensPerChar` so the
 * calibration denominator matches what the estimate later scales.
 */
export function messageChars(msg: ProviderMessage): number {
  let n = 0;
  for (const block of msg.content) {
    if (block.type === "text") {
      n += block.text.length;
    } else if (block.type === "tool_use") {
      n += block.name.length + JSON.stringify(block.input).length;
    } else if (block.type === "tool_result") {
      n += block.tool_use_id.length + block.content.length;
    } else if (block.type === "reasoning") {
      n += block.signature.length;
    }
  }
  return n;
}

/**
 * Derive a tokens-per-character ratio from a real prompt-token count and the
 * character count of the messages it covered. Returns the default when there
 * is no usable signal (no usage yet, empty coverage) or the ratio lands
 * outside the sane band — so a bad usage report can never distort sizing.
 *
 * The token count spans system prompt + tools + messages while the char count
 * covers only the messages, so the ratio slightly over-attributes prefix
 * overhead to message chars. That is the conservative direction (estimates a
 * touch high → compaction triggers marginally early) and matches Reasonix's
 * deliberately imprecise per-message ratio.
 */
export function calibrateTokensPerChar(
  contextTokens: number,
  messages: readonly ProviderMessage[],
  coveredCount: number,
): number {
  if (contextTokens <= 0) return DEFAULT_TOKENS_PER_CHAR;
  const covered = Math.min(coveredCount, messages.length);
  let chars = 0;
  for (let i = 0; i < covered; i++) {
    chars += messageChars(messages[i]!);
  }
  if (chars <= 0) return DEFAULT_TOKENS_PER_CHAR;
  const ratio = contextTokens / chars;
  if (ratio < MIN_TOKENS_PER_CHAR || ratio > MAX_TOKENS_PER_CHAR) {
    return DEFAULT_TOKENS_PER_CHAR;
  }
  return ratio;
}

export function estimateSessionTokens(session: Session): number {
  return session.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
}

// ---------------------------------------------------------------------------
// shouldCompact
// ---------------------------------------------------------------------------

export function shouldCompact(
  session: Session,
  config: CompactionConfig
): boolean {
  const start = compactedSummaryPrefixLen(session);
  const compactable = session.messages.slice(start);

  if (compactable.length <= config.preserveRecentMessages) {
    return false;
  }

  const totalTokens = compactable.reduce(
    (sum, msg) => sum + estimateTokens(msg),
    0
  );
  return totalTokens >= config.maxEstimatedTokens;
}

// ---------------------------------------------------------------------------
// compactSession — orchestration
// ---------------------------------------------------------------------------

export function compactSession(
  session: Session,
  config: CompactionConfig
): CompactionResult {
  if (!shouldCompact(session, config)) {
    return {
      summary: "",
      compactedSession: session,
      removedMessageCount: 0,
      boundaryWalkedBack: false,
    };
  }

  const existingSummary = extractExistingCompactedSummary(session.messages[0]);
  const compactedPrefixLen = existingSummary !== null ? 1 : 0;

  const rawKeepFrom = Math.max(
    0,
    session.messages.length - config.preserveRecentMessages
  );

  // Boundary walk-back: ensure we don't split a tool-use / tool-result pair.
  let keepFrom = rawKeepFrom;
  let boundaryWalkedBack = false;

  while (true) {
    if (keepFrom === 0 || keepFrom <= compactedPrefixLen) {
      break;
    }
    const firstPreserved = session.messages[keepFrom];
    const startsWithToolResult =
      firstPreserved !== undefined &&
      firstPreserved.role === "user" &&
      firstPreserved.content[0]?.type === "tool_result";

    if (!startsWithToolResult) {
      break;
    }

    // Check the message just before the current boundary.
    const preceding = session.messages[keepFrom - 1];
    const precedingHasToolUse =
      preceding !== undefined &&
      preceding.role === "assistant" &&
      preceding.content.some((b) => b.type === "tool_use");

    if (precedingHasToolUse) {
      // Pair is intact — walk back one to include the assistant turn.
      keepFrom = keepFrom - 1;
      boundaryWalkedBack = true;
      break;
    }

    // Orphan tool_result — walk back to try to fix it.
    keepFrom = keepFrom - 1;
    boundaryWalkedBack = true;
  }

  const removed = session.messages.slice(compactedPrefixLen, keepFrom);
  const preserved = session.messages.slice(keepFrom);

  const summary = withTodoProgress(
    mergeCompactSummaries(existingSummary, summarizeMessages(removed)),
    session.messages,
  );

  const continuation = getCompactContinuationMessage(
    summary,
    true,
    preserved.length > 0,
    config.transcriptPath,
  );

  // Claude Code ships the continuation as a *user* message (not system) so
  // providers that reorder or merge system messages cannot break it.
  const continuationMsg: ProviderMessage = {
    role: "user",
    content: [{ type: "text", text: continuation }],
  };

  const compactedMessages: ProviderMessage[] = [continuationMsg, ...preserved];

  return {
    summary,
    compactedSession: { messages: compactedMessages },
    removedMessageCount: removed.length,
    boundaryWalkedBack,
  };
}

// ---------------------------------------------------------------------------
// Todo-tree progress section (borrowed from MiMoCode checkpoint*)
//
// Compaction drops the message that carried the latest `todo_write` state, so
// the resumed session forgets its own plan. We recover the most recent todo
// snapshot from the pre-compaction history and fold a compact progress block
// into the summary so the checklist survives across the boundary. Purely
// structural — no dependency on the todo_write tool module.
// ---------------------------------------------------------------------------

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoProgressItem {
  readonly content: string;
  readonly status: TodoStatus;
}

const TODO_STATUS_ICON: Record<TodoStatus, string> = {
  pending: "☐",
  in_progress: "▶",
  completed: "✓",
};

const VALID_TODO_STATUS = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

/**
 * Return the most recent `todo_write` snapshot found in `messages` (scanning
 * newest-first), or null when there is none. Defensive about shape — the tool
 * input is untyped `unknown` on the wire.
 */
export function extractLatestTodos(
  messages: readonly ProviderMessage[],
): TodoProgressItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== "assistant") continue;
    for (let b = msg.content.length - 1; b >= 0; b--) {
      const block = msg.content[b];
      if (block?.type !== "tool_use" || block.name !== "todo_write") continue;
      const items = coerceTodos(block.input);
      if (items !== null) return items;
    }
  }
  return null;
}

function coerceTodos(input: unknown): TodoProgressItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const items: TodoProgressItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const content = (entry as { content?: unknown }).content;
    const status = (entry as { status?: unknown }).status;
    if (typeof content !== "string") continue;
    if (typeof status !== "string" || !VALID_TODO_STATUS.has(status as TodoStatus)) {
      continue;
    }
    items.push({ content, status: status as TodoStatus });
  }
  return items.length > 0 ? items : null;
}

/** Render a `## Todos / Progress` markdown block from a todo snapshot. */
export function renderTodoProgressBlock(
  todos: readonly TodoProgressItem[],
): string {
  const done = todos.filter((t) => t.status === "completed").length;
  const lines = [`## Todos / Progress (${done}/${todos.length} done)`];
  for (const t of todos) {
    lines.push(`- ${TODO_STATUS_ICON[t.status]} ${t.status}: ${t.content}`);
  }
  return lines.join("\n");
}

/**
 * Fold the latest todo snapshot into a summary string. Inserts the progress
 * block just before the trailing `</summary>` tag when present (so it stays
 * inside the summary envelope that formatCompactSummary/merge understand),
 * else appends. No-op when there are no todos.
 */
export function withTodoProgress(
  summary: string,
  messages: readonly ProviderMessage[],
): string {
  const todos = extractLatestTodos(messages);
  if (todos === null) return summary;
  const block = renderTodoProgressBlock(todos);
  const closeIdx = summary.lastIndexOf("</summary>");
  if (closeIdx !== -1) {
    return `${summary.slice(0, closeIdx)}${block}\n${summary.slice(closeIdx)}`;
  }
  return `${summary}\n\n${block}`;
}

// ---------------------------------------------------------------------------
// compactedSummaryPrefixLen
// ---------------------------------------------------------------------------

export function compactedSummaryPrefixLen(session: Session): number {
  return extractExistingCompactedSummary(session.messages[0]) !== null ? 1 : 0;
}

// ---------------------------------------------------------------------------
// summarizeMessages
// ---------------------------------------------------------------------------

export function summarizeMessages(
  messages: readonly ProviderMessage[]
): string {
  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter(
    (m) => m.role === "assistant"
  ).length;
  // The reference implementation has a "tool" role; in our ProviderMessage shape tool results are user
  // messages — count them separately as tool_result turns
  const toolMessages = messages.filter(
    (m) =>
      m.role === "user" && m.content[0]?.type === "tool_result"
  ).length;

  // Collect tool names from tool_use blocks (assistant messages) — dedup preserving sort order
  const toolNamesRaw: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          toolNamesRaw.push(block.name);
        }
      }
    }
  }
  // sort + dedup (removes consecutive duplicates after sorting)
  const toolNamesSorted = [...toolNamesRaw].sort();
  const toolNames = toolNamesSorted.filter(
    (name, i) => i === 0 || toolNamesSorted[i - 1] !== name
  );

  const lines: string[] = [
    "<summary>",
    "Conversation summary:",
    `- Scope: ${messages.length} earlier messages compacted (user=${userMessages}, assistant=${assistantMessages}, tool=${toolMessages}).`,
  ];

  if (toolNames.length > 0) {
    lines.push(`- Tools mentioned: ${toolNames.join(", ")}.`);
  }

  const recentUserRequests = collectRecentRoleSummaries(messages, "user", 3);
  if (recentUserRequests.length > 0) {
    lines.push("- Recent user requests:");
    for (const req of recentUserRequests) {
      lines.push(`  - ${req}`);
    }
  }

  const pendingWork = inferPendingWork(messages);
  if (pendingWork.length > 0) {
    lines.push("- Pending work:");
    for (const item of pendingWork) {
      lines.push(`  - ${item}`);
    }
  }

  const keyFiles = collectKeyFiles(messages);
  if (keyFiles.length > 0) {
    lines.push(`- Key files referenced: ${keyFiles.join(", ")}.`);
  }

  const currentWork = inferCurrentWork(messages);
  if (currentWork !== null) {
    lines.push(`- Current work: ${currentWork}`);
  }

  lines.push("- Key timeline:");
  for (const msg of messages) {
    const role = msg.role;
    const content = msg.content
      .map((block) => summarizeBlock(block))
      .join(" | ");
    lines.push(`  - ${role}: ${content}`);
  }

  lines.push("</summary>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// mergeCompactSummaries
// ---------------------------------------------------------------------------

export function mergeCompactSummaries(
  existing: string | null,
  newSummary: string
): string {
  if (existing === null) {
    return newSummary;
  }

  const previousHighlights = extractSummaryHighlights(existing);
  const newFormattedSummary = formatCompactSummary(newSummary);
  const newHighlights = extractSummaryHighlights(newFormattedSummary);
  const newTimeline = extractSummaryTimeline(newFormattedSummary);

  const lines: string[] = ["<summary>", "Conversation summary:"];

  if (previousHighlights.length > 0) {
    lines.push("- Previously compacted context:");
    for (const line of previousHighlights) {
      lines.push(`  ${line}`);
    }
  }

  if (newHighlights.length > 0) {
    lines.push("- Newly compacted context:");
    for (const line of newHighlights) {
      lines.push(`  ${line}`);
    }
  }

  if (newTimeline.length > 0) {
    lines.push("- Key timeline:");
    for (const line of newTimeline) {
      lines.push(`  ${line}`);
    }
  }

  lines.push("</summary>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// extractExistingCompactedSummary
// ---------------------------------------------------------------------------

export function extractExistingCompactedSummary(
  message: ProviderMessage | undefined
): string | null {
  // Continuation messages are user-role (Claude Code shape); accept the old
  // system-role form too so pre-migration snapshots keep resuming cleanly.
  if (
    message === undefined ||
    (message.role !== "user" && message.role !== "system")
  ) {
    return null;
  }

  const text = firstTextBlock(message);
  if (text === null) {
    return null;
  }

  if (!text.startsWith(COMPACT_CONTINUATION_PREAMBLE)) {
    return null;
  }

  let summary = text.slice(COMPACT_CONTINUATION_PREAMBLE.length);

  const transcriptMarker = `\n\n${COMPACT_TRANSCRIPT_NOTE_PREFIX}`;
  const transcriptIdx = summary.indexOf(transcriptMarker);
  if (transcriptIdx !== -1) {
    summary = summary.slice(0, transcriptIdx);
  }

  const recentNoteMarker = `\n\n${COMPACT_RECENT_MESSAGES_NOTE}`;
  const recentNoteIdx = summary.indexOf(recentNoteMarker);
  if (recentNoteIdx !== -1) {
    summary = summary.slice(0, recentNoteIdx);
  }

  const resumeMarker = `\n${COMPACT_DIRECT_RESUME_INSTRUCTION}`;
  const resumeIdx = summary.indexOf(resumeMarker);
  if (resumeIdx !== -1) {
    summary = summary.slice(0, resumeIdx);
  }

  return summary.trim();
}

// ---------------------------------------------------------------------------
// formatCompactSummary
// ---------------------------------------------------------------------------

export function formatCompactSummary(summary: string): string {
  const withoutAnalysis = stripTagBlock(summary, "analysis");
  const summaryContent = extractTagBlock(withoutAnalysis, "summary");

  let formatted: string;
  if (summaryContent !== null) {
    formatted = withoutAnalysis.replace(
      `<summary>${summaryContent}</summary>`,
      `Summary:\n${summaryContent.trim()}`
    );
  } else {
    formatted = withoutAnalysis;
  }

  return collapseBlankLines(formatted).trim();
}

// ---------------------------------------------------------------------------
// getCompactContinuationMessage
// ---------------------------------------------------------------------------

export function getCompactContinuationMessage(
  summary: string,
  suppressFollowUpQuestions: boolean,
  recentMessagesPreserved: boolean,
  transcriptPath?: string,
): string {
  let base = `${COMPACT_CONTINUATION_PREAMBLE}${formatCompactSummary(summary)}`;

  // Claude Code order: transcript pointer, recent-preserved note, resume
  // instruction (auto-compact only — manual /compact omits it).
  if (transcriptPath !== undefined && transcriptPath !== "") {
    base += `\n\n${COMPACT_TRANSCRIPT_NOTE_PREFIX}${transcriptPath}`;
  }

  if (recentMessagesPreserved) {
    base += `\n\n${COMPACT_RECENT_MESSAGES_NOTE}`;
  }

  if (suppressFollowUpQuestions) {
    base += `\n${COMPACT_DIRECT_RESUME_INSTRUCTION}`;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

type AnyBlock = ProviderMessage["content"][number];

function summarizeBlock(block: AnyBlock): string {
  let raw: string;
  if (block.type === "text") {
    raw = block.text;
  } else if (block.type === "tool_use") {
    const inputStr = JSON.stringify(block.input);
    raw = `tool_use ${block.name}(${inputStr})`;
  } else if (block.type === "reasoning") {
    raw = "reasoning"; // opaque encrypted blob — nothing to summarize
  } else {
    // tool_result
    const errPrefix = block.is_error === true ? "error " : "";
    raw = `tool_result ${block.tool_use_id}: ${errPrefix}${block.content}`;
  }
  return truncateSummary(raw, 160);
}

function firstTextBlock(message: ProviderMessage): string | null {
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim() !== "") {
      return block.text;
    }
  }
  return null;
}

function collectRecentRoleSummaries(
  messages: readonly ProviderMessage[],
  role: "user" | "assistant",
  limit: number
): string[] {
  const results: string[] = [];
  for (let i = messages.length - 1; i >= 0 && results.length < limit; i--) {
    const msg = messages[i];
    if (msg.role !== role) continue;
    const text = firstTextBlock(msg);
    if (text !== null) {
      results.push(truncateSummary(text, 160));
    }
  }
  return results.reverse();
}

function inferPendingWork(messages: readonly ProviderMessage[]): string[] {
  const results: string[] = [];
  for (let i = messages.length - 1; i >= 0 && results.length < 3; i--) {
    const text = firstTextBlock(messages[i]);
    if (text === null) continue;
    const lowered = text.toLowerCase();
    if (
      lowered.includes("todo") ||
      lowered.includes("next") ||
      lowered.includes("pending") ||
      lowered.includes("follow up") ||
      lowered.includes("remaining")
    ) {
      results.push(truncateSummary(text, 160));
    }
  }
  return results.reverse();
}

function collectKeyFiles(messages: readonly ProviderMessage[]): string[] {
  const files: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      let textContent: string;
      if (block.type === "text") {
        textContent = block.text;
      } else if (block.type === "tool_use") {
        textContent = JSON.stringify(block.input);
      } else if (block.type === "reasoning") {
        textContent = ""; // opaque — no file candidates
      } else {
        textContent = block.content;
      }
      files.push(...extractFileCandidates(textContent));
    }
  }
  files.sort();
  const deduped = files.filter((f, i) => i === 0 || files[i - 1] !== f);
  return deduped.slice(0, 8);
}

function inferCurrentWork(messages: readonly ProviderMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = firstTextBlock(messages[i]);
    if (text !== null && text.trim() !== "") {
      return truncateSummary(text, 200);
    }
  }
  return null;
}

function hasInterestingExtension(candidate: string): boolean {
  const dot = candidate.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = candidate.slice(dot + 1).toLowerCase();
  return ["rs", "ts", "tsx", "js", "json", "md"].includes(ext);
}

function extractFileCandidates(content: string): string[] {
  const results: string[] = [];
  for (const token of content.split(/\s+/)) {
    const candidate = token.replace(/^[,.:;)('"` ]+|[,.:;)('"` ]+$/g, "");
    if (candidate.includes("/") && hasInterestingExtension(candidate)) {
      results.push(candidate);
    }
  }
  return results;
}

function truncateSummary(content: string, maxChars: number): string {
  const chars = [...content];
  if (chars.length <= maxChars) {
    return content;
  }
  return chars.slice(0, maxChars).join("") + "…";
}

function extractTagBlock(content: string, tag: string): string | null {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const startIdx = content.indexOf(startTag);
  if (startIdx === -1) return null;
  const afterStart = startIdx + startTag.length;
  const endIdx = content.indexOf(endTag, afterStart);
  if (endIdx === -1) return null;
  return content.slice(afterStart, endIdx);
}

function stripTagBlock(content: string, tag: string): string {
  const startTag = `<${tag}>`;
  const endTag = `</${tag}>`;
  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);
  if (startIdx === -1 || endIdx === -1) {
    return content;
  }
  return content.slice(0, startIdx) + content.slice(endIdx + endTag.length);
}

function collapseBlankLines(content: string): string {
  let result = "";
  let lastBlank = false;
  for (const line of content.split("\n")) {
    const isBlank = line.trim() === "";
    if (isBlank && lastBlank) {
      continue;
    }
    result += line + "\n";
    lastBlank = isBlank;
  }
  return result;
}

function extractSummaryHighlights(summary: string): string[] {
  const lines: string[] = [];
  let inTimeline = false;

  for (const line of formatCompactSummary(summary).split("\n")) {
    const trimmed = line.trimEnd();
    if (
      trimmed === "" ||
      trimmed === "Summary:" ||
      trimmed === "Conversation summary:"
    ) {
      continue;
    }
    if (trimmed === "- Key timeline:") {
      inTimeline = true;
      continue;
    }
    if (inTimeline) {
      continue;
    }
    lines.push(trimmed);
  }

  return lines;
}

function extractSummaryTimeline(summary: string): string[] {
  const lines: string[] = [];
  let inTimeline = false;

  for (const line of formatCompactSummary(summary).split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed === "- Key timeline:") {
      inTimeline = true;
      continue;
    }
    if (!inTimeline) {
      continue;
    }
    if (trimmed === "") {
      break;
    }
    lines.push(trimmed);
  }

  return lines;
}
