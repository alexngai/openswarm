/**
 * Remote (model-based) session compactor — modeled on Codex compact_remote.rs
 * and compact_remote_v2.rs.
 *
 * Sends the conversation history to an LLM and asks it to produce a structured
 * summary. Falls back to mechanical compaction on error/timeout. Reuses the
 * same boundary walk-back and continuation message infrastructure from
 * compactor.ts.
 */

import type { Provider, ProviderMessage } from "../providers/index.js";
import {
  type CompactionConfig,
  type CompactionResult,
  type Session,
  compactedSummaryPrefixLen,
  extractExistingCompactedSummary,
  getCompactContinuationMessage,
  mergeCompactSummaries,
  summarizeMessages,
  shouldCompact,
} from "./compactor.js";

// ---------------------------------------------------------------------------
// Remote compaction config
// ---------------------------------------------------------------------------

export interface RemoteCompactionConfig extends CompactionConfig {
  /** Provider to use for summarization. Can differ from the main session provider. */
  provider: Provider;
  /** Model to use for summarization (e.g. "gpt-4o-mini", "claude-haiku-4-5-20251001"). */
  model: string;
  /** Timeout in ms for the summarization call. Default: 30_000 (30s). */
  timeoutMs?: number;
  /** Max output tokens for the summary. Default: 2048. */
  maxSummaryTokens?: number;
  /** Custom system prompt override. Uses default Codex-style prompt when absent. */
  systemPrompt?: string;
}

export function isRemoteCompactionConfig(
  config: CompactionConfig,
): config is RemoteCompactionConfig {
  return "provider" in config && "model" in config;
}

// ---------------------------------------------------------------------------
// System prompt — modeled on Codex compact_remote_v2.rs
// ---------------------------------------------------------------------------

const REMOTE_COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Your job is to condense a conversation between a user and an AI assistant into a structured summary that preserves all information needed to continue the conversation seamlessly.

## Instructions

1. Read the full conversation carefully.
2. Produce output in EXACTLY this format:

<analysis>
Brief notes on what matters most for continuing this conversation.
</analysis>

<summary>
## Primary Request and Intent
What the user is ultimately trying to accomplish.

## Key Technical Concepts
Important technical details, patterns, constraints, or decisions that were established.

## Files and Code Sections
List of significant files discussed or modified, with brief notes on what was done to each.

## Errors and Fixes
Any errors encountered, their root causes, and how they were resolved.

## Problem Solving
Key problem-solving approaches and decisions made.

## All User Messages
Paraphrased list of all user messages in order.

## Pending Tasks
Unfinished work, next steps, or things the user asked for that haven't been done yet.

## Current Work
What was being actively worked on when the conversation ended.

## Optional Next Step
If there's an obvious single next action to take, state it here. Otherwise omit this section.
</summary>

## Rules

- Be comprehensive but concise — the summary must be shorter than the original conversation.
- Preserve exact file paths, function names, variable names, error messages, and code snippets that would be needed to continue the work.
- Preserve the user's stated preferences, constraints, and requirements verbatim.
- Do NOT fabricate information that wasn't in the conversation.
- Do NOT include your own opinions or suggestions beyond what was discussed.
- Focus on WHAT was done/decided and WHY, not play-by-play narration.`;

// ---------------------------------------------------------------------------
// Remote compaction entry point
// ---------------------------------------------------------------------------

export async function compactSessionRemote(
  session: Session,
  config: RemoteCompactionConfig,
  abort?: AbortSignal,
): Promise<CompactionResult> {
  const effectiveConfig: CompactionConfig = {
    preserveRecentMessages: config.preserveRecentMessages,
    maxEstimatedTokens: config.maxEstimatedTokens,
  };

  if (!shouldCompact(session, effectiveConfig)) {
    return {
      summary: "",
      compactedSession: session,
      removedMessageCount: 0,
      boundaryWalkedBack: false,
    };
  }

  const existingSummary = extractExistingCompactedSummary(session.messages[0]);
  const compactedPrefixLen = existingSummary !== null ? 1 : 0;

  // Boundary walk-back — same logic as mechanical compactor
  const { keepFrom, boundaryWalkedBack } = walkBackBoundary(
    session.messages,
    config.preserveRecentMessages,
    compactedPrefixLen,
  );

  const removed = session.messages.slice(compactedPrefixLen, keepFrom);
  const preserved = session.messages.slice(keepFrom);

  // Attempt remote summarization with timeout + fallback
  let summary: string;
  try {
    const remoteSummary = await summarizeRemote(
      removed,
      existingSummary,
      config,
      abort,
    );
    summary = mergeCompactSummaries(existingSummary, remoteSummary);
  } catch {
    // Fail-safe: fall back to mechanical summarization
    summary = mergeCompactSummaries(existingSummary, summarizeMessages(removed));
  }

  const continuation = getCompactContinuationMessage(
    summary,
    true,
    preserved.length > 0,
  );

  const systemMsg: ProviderMessage = {
    role: "system",
    content: [{ type: "text", text: continuation }],
  };

  return {
    summary,
    compactedSession: { messages: [systemMsg, ...preserved] },
    removedMessageCount: removed.length,
    boundaryWalkedBack,
  };
}

// ---------------------------------------------------------------------------
// Core summarization call
// ---------------------------------------------------------------------------

async function summarizeRemote(
  messages: readonly ProviderMessage[],
  existingSummary: string | null,
  config: RemoteCompactionConfig,
  abort?: AbortSignal,
): Promise<string> {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxTokens = config.maxSummaryTokens ?? 2048;
  const systemPrompt = config.systemPrompt ?? REMOTE_COMPACTION_SYSTEM_PROMPT;

  // Build the user message containing the conversation to summarize
  const conversationText = formatConversationForSummary(messages, existingSummary);

  const userMessage: ProviderMessage = {
    role: "user",
    content: [{ type: "text", text: conversationText }],
  };

  // Create timeout abort
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  // Combine external abort with timeout
  const combinedAbort = abort
    ? combineAbortSignals(abort, timeoutController.signal)
    : timeoutController.signal;

  try {
    let responseText = "";

    for await (const event of config.provider.stream({
      messages: [userMessage],
      systemPrompt,
      model: config.model,
      maxOutputTokens: maxTokens,
      abort: combinedAbort,
      tools: [],
    })) {
      if (event.type === "text-delta") {
        responseText += event.text;
      } else if (event.type === "error") {
        throw new Error(`Provider error: ${event.message}`);
      }
    }

    return extractSummaryFromResponse(responseText);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Conversation formatting
// ---------------------------------------------------------------------------

function formatConversationForSummary(
  messages: readonly ProviderMessage[],
  existingSummary: string | null,
): string {
  const parts: string[] = [];

  if (existingSummary !== null) {
    parts.push("## Previously Compacted Context\n");
    parts.push(existingSummary);
    parts.push("\n\n## New Conversation to Summarize\n");
  } else {
    parts.push("## Conversation to Summarize\n");
  }

  for (const msg of messages) {
    const role = msg.role.toUpperCase();
    const blocks = msg.content.map(formatBlock).join("\n");
    parts.push(`\n### ${role}\n${blocks}`);
  }

  return parts.join("\n");
}

function formatBlock(block: ProviderMessage["content"][number]): string {
  if (block.type === "text") {
    return block.text;
  } else if (block.type === "tool_use") {
    const inputStr = JSON.stringify(block.input, null, 2);
    if (inputStr.length > 500) {
      return `[Tool call: ${block.name}(${inputStr.slice(0, 500)}...)]`;
    }
    return `[Tool call: ${block.name}(${inputStr})]`;
  } else if (block.type === "reasoning") {
    return "[Reasoning]";
  } else {
    // tool_result
    const content = block.content;
    const prefix = block.is_error ? "[Tool error" : "[Tool result";
    if (content.length > 500) {
      return `${prefix}: ${content.slice(0, 500)}...]`;
    }
    return `${prefix}: ${content}]`;
  }
}

// ---------------------------------------------------------------------------
// Response parsing — extract <summary> block from LLM response
// ---------------------------------------------------------------------------

function extractSummaryFromResponse(response: string): string {
  // Try to extract the <summary>...</summary> block
  const summaryStart = response.indexOf("<summary>");
  const summaryEnd = response.indexOf("</summary>");

  if (summaryStart !== -1 && summaryEnd !== -1) {
    return response.slice(summaryStart, summaryEnd + "</summary>".length);
  }

  // If no tags found, use the whole response wrapped in tags
  return `<summary>\n${response.trim()}\n</summary>`;
}

// ---------------------------------------------------------------------------
// Boundary walk-back (shared with mechanical compactor)
// ---------------------------------------------------------------------------

interface WalkBackResult {
  keepFrom: number;
  boundaryWalkedBack: boolean;
}

function walkBackBoundary(
  messages: readonly ProviderMessage[],
  preserveRecentMessages: number,
  compactedPrefixLen: number,
): WalkBackResult {
  const rawKeepFrom = Math.max(0, messages.length - preserveRecentMessages);
  let keepFrom = rawKeepFrom;
  let boundaryWalkedBack = false;

  while (true) {
    if (keepFrom === 0 || keepFrom <= compactedPrefixLen) {
      break;
    }
    const firstPreserved = messages[keepFrom];
    const startsWithToolResult =
      firstPreserved !== undefined &&
      firstPreserved.role === "user" &&
      firstPreserved.content[0]?.type === "tool_result";

    if (!startsWithToolResult) {
      break;
    }

    const preceding = messages[keepFrom - 1];
    const precedingHasToolUse =
      preceding !== undefined &&
      preceding.role === "assistant" &&
      preceding.content.some((b) => b.type === "tool_use");

    if (precedingHasToolUse) {
      keepFrom = keepFrom - 1;
      boundaryWalkedBack = true;
      break;
    }

    keepFrom = keepFrom - 1;
    boundaryWalkedBack = true;
  }

  return { keepFrom, boundaryWalkedBack };
}

// ---------------------------------------------------------------------------
// Abort signal utilities
// ---------------------------------------------------------------------------

function combineAbortSignals(
  ...signals: AbortSignal[]
): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener(
      "abort",
      () => controller.abort(signal.reason),
      { once: true },
    );
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// Export the system prompt for testing / customization
// ---------------------------------------------------------------------------

export { REMOTE_COMPACTION_SYSTEM_PROMPT };
