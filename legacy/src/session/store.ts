/**
 * SessionStore — thin wrapper over Claude Agent SDK's session helpers.
 *
 * M0 delegates session persistence entirely to the SDK, which writes JSONL
 * under `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. Per-worktree
 * isolation is therefore free (Q3 non-negotiable already satisfied).
 *
 * This module exposes:
 *   - resolveLatest(cwd) — returns the most-recent session id for cwd
 *   - buildSnapshot(sessionId) — wraps a session id as SessionSnapshot
 *   - list(cwd, opts?) — passes through to SDK with our defaults
 *   - deleteSession(sessionId) — pass-through for future cleanup tools
 *
 * M4's NativeEngine will add our own JSONL log alongside this; the
 * SessionSnapshot shape is already opaque so the outer CLI doesn't care
 * which engine produced the session.
 */

import {
  listSessions as sdkListSessions,
  deleteSession as sdkDeleteSession,
  getSessionMessages as sdkGetSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionSnapshot } from "../engine/index.js";

/** A replayable history message: a role plus its flattened text. */
export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * Flatten an SDK transcript message's content to plain text. Handles both the
 * string and content-block-array forms; non-text blocks (tool_use/tool_result)
 * are skipped. Exported for testing.
 */
export function extractMessageText(message: unknown): string {
  if (message == null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Public shape — SDK types do not leak through this boundary.
// ---------------------------------------------------------------------------

/**
 * Minimal session metadata surfaced to callers. Maps from the SDK's richer
 * SDKSessionInfo shape.
 */
export interface SessionInfo {
  id: string;
  /** Last-modified timestamp in milliseconds since epoch. */
  createdAt?: number;
  /** Human-readable title (customTitle if set, else summary). */
  title?: string;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  /**
   * Returns the most-recent session id for the given working directory, or
   * `undefined` if no sessions exist yet (including when the SDK throws ENOENT
   * because the project directory has never been written).
   */
  async resolveLatest(cwd: string): Promise<string | undefined> {
    try {
      const sessions = await sdkListSessions({ dir: cwd, limit: 1, offset: 0 });
      return sessions[0]?.sessionId;
    } catch {
      // SDK throws ENOENT (or similar) when the project dir has no sessions.
      return undefined;
    }
  }

  /**
   * Wraps a raw session id as an opaque SessionSnapshot for the engine layer.
   * Pure — no I/O.
   */
  buildSnapshot(sessionId: string): SessionSnapshot {
    return {
      engineId: "claude-agent-sdk",
      data: { sessionId },
    };
  }

  /**
   * Lists sessions for the given working directory, with optional pagination.
   * Maps from SDK's SDKSessionInfo to our minimal SessionInfo shape.
   */
  async list(
    cwd: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<SessionInfo[]> {
    const sdkSessions = await sdkListSessions({
      dir: cwd,
      limit: opts?.limit,
      offset: opts?.offset,
    });
    return sdkSessions.map((s) => ({
      id: s.sessionId,
      createdAt: s.lastModified,
      title: s.customTitle ?? s.summary,
    }));
  }

  /**
   * Deletes a session by id. Pass-through to SDK.
   * M0 doesn't strictly require delete — this is provided for future tooling.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await sdkDeleteSession(sessionId);
  }

  /**
   * Reads a session's user/assistant messages as flattened text, in
   * chronological order, for history replay (ACP session/load). System
   * messages and non-text content blocks are dropped. Returns [] on any error
   * (e.g. the session file doesn't exist), so callers can replay best-effort.
   */
  async readMessages(sessionId: string, cwd: string): Promise<HistoryMessage[]> {
    try {
      const msgs = await sdkGetSessionMessages(sessionId, { dir: cwd });
      const out: HistoryMessage[] = [];
      for (const m of msgs) {
        if (m.type !== "user" && m.type !== "assistant") continue;
        const text = extractMessageText(m.message);
        if (text.length === 0) continue;
        out.push({ role: m.type, text });
      }
      return out;
    } catch {
      return [];
    }
  }
}
