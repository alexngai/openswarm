/**
 * Map replayed session history (role + text) onto ACP session/update
 * notifications for `session/load`. Pure — returns the notifications to send,
 * in order, so they're easy to test. See docs/archive/32 §10, docs/31 Q4.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { HistoryMessage } from "../session/store.js";

export function historyChunks(
  history: readonly HistoryMessage[],
  sessionId: string,
): SessionNotification[] {
  return history.map((m) => ({
    sessionId,
    update: {
      sessionUpdate:
        m.role === "user" ? "user_message_chunk" : "agent_message_chunk",
      content: { type: "text", text: m.text },
    },
  }));
}
