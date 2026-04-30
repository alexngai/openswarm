/**
 * AgentInbox — per-agent FIFO message queues held by the orchestrator.
 *
 * Rev-2 Option A: inbox lives in StandaloneHost (depth 0), messages are
 * delivered to live workers via `sub_agent_event` notifications and also
 * buffered here so `check_inbox` calls can drain accumulated deliveries.
 *
 * Bounded per-agent. Overflow policy: evict OLDEST to make room (keep newest).
 * Per-drop `inbox_overflow` lane events are emitted by the caller (StandaloneHost).
 * On `worker_exited` the owning queue is dropped and `inbox_drained_on_exit`
 * is emitted with the discarded count — messaging is in-memory only (plan
 * Decision context #2, no persistence).
 */

import type { AgentId } from "../core/types.js";
import type { AgentMessage } from "./host.js";

export class AgentInbox {
  private readonly queues = new Map<AgentId, AgentMessage[]>();

  constructor(private readonly maxPerAgent: number = 1000) {}

  /**
   * Enqueue a message. Returns the number dropped due to overflow (0 or 1).
   * Overflow: evict OLDEST entry to make room, keep newest.
   */
  enqueue(to: AgentId, msg: AgentMessage): number {
    let q = this.queues.get(to);
    if (q === undefined) {
      q = [];
      this.queues.set(to, q);
    }
    let dropped = 0;
    if (q.length >= this.maxPerAgent) {
      q.shift();
      dropped = 1;
    }
    q.push(msg);
    return dropped;
  }

  /** Drain up to N messages in FIFO order. Returns [] when queue is empty. */
  drain(agent: AgentId, max: number): AgentMessage[] {
    if (max <= 0) return [];
    const q = this.queues.get(agent);
    if (q === undefined || q.length === 0) return [];
    const take = Math.min(max, q.length);
    return q.splice(0, take);
  }

  /** Current queue depth for an agent. */
  size(agent: AgentId): number {
    return this.queues.get(agent)?.length ?? 0;
  }

  /**
   * Drop an agent's entire queue (e.g. on worker_exited).
   * Returns the discarded messages so the caller can emit
   * `inbox_drained_on_exit` with an accurate count.
   */
  discardAgent(agent: AgentId): AgentMessage[] {
    const q = this.queues.get(agent);
    this.queues.delete(agent);
    return q ?? [];
  }

  /** Total enqueued across all agents (test helper). */
  totalSize(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
