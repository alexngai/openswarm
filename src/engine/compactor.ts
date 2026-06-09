/**
 * Mechanical session compactor — ported from claw-code compact.rs (L1–L553).
 *
 * Pure functions only. No side effects, no global state, no lane-event emission.
 * Token estimation: char.length / 4 + 1 (intentionally matches claw, NOT M3b ratio).
 */

import type { ProviderMessage } from "../providers/index.js";

// ---------------------------------------------------------------------------
// String constants (verbatim from claw compact.rs L3–L6)
// ---------------------------------------------------------------------------

const COMPACT_CONTINUATION_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n";
const COMPACT_RECENT_MESSAGES_NOTE = "Recent messages are preserved verbatim.";
const COMPACT_DIRECT_RESUME_INSTRUCTION =
  "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  preserveRecentMessages: number;
  maxEstimatedTokens: number;
}

export const DEFAULT_COMPACTION: CompactionConfig = {
  preserveRecentMessages: 4,
  maxEstimatedTokens: 10_000,
};

export interface Session {
  readonly messages: readonly ProviderMessage[];
}

export interface CompactionResult {
  readonly summary: string;
  readonly compactedSession: Session;
  readonly removedMessageCount: number;
  readonly boundaryWalkedBack: boolean;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

export function estimateTokens(msg: ProviderMessage): number {
  let total = 0;
  for (const block of msg.content) {
    if (block.type === "text") {
      total += Math.floor(block.text.length / 4) + 1;
    } else if (block.type === "tool_use") {
      const inputStr = JSON.stringify(block.input);
      total += Math.floor((block.name.length + inputStr.length) / 4) + 1;
    } else if (block.type === "tool_result") {
      total +=
        Math.floor((block.tool_use_id.length + block.content.length) / 4) + 1;
    } else if (block.type === "reasoning") {
      // The encrypted reasoning blob is real wire payload (often KBs) and is
      // replayed on the codex path — count it so compaction triggers on time.
      total += Math.floor(block.signature.length / 4) + 1;
    }
  }
  return total;
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
// compactSession — orchestration (claw compact.rs L96–L183)
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
  // Port of claw compact.rs L121–L158.
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

  const summary = mergeCompactSummaries(
    existingSummary,
    summarizeMessages(removed)
  );

  const continuation = getCompactContinuationMessage(
    summary,
    true,
    preserved.length > 0
  );

  const systemMsg: ProviderMessage = {
    role: "system",
    content: [{ type: "text", text: continuation }],
  };

  const compactedMessages: ProviderMessage[] = [systemMsg, ...preserved];

  return {
    summary,
    compactedSession: { messages: compactedMessages },
    removedMessageCount: removed.length,
    boundaryWalkedBack,
  };
}

// ---------------------------------------------------------------------------
// compactedSummaryPrefixLen (claw L185–L193)
// ---------------------------------------------------------------------------

export function compactedSummaryPrefixLen(session: Session): number {
  return extractExistingCompactedSummary(session.messages[0]) !== null ? 1 : 0;
}

// ---------------------------------------------------------------------------
// summarizeMessages (claw L195–L280)
// ---------------------------------------------------------------------------

export function summarizeMessages(
  messages: readonly ProviderMessage[]
): string {
  const userMessages = messages.filter((m) => m.role === "user").length;
  const assistantMessages = messages.filter(
    (m) => m.role === "assistant"
  ).length;
  // claw has a "tool" role; in our ProviderMessage shape tool results are user
  // messages — count them separately as tool_result turns
  const toolMessages = messages.filter(
    (m) =>
      m.role === "user" && m.content[0]?.type === "tool_result"
  ).length;

  // Collect tool names from tool_use blocks (assistant messages) — dedup preserving sort order (claw sorts)
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
  // claw: sort_unstable + dedup (dedup after sort removes consecutive dupes)
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
// mergeCompactSummaries (claw L282–L315)
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
// extractExistingCompactedSummary (claw L494–L508)
// ---------------------------------------------------------------------------

export function extractExistingCompactedSummary(
  message: ProviderMessage | undefined
): string | null {
  if (message === undefined || message.role !== "system") {
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
// formatCompactSummary (claw L54–L67)
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
// getCompactContinuationMessage (claw L70–L92)
// ---------------------------------------------------------------------------

export function getCompactContinuationMessage(
  summary: string,
  suppressFollowUpQuestions: boolean,
  recentMessagesPreserved: boolean
): string {
  let base = `${COMPACT_CONTINUATION_PREAMBLE}${formatCompactSummary(summary)}`;

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
