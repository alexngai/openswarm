/**
 * agent-inbox-backend.ts — InboxBackend impl wrapping the agent-inbox
 * library for threading + persistence (+ federation in v0.7+).
 *
 * v0.6 stage 6A.2. Implements the InboxBackend contract from
 * src/swarm/inbox.ts by delegating to agent-inbox's `MessageRouter` +
 * `Storage`. Default storage is in-memory; pass `SqliteStorage` for
 * cross-restart persistence.
 *
 * Mapping decisions (swarm-harness ↔ agent-inbox):
 *   - AgentMessage.from / .to ↔ Message.sender_id / Message.recipients[0]
 *     (single-recipient direct sends; broadcast happens in StandaloneHost
 *     by enqueueing once per recipient)
 *   - AgentMessage.content (string) ↔ Message.content
 *     ({type: "text", text: content})
 *   - AgentMessage.timestamp (ms epoch) ↔ Message.created_at (ISO)
 *   - AgentMessage.threadTag ↔ Message.thread_tag (v0.6 stage 6B made this
 *     explicit — previously AgentMessage.correlationId was auto-mapped, but
 *     the two carry different semantics: correlationId tags request/response
 *     pairs, threadTag tags reply-chains. Callers set threadTag via the
 *     `send_message` tool's `threadTag` param.)
 *   - AgentMessage.correlationId has no agent-inbox v0.2 field, so it does
 *     NOT round-trip through this backend. Tools that need correlationId
 *     persistence should keep the InMemoryInboxBackend.
 *
 * Drain semantics: agent-inbox keeps messages persistent + tracks read
 * state via Recipient.read_at. Our InboxBackend.drain contract is
 * "read + remove from queue"; the library mapping is "read + markRead so
 * subsequent unreadOnly queries skip them". History stays in storage —
 * useful for `read_thread` follow-ups; doesn't break the contract since
 * our drain just promises the messages won't be returned again.
 *
 * Overflow: agent-inbox has no overflow concept; enqueue always returns 0.
 * If overflow protection is needed, configure SqliteStorage with retention
 * policies (out of v0.6 scope).
 */

import { EventEmitter } from "node:events";
import {
  InMemoryStorage,
  MessageRouter,
  type Storage,
} from "agent-inbox";
import type { AgentId } from "../../core/types.js";
import type { AgentMessage } from "../host.js";
import type { InboxBackend } from "../inbox.js";

/**
 * Re-export for convenience so callers can write
 * `new AgentInboxBackend(new InMemoryStorage())` without a separate
 * agent-inbox import.
 */
export { InMemoryStorage } from "agent-inbox";

export interface AgentInboxBackendOptions {
  /**
   * Backing storage. Defaults to a fresh InMemoryStorage. Production
   * callers wanting persistence pass `new SqliteStorage(":memory:" |
   * "/path/to/db")` (lazy import to avoid native-binding cost when not
   * needed).
   */
  readonly storage?: Storage;
  /**
   * Event bus passed to MessageRouter. Defaults to a private EventEmitter
   * (no external subscribers). Production callers can pass their own to
   * subscribe to routing events for observability.
   */
  readonly events?: EventEmitter;
}

export class AgentInboxBackend implements InboxBackend {
  private readonly storage: Storage;
  private readonly router: MessageRouter;

  constructor(opts: AgentInboxBackendOptions = {}) {
    this.storage = opts.storage ?? new InMemoryStorage();
    const events = opts.events ?? new EventEmitter();
    this.router = new MessageRouter(this.storage, events);
  }

  async enqueue(
    scope: string,
    to: AgentId,
    msg: AgentMessage,
  ): Promise<number> {
    await this.router.routeMessage({
      from: msg.from,
      to: [{ agent_id: to, kind: "to" }],
      payload: msg.content,
      scope,
      ...(msg.threadTag !== undefined && {
        threadTag: msg.threadTag,
      }),
    });
    // No overflow in agent-inbox storage; always 0.
    return 0;
  }

  async drain(
    scope: string,
    agent: AgentId,
    max: number,
  ): Promise<AgentMessage[]> {
    if (max <= 0) return [];
    // getInbox returns ALL unread for this agent (no scope filter), so we
    // post-filter. If scope filtering becomes a hot path, agent-inbox
    // could expose a scope-aware InboxQuery field.
    const all = this.storage.getInbox(agent, {
      unreadOnly: true,
      limit: max * 4, // overshoot to compensate for cross-scope filter
    });
    const scoped = all.filter((m) => m.scope === scope).slice(0, max);
    const out: AgentMessage[] = [];
    for (const m of scoped) {
      this.router.markRead(m.id, agent);
      out.push(toAgentMessage(m, agent));
    }
    return out;
  }

  async size(scope: string, agent: AgentId): Promise<number> {
    const all = this.storage.getInbox(agent, { unreadOnly: true });
    return all.filter((m) => m.scope === scope).length;
  }

  async discard(scope: string, agent: AgentId): Promise<AgentMessage[]> {
    const all = this.storage.getInbox(agent, { unreadOnly: true });
    const scoped = all.filter((m) => m.scope === scope);
    for (const m of scoped) {
      this.router.markRead(m.id, agent);
    }
    return scoped.map((m) => toAgentMessage(m, agent));
  }

  // ---- Optional InboxBackend extensions --------------------------------

  async readThread(
    scope: string,
    threadId: string,
  ): Promise<AgentMessage[]> {
    const messages = this.storage.getThread({ scope, threadTag: threadId });
    return messages.map((m) =>
      toAgentMessage(m, (m.recipients[0]?.agent_id ?? "") as string),
    );
  }

  async listAgents(scope: string): Promise<readonly AgentId[]> {
    return this.storage.listAgents(scope).map((a) => a.agent_id as AgentId);
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function toAgentMessage(
  m: import("agent-inbox").Message,
  recipientId: string,
): AgentMessage {
  // MessageContent has a catchall variant ({type: string; [key]: unknown})
  // that subsumes the typed "text" variant, so a `type === "text"` check
  // doesn't narrow .text to string. Pull it explicitly via a typed view.
  let text: string;
  if (m.content.type === "text") {
    const tc = m.content as { type: "text"; text: string };
    text = tc.text;
  } else {
    text = JSON.stringify(m.content);
  }
  return {
    from: m.sender_id as AgentId,
    to: recipientId as AgentId,
    content: text,
    timestamp: new Date(m.created_at).getTime(),
    ...(m.thread_tag !== undefined && { threadTag: m.thread_tag }),
  };
}
