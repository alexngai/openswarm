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
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionSnapshot } from "../engine/index.js";

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
}
