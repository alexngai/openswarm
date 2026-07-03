/**
 * In-session (model-based) session compactor — Claude Code v2.1.198 mechanism
 * (docs/48-compaction-design.md §L3–L4).
 *
 * Summarization: appends the byte-exact Claude Code summary request as a user
 * message to the LIVE conversation and runs one no-tools turn against the
 * session's provider. The model sees the full-fidelity history it has been
 * working with — nothing re-serialized, nothing truncated — and prompt caching
 * covers the shared prefix.
 *
 * Rebuild (full path): NO verbatim message tail. The compacted history is
 * `[continuation user message, …re-injected attachments, …held-out pending
 * prompt]` — CC's shape. Working state survives via attachments (recently
 * read files, todo snapshot; see compact-rebuild.ts).
 *
 * Reactive path (context_overflow recovery, hardened engine): CC's group
 * compaction — newest user-turn groups are preserved verbatim within a
 * token budget, older groups are summarized with the RECENT-portion prompt.
 *
 * Safety valves (L5):
 *  - prompt-too-long: retry up to 3× dropping the oldest half of the history,
 *    marked with `[earlier conversation truncated for compaction retry]`.
 *  - tool-call rejection: a summarizer response containing tool calls is a
 *    failed attempt (the request carries CC's no-tools guard).
 *  - section validation + one corrective retry (openswarm extension).
 *  - mechanical fallback on any terminal failure (openswarm extension).
 */

import type { Provider, ProviderMessage } from "../providers/index.js";
import {
  type CompactionConfig,
  type CompactionResult,
  type Session,
  extractExistingCompactedSummary,
  getCompactContinuationMessage,
  mergeCompactSummaries,
  summarizeMessages,
  shouldCompact,
  estimateTokens,
  autoCompactThreshold,
} from "./compactor.js";
import {
  buildCompactSummaryRequest,
  buildRecentCompactSummaryRequest,
} from "./compact-prompts.js";
import {
  buildPostCompactAttachments,
  type RecontextualizeFn,
} from "./compact-rebuild.js";

// ---------------------------------------------------------------------------
// Remote compaction config
// ---------------------------------------------------------------------------

export interface RemoteCompactionConfig extends CompactionConfig {
  /** Provider to use for summarization. Can differ from the main session provider. */
  provider: Provider;
  /** Model to use for summarization (e.g. "gpt-5.5", "claude-sonnet-4-6"). */
  model: string;
  /** Timeout in ms for one summarization attempt. Default: 120_000 (2 min). */
  timeoutMs?: number;
  /** Max output tokens for the summary. Default: 8192. */
  maxSummaryTokens?: number;
  /** System prompt for the summarization turn. Defaults to empty. */
  systemPrompt?: string;
}

export function isRemoteCompactionConfig(
  config: CompactionConfig,
): config is RemoteCompactionConfig {
  return "provider" in config && "model" in config;
}

/** Per-invocation options for compactSessionRemote. */
export interface CompactOptions {
  /**
   * Compact even when the estimator trigger has not fired. Engines pass this
   * when the usage-token trigger (L1) has already decided — the char/4
   * estimator systematically underestimates and must not veto.
   */
  readonly force?: boolean;
  /** "auto" (default) appends CC's resume instruction; "manual" omits it. */
  readonly trigger?: "auto" | "manual";
  /** /compact <text> — forwarded as CC "Additional Instructions". */
  readonly customInstructions?: string;
  /** Skip attachment re-injection (tests / reactive path). */
  readonly skipAttachments?: boolean;
  /**
   * F1 hook: returns extra attachments (project instructions) to re-inject
   * after compaction, placed right after the continuation message.
   */
  readonly recontextualize?: RecontextualizeFn;
}

// ---------------------------------------------------------------------------
// Summary section validation
// ---------------------------------------------------------------------------

/**
 * Required sections a conforming summary must contain — the Claude Code
 * v2.1.198 nine-section shape (numbered `N. <name>:` in the prompt example).
 * "Optional Next Step" is intentionally excluded — the prompt marks it
 * optional.
 */
export const REQUIRED_SUMMARY_SECTIONS: readonly string[] = [
  "Primary Request and Intent",
  "Key Technical Concepts",
  "Files and Code Sections",
  "Errors and fixes",
  "Problem Solving",
  "All user messages",
  "Pending Tasks",
  "Current Work",
];

/**
 * Returns the required sections missing from a summary. Matches either the
 * numbered `N. <section>` form Claude Code's prompt demonstrates or a
 * markdown `#`-heading form, case-insensitively.
 */
export function missingSummarySections(summary: string): string[] {
  return REQUIRED_SUMMARY_SECTIONS.filter((section) => {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const marker = new RegExp(
      `(?:^|\\n)\\s*(?:\\d+\\.\\s*|#{1,4}\\s*)${escaped}`,
      "i",
    );
    return !marker.test(summary);
  });
}

/** Thrown when a remote summary still lacks required sections after a retry. */
export class RemoteSummaryValidationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Remote summary missing required sections: ${missing.join(", ")}`);
    this.name = "RemoteSummaryValidationError";
  }
}

/** Claude Code marker inserted where history was cut for a compaction retry. */
export const COMPACT_TRUNCATION_MARKER =
  "[earlier conversation truncated for compaction retry]";

/** Max prompt-too-long shrink retries for the summarization call (CC: 3). */
export const MAX_PTL_RETRIES = 3;

/** Internal sentinel: the summarization request itself overflowed context. */
class PromptTooLongError extends Error {
  constructor() {
    super("summarization prompt too long");
    this.name = "PromptTooLongError";
  }
}

/** Internal sentinel: the summarizer called tools despite the guard. */
class ToolCallInSummaryError extends Error {
  constructor() {
    super("summarizer attempted a tool call");
    this.name = "ToolCallInSummaryError";
  }
}

// ---------------------------------------------------------------------------
// Full-path compaction entry point
// ---------------------------------------------------------------------------

export async function compactSessionRemote(
  session: Session,
  config: RemoteCompactionConfig,
  abort?: AbortSignal,
  opts?: CompactOptions,
): Promise<CompactionResult> {
  const effectiveConfig: CompactionConfig = {
    preserveRecentMessages: config.preserveRecentMessages,
    maxEstimatedTokens: config.maxEstimatedTokens,
  };

  if (opts?.force !== true && !shouldCompact(session, effectiveConfig)) {
    return {
      summary: "",
      compactedSession: session,
      removedMessageCount: 0,
      boundaryWalkedBack: false,
      summarizerFailed: false,
    };
  }

  // Hold out a trailing plain-user prompt (the message the engine just
  // seeded, not yet answered) so the active request survives the boundary —
  // CC compacts before appending the pending prompt; we compact just after.
  const last = session.messages[session.messages.length - 1];
  const holdOutPending =
    last !== undefined &&
    last.role === "user" &&
    last.content.every((b) => b.type === "text") &&
    !isContinuationMessage(last);
  const toSummarize = holdOutPending
    ? session.messages.slice(0, -1)
    : session.messages;
  const heldOut = holdOutPending ? [last!] : [];

  if (toSummarize.length === 0) {
    return {
      summary: "",
      compactedSession: session,
      removedMessageCount: 0,
      boundaryWalkedBack: false,
      summarizerFailed: false,
    };
  }

  // In-session summarization over the FULL history (including any prior
  // continuation message — the model folds it into the fresh summary, so no
  // mechanical merging is needed on this path).
  let summary: string;
  let summarizerFailed = false;
  try {
    summary = await summarizeInSession(toSummarize, config, opts, abort);
  } catch {
    // Fail-safe: mechanical summarization (openswarm extension — headless
    // multi-agent runs must not die on a failed summarization call).
    summarizerFailed = true;
    const existingSummary = extractExistingCompactedSummary(toSummarize[0]);
    const removedForFallback = toSummarize.slice(existingSummary !== null ? 1 : 0);
    summary = mergeCompactSummaries(
      existingSummary,
      summarizeMessages(removedForFallback),
    );
  }

  const continuation = getCompactContinuationMessage(
    summary,
    opts?.trigger !== "manual",
    false, // full path preserves no messages
    config.transcriptPath,
  );

  // Claude Code ships the continuation as a user message (see compactor.ts).
  const continuationMsg: ProviderMessage = {
    role: "user",
    content: [{ type: "text", text: continuation }],
  };

  // Attachment re-injection (recently read files, todo snapshot).
  const attachments =
    opts?.skipAttachments === true
      ? []
      : buildPostCompactAttachments(session.messages);

  // F1: re-inject project instructions (CLAUDE.md/AGENTS.md) ahead of the
  // file/todo attachments — CC re-reads these after compaction.
  const recontextual = await runRecontextualize(opts?.recontextualize);

  return {
    summary,
    compactedSession: {
      messages: [continuationMsg, ...recontextual, ...attachments, ...heldOut],
    },
    removedMessageCount: toSummarize.length,
    boundaryWalkedBack: false,
    summarizerFailed,
  };
}

/** Invoke the recontextualize hook defensively — it must never break compaction. */
async function runRecontextualize(
  fn: RecontextualizeFn | undefined,
): Promise<ProviderMessage[]> {
  if (fn === undefined) return [];
  try {
    return [...(await fn())];
  } catch {
    return [];
  }
}

function isContinuationMessage(msg: ProviderMessage): boolean {
  return extractExistingCompactedSummary(msg) !== null;
}

// ---------------------------------------------------------------------------
// Reactive (keep-recent group) compaction — context_overflow recovery
// ---------------------------------------------------------------------------

export interface ReactiveCompactOptions extends CompactOptions {
  /** Context window of the model, for the verbatim-tail budget. */
  readonly contextWindow?: number;
}

/** MiMoCode verbatim-tail budget: min(8000, max(2000, usable × 0.25)). */
export function reactiveTailBudgetTokens(contextWindow?: number): number {
  if (contextWindow === undefined) return 8_000;
  const usable = autoCompactThreshold(contextWindow);
  return Math.min(8_000, Math.max(2_000, Math.floor(usable * 0.25)));
}

/**
 * Split messages into user-turn groups: each group starts at a plain user
 * text message (a real user turn, not a tool_result carrier) and runs until
 * the next one. A leading continuation/tool-result run forms its own group.
 */
export function splitIntoTurnGroups(
  messages: readonly ProviderMessage[],
): ProviderMessage[][] {
  const groups: ProviderMessage[][] = [];
  let current: ProviderMessage[] = [];
  for (const msg of messages) {
    const isTurnStart =
      msg.role === "user" &&
      msg.content.some((b) => b.type === "text") &&
      !msg.content.some((b) => b.type === "tool_result");
    if (isTurnStart && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(msg);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Reactive compaction (CC group compaction, MiMoCode tail budget): keep the
 * newest whole turn groups within the tail budget verbatim, summarize
 * everything older with the RECENT-portion prompt. Used by the hardened
 * engine when the provider reports context_overflow mid-session.
 */
export async function compactSessionReactive(
  session: Session,
  config: RemoteCompactionConfig,
  abort?: AbortSignal,
  opts?: ReactiveCompactOptions,
): Promise<CompactionResult> {
  const groups = splitIntoTurnGroups(session.messages);
  if (groups.length === 0) {
    return {
      summary: "",
      compactedSession: session,
      removedMessageCount: 0,
      boundaryWalkedBack: false,
      summarizerFailed: false,
    };
  }

  // Keep newest whole groups within the tail budget (always < all groups —
  // reactive compaction must summarize something).
  const budget = reactiveTailBudgetTokens(opts?.contextWindow);
  let kept = 0;
  let tokens = 0;
  for (let i = groups.length - 1; i > 0; i--) {
    const groupTokens = groups[i]!.reduce(
      (sum, m) => sum + estimateTokens(m),
      0,
    );
    if (tokens + groupTokens > budget) break;
    tokens += groupTokens;
    kept++;
  }

  const summarizeGroups = groups.slice(0, groups.length - kept);
  const preserved = groups.slice(groups.length - kept).flat();
  const toSummarize = summarizeGroups.flat();

  let summary: string;
  let summarizerFailed = false;
  try {
    summary = await summarizeInSession(
      toSummarize,
      config,
      { ...opts, customInstructions: opts?.customInstructions, recentPortion: true },
      abort,
    );
  } catch {
    summarizerFailed = true;
    const existingSummary = extractExistingCompactedSummary(toSummarize[0]);
    summary = mergeCompactSummaries(
      existingSummary,
      summarizeMessages(toSummarize.slice(existingSummary !== null ? 1 : 0)),
    );
  }

  const continuation = getCompactContinuationMessage(
    summary,
    opts?.trigger !== "manual",
    preserved.length > 0,
    config.transcriptPath,
  );
  const continuationMsg: ProviderMessage = {
    role: "user",
    content: [{ type: "text", text: continuation }],
  };

  const recontextual = await runRecontextualize(opts?.recontextualize);

  return {
    summary,
    compactedSession: {
      messages: [continuationMsg, ...recontextual, ...preserved],
    },
    removedMessageCount: toSummarize.length,
    boundaryWalkedBack: false,
    summarizerFailed,
  };
}

// ---------------------------------------------------------------------------
// Core summarization call
// ---------------------------------------------------------------------------

interface SummarizeOptions extends CompactOptions {
  readonly recentPortion?: boolean;
}

async function summarizeInSession(
  messages: readonly ProviderMessage[],
  config: RemoteCompactionConfig,
  opts: SummarizeOptions | undefined,
  abort?: AbortSignal,
): Promise<string> {
  const requestText =
    opts?.recentPortion === true
      ? buildRecentCompactSummaryRequest(opts?.customInstructions)
      : buildCompactSummaryRequest(opts?.customInstructions);

  // The conversation the summarizer sees. Prompt-too-long retries shrink it
  // from the oldest end, marked with CC's truncation string.
  let convo: readonly ProviderMessage[] = messages;
  let ptlAttempts = 0;
  let toolCallRetries = 0;
  let correction = "";
  let validationAttempts = 0;

  while (true) {
    if (abort?.aborted) throw new Error("aborted");
    try {
      const responseText = await streamSummarization(
        convo,
        requestText + correction,
        config,
        abort,
      );
      const summary = extractSummaryFromResponse(responseText);

      const missing = missingSummarySections(summary);
      if (missing.length === 0) {
        return summary;
      }

      // Corrective retry (once): re-send with an explicit list of the
      // sections the previous attempt dropped.
      validationAttempts++;
      if (validationAttempts >= 2) {
        throw new RemoteSummaryValidationError(missing);
      }
      correction =
        `\n\n## Correction Required\n` +
        `Your previous summary was missing these required sections: ` +
        `${missing.join(", ")}. Re-emit the FULL summary in the exact ` +
        `<analysis>…</analysis> then <summary>…</summary> format with every ` +
        `required section present.`;
    } catch (err) {
      if (err instanceof PromptTooLongError && ptlAttempts < MAX_PTL_RETRIES) {
        ptlAttempts++;
        convo = truncateForRetry(convo);
        continue;
      }
      if (err instanceof ToolCallInSummaryError && toolCallRetries === 0) {
        // One plain retry — the guard usually lands on the second attempt.
        toolCallRetries++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Drop the oldest half of the conversation for a prompt-too-long retry,
 * inserting Claude Code's truncation marker at the cut. Never lets the kept
 * slice start with an orphaned tool_result.
 */
export function truncateForRetry(
  messages: readonly ProviderMessage[],
): ProviderMessage[] {
  const drop = Math.max(1, Math.floor(messages.length / 2));
  const kept = messages.slice(drop);
  while (
    kept.length > 0 &&
    kept[0]!.role === "user" &&
    kept[0]!.content[0]?.type === "tool_result"
  ) {
    kept.shift();
  }
  const marker: ProviderMessage = {
    role: "user",
    content: [{ type: "text", text: COMPACT_TRUNCATION_MARKER }],
  };
  return [marker, ...kept];
}

/** Single streaming summarization call with a per-attempt timeout. */
async function streamSummarization(
  convo: readonly ProviderMessage[],
  requestText: string,
  config: RemoteCompactionConfig,
  abort?: AbortSignal,
): Promise<string> {
  const timeoutMs = config.timeoutMs ?? 120_000;
  const maxTokens = config.maxSummaryTokens ?? 8_192;

  const requestMessage: ProviderMessage = {
    role: "user",
    content: [{ type: "text", text: requestText }],
  };

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedAbort = abort
    ? combineAbortSignals(abort, timeoutController.signal)
    : timeoutController.signal;

  try {
    let responseText = "";
    for await (const event of config.provider.stream({
      messages: [...convo, requestMessage],
      systemPrompt: config.systemPrompt ?? "",
      model: config.model,
      maxOutputTokens: maxTokens,
      abort: combinedAbort,
      tools: [],
    })) {
      if (event.type === "text-delta") {
        responseText += event.text;
      } else if (
        event.type === "tool-call" ||
        event.type === "tool-input-start"
      ) {
        throw new ToolCallInSummaryError();
      } else if (event.type === "error") {
        if (event.code === "context_overflow") {
          throw new PromptTooLongError();
        }
        throw new Error(`Provider error: ${event.message}`);
      }
    }
    return responseText;
  } finally {
    clearTimeout(timer);
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
// Abort signal utilities
// ---------------------------------------------------------------------------

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}
