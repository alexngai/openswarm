/**
 * inbox.ts — InboxBackend interface + InMemoryInboxBackend reference impl.
 *
 * v0.6 stage 6A.1 (refactor): the previous concrete `AgentInbox` class is
 * decomposed into:
 *   - `InboxBackend` — the contract every backend must satisfy (4 required
 *     methods, scope-keyed, async). Optional methods (`readThread`,
 *     `listAgents`) leave room for richer backends without forcing every
 *     impl to support them; callers feature-detect via `typeof
 *     backend.readThread === "function"`.
 *   - `InMemoryInboxBackend` — today's per-agent FIFO queue logic, now
 *     keyed by `(scope, agentId)` so messages don't leak across team scopes
 *     when the host is multi-tenant.
 *
 * `AgentInboxBackend` (adapters/agent-inbox-backend.ts) wraps the agent-inbox
 * library for threading + persistence + federation; opt in via `--agent-inbox`.
 *
 * Behavior preserved from the v0.5 `AgentInbox`:
 *   - bounded per-agent (`maxPerAgent`, default 1000)
 *   - overflow policy: evict OLDEST, keep newest; return drop count from
 *     enqueue() so the host can emit `inbox_overflow`
 *   - on `worker_exited`, `discard(scope, agent)` returns the dropped
 *     messages so the host can emit `inbox_drained_on_exit` with an
 *     accurate count
 */

import type { AgentId } from "../core/types.js";
import type { AgentMessage } from "./host.js";

/**
 * InboxBackend — the storage contract for per-agent message queues.
 *
 * All methods take a `scope: string` so the same backend can serve
 * multiple team scopes side-by-side without leakage. Default scope for
 * legacy single-team paths is `"swarm:default"` (matches the
 * StandaloneHost default).
 *
 * Required methods (4) form the minimum contract — every backend
 * implements them. Optional methods are extensions; callers should
 * feature-detect before invoking them. Adding new optional methods to
 * this interface is a non-breaking change.
 */
export interface InboxBackend {
  /**
   * Enqueue a message for `agent` in `scope`. Returns the number of
   * messages dropped due to backend-defined overflow policy (0 or 1 for
   * the in-memory backend; library backends may not have an overflow
   * concept and always return 0).
   */
  enqueue(scope: string, to: AgentId, msg: AgentMessage): Promise<number>;

  /**
   * Drain up to `max` messages for `agent` in `scope`. FIFO order. Returns
   * `[]` when the queue is empty. Drained messages are removed from the
   * backend (no read-receipt model in 6A.1).
   */
  drain(
    scope: string,
    agent: AgentId,
    max: number,
  ): Promise<AgentMessage[]>;

  /** Current queue depth for `agent` in `scope`. */
  size(scope: string, agent: AgentId): Promise<number>;

  /**
   * Drop an agent's entire queue (e.g. on `worker_exited`). Returns the
   * discarded messages so the caller can emit
   * `inbox_drained_on_exit` with an accurate count.
   */
  discard(scope: string, agent: AgentId): Promise<AgentMessage[]>;

  // ---- Optional extensions (forward-compat for v0.6 stage 6A.2+) -------

  /**
   * Return the messages in a thread (defined by the backend's threading
   * model — typically reply-chain via `correlationId`). When unsupported,
   * the method is omitted; callers should feature-detect.
   */
  readThread?(scope: string, threadId: string): Promise<AgentMessage[]>;

  /**
   * List the agents that have queued messages (or are registered) in
   * `scope`. Useful for backends that maintain a registry; in-memory
   * backend can synthesize from the queue map.
   */
  listAgents?(scope: string): Promise<readonly AgentId[]>;
}

/**
 * InMemoryInboxBackend — per-(scope, agent) FIFO queues held in memory.
 *
 * Direct port of the v0.5 `AgentInbox` class with two changes:
 *   1. All methods are async (returning Promise) to match the
 *      InboxBackend interface.
 *   2. Keyed by `(scope, agentId)` so multi-tenant hosts don't cross-
 *      contaminate scopes.
 */
export class InMemoryInboxBackend implements InboxBackend {
  /** queues[scope][agentId] → message[]. Outer + inner maps both lazy-init. */
  private readonly queues = new Map<string, Map<AgentId, AgentMessage[]>>();

  constructor(private readonly maxPerAgent: number = 1000) {}

  async enqueue(
    scope: string,
    to: AgentId,
    msg: AgentMessage,
  ): Promise<number> {
    let scopeMap = this.queues.get(scope);
    if (scopeMap === undefined) {
      scopeMap = new Map<AgentId, AgentMessage[]>();
      this.queues.set(scope, scopeMap);
    }
    let q = scopeMap.get(to);
    if (q === undefined) {
      q = [];
      scopeMap.set(to, q);
    }
    let dropped = 0;
    if (q.length >= this.maxPerAgent) {
      q.shift();
      dropped = 1;
    }
    q.push(msg);
    return dropped;
  }

  async drain(
    scope: string,
    agent: AgentId,
    max: number,
  ): Promise<AgentMessage[]> {
    if (max <= 0) return [];
    const q = this.queues.get(scope)?.get(agent);
    if (q === undefined || q.length === 0) return [];
    const take = Math.min(max, q.length);
    return q.splice(0, take);
  }

  async size(scope: string, agent: AgentId): Promise<number> {
    return this.queues.get(scope)?.get(agent)?.length ?? 0;
  }

  async discard(scope: string, agent: AgentId): Promise<AgentMessage[]> {
    const scopeMap = this.queues.get(scope);
    if (scopeMap === undefined) return [];
    const q = scopeMap.get(agent);
    scopeMap.delete(agent);
    return q ?? [];
  }

  // ---- Test helper (not part of the InboxBackend contract) ------------

  /** Total enqueued across all scopes + agents. Used by tests. */
  totalSize(): number {
    let n = 0;
    for (const scopeMap of this.queues.values()) {
      for (const q of scopeMap.values()) n += q.length;
    }
    return n;
  }
}
