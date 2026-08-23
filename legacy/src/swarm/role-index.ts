/**
 * RoleIndex — bidirectional map between agents and (scope, role) pairs.
 *
 * Used by StandaloneHost to resolve `role:<name>` broadcast addresses in
 * `send_message`. An agent may hold at most one (scope, role) pair at a time;
 * registering a new pair for an agent evicts it from its previous one.
 *
 * Scopes isolate role membership so that the same role name in two different
 * teams does not cross-broadcast. Today's StandaloneHost uses a singleton
 * scope (`"swarm:default"`); v0.4 TeamSession introduces per-team scopes.
 *
 * Roles are string labels assigned on spawn via `SpawnRequest.role` (wired
 * end-to-end in M3a Phase 6). For Phase 3 only, the Phase 3 wiring lives in
 * StandaloneHost.spawn — if a request carries `role`, the child is
 * registered here so broadcasts can find it.
 */

import type { AgentId } from "../core/types.js";

export class RoleIndex {
  private readonly byScopedRole = new Map<
    string /* `${scope}/${role}` */,
    Set<AgentId>
  >();
  private readonly byAgent = new Map<AgentId, { scope: string; role: string }>();

  /** Associate an agent with a role in a scope. Evicts any prior role for that agent. */
  register(scope: string, agentId: AgentId, role: string): void {
    const prior = this.byAgent.get(agentId);
    if (prior !== undefined) {
      const priorKey = `${prior.scope}/${prior.role}`;
      const priorSet = this.byScopedRole.get(priorKey);
      if (priorSet !== undefined) {
        priorSet.delete(agentId);
        if (priorSet.size === 0) this.byScopedRole.delete(priorKey);
      }
    }
    this.byAgent.set(agentId, { scope, role });
    const key = `${scope}/${role}`;
    let members = this.byScopedRole.get(key);
    if (members === undefined) {
      members = new Set<AgentId>();
      this.byScopedRole.set(key, members);
    }
    members.add(agentId);
  }

  /** Remove an agent (call on worker_exited). */
  evict(agentId: AgentId): void {
    const entry = this.byAgent.get(agentId);
    if (entry === undefined) return;
    this.byAgent.delete(agentId);
    const key = `${entry.scope}/${entry.role}`;
    const members = this.byScopedRole.get(key);
    if (members !== undefined) {
      members.delete(agentId);
      if (members.size === 0) this.byScopedRole.delete(key);
    }
  }

  /** All agents holding `role` within `scope`. Returns frozen snapshot. */
  agentsInRole(scope: string, role: string): readonly AgentId[] {
    const members = this.byScopedRole.get(`${scope}/${role}`);
    if (members === undefined) return [];
    return [...members];
  }

  /** Scoped role of a specific agent (undefined if no role). */
  roleOf(agentId: AgentId): { scope: string; role: string } | undefined {
    return this.byAgent.get(agentId);
  }

  /** Number of registered agents (test helper). */
  size(): number {
    return this.byAgent.size;
  }
}
