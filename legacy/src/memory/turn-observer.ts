/**
 * Turn observer — connects an engine's NormalizedEvent stream to the memory
 * lifecycle hooks (Phase 3 B1).
 *
 * `observeTurnEvents` wraps one engine.run() event stream. While the turn
 * streams it records tools used and the final assistant text, forwards
 * compaction boundaries to `onCompaction`, and — when the stream finishes
 * (normally or via abort) — fires `onAfterTurn`. All hook invocations are
 * best-effort fire-and-forget: memory must never stall or fail a turn.
 *
 * `endMemorySession` composes the compact session summary (decision Q4:
 * final text + tools by default; a caller-supplied summarizer — e.g. the
 * subagent path in src/cli — when configured) and runs `onSessionEnd` under
 * a hard timeout so a slow provider can never hang process exit (Q2).
 */

import type { NormalizedEvent } from "../core/types.js";
import { onAfterTurn, onCompaction, onSessionEnd } from "./lifecycle.js";

/** Max characters of final assistant text kept in a turn/session summary. */
const SUMMARY_MAX_CHARS = 700;

/** Hard cap on session-end provider work (Q2 — never hang exit). */
const SESSION_END_TIMEOUT_MS = 5_000;

export interface TurnRecord {
  readonly turnIndex: number;
  readonly toolsUsed: readonly string[];
  /** Truncated final assistant text for this turn ("" when none streamed). */
  readonly summary: string;
}

export interface ObserveTurnOptions {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly agentId?: string;
  /** Receives the completed TurnRecord (e.g. to build the session summary). */
  readonly onRecord?: (record: TurnRecord) => void;
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= SUMMARY_MAX_CHARS
    ? trimmed
    : `${trimmed.slice(0, SUMMARY_MAX_CHARS)}…`;
}

/**
 * Wrap one turn's event stream. Yields every event unchanged; fires memory
 * hooks as a side effect. The `finally` block guarantees `onAfterTurn` fires
 * even when the consumer stops early (abort, error, budget kill).
 */
export async function* observeTurnEvents(
  events: AsyncIterable<NormalizedEvent>,
  opts: ObserveTurnOptions,
): AsyncGenerator<NormalizedEvent> {
  const toolsUsed = new Set<string>();
  // Text accumulates per assistant message; message_stop resets so the final
  // message's text (not the whole transcript) becomes the turn summary.
  let currentText = "";
  let lastMessageText = "";

  try {
    for await (const evt of events) {
      if (evt.type === "text_delta") {
        currentText += evt.text;
      } else if (evt.type === "message_stop") {
        if (currentText.trim().length > 0) lastMessageText = currentText;
        currentText = "";
      } else if (evt.type === "tool_use_start") {
        toolsUsed.add(evt.name);
      } else if (evt.type === "compaction" && evt.payload.phase === "end") {
        void onCompaction({
          sessionId: opts.sessionId,
          messageCount: 0,
          summary: `context compaction (${evt.payload.trigger})${
            evt.payload.compact_metadata !== undefined
              ? ` ${JSON.stringify(evt.payload.compact_metadata)}`
              : ""
          }`,
        }).catch(() => {});
      }
      yield evt;
    }
  } finally {
    const finalText = currentText.trim().length > 0 ? currentText : lastMessageText;
    const record: TurnRecord = {
      turnIndex: opts.turnIndex,
      toolsUsed: [...toolsUsed],
      summary: truncate(finalText),
    };
    opts.onRecord?.(record);
    void onAfterTurn({
      sessionId: opts.sessionId,
      turnIndex: opts.turnIndex,
      toolsUsed: record.toolsUsed,
      ...(record.summary.length > 0 && { summary: record.summary }),
    }).catch(() => {});
  }
}

export interface EndMemorySessionOptions {
  readonly sessionId: string;
  readonly turns: readonly TurnRecord[];
  /**
   * Optional summarizer (decision Q4): when configured (e.g.
   * OPENSWARM_MEMORY_SUMMARIZER=subagent in the CLI), produces the session
   * summary from the turn records — typically via a one-shot subagent run.
   * Falls back to the static summary on failure or when absent.
   */
  readonly summarize?: (turns: readonly TurnRecord[]) => Promise<string>;
  /** Override the session-end timeout (tests). */
  readonly timeoutMs?: number;
}

/** Static fallback summary: last turn's final text + aggregated tools. */
export function buildStaticSessionSummary(turns: readonly TurnRecord[]): string {
  const lastWithText = [...turns].reverse().find((t) => t.summary.length > 0);
  const tools = [...new Set(turns.flatMap((t) => t.toolsUsed))];
  const parts: string[] = [];
  parts.push(
    lastWithText !== undefined ? lastWithText.summary : "(no assistant output)",
  );
  if (tools.length > 0) parts.push(`Tools used: ${tools.join(", ")}`);
  parts.push(`Turns: ${turns.length}`);
  return parts.join("\n");
}

/**
 * Archive the session through the memory lifecycle (provider fan-out) and
 * shut providers down. Best-effort with a hard timeout — never throws,
 * never hangs process exit.
 */
export async function endMemorySession(
  opts: EndMemorySessionOptions,
): Promise<void> {
  if (opts.turns.length === 0) return;

  let summary: string | undefined;
  if (opts.summarize !== undefined) {
    try {
      summary = await opts.summarize(opts.turns);
    } catch {
      // subagent summarizer failed — fall back to the static summary
    }
  }
  if (summary === undefined || summary.trim().length === 0) {
    summary = buildStaticSessionSummary(opts.turns);
  }

  const toolsUsed = [...new Set(opts.turns.flatMap((t) => t.toolsUsed))];
  const timeoutMs = opts.timeoutMs ?? SESSION_END_TIMEOUT_MS;

  await Promise.race([
    onSessionEnd({
      sessionId: opts.sessionId,
      summary,
      toolsUsed,
    }).catch(() => {}),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}
