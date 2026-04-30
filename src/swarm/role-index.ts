/**
 * RoleIndex — bidirectional map between agents and role labels.
 *
 * Used by StandaloneHost to resolve `role:<name>` broadcast addresses in
 * `send_message`. An agent may hold at most one role at a time; registering
 * a new role for an agent evicts it from its previous role's member set.
 *
 * Roles are string labels assigned on spawn via `SpawnRequest.role` (wired
 * end-to-end in M3a Phase 6). For Phase 3 only, the Phase 3 wiring lives in
 * StandaloneHost.spawn — if a request carries `role`, the child is
 * registered here so broadcasts can find it.
 */

import type { AgentId } from "../core/types.js";

export class RoleIndex {
  private readonly byRole = new Map<string, Set<AgentId>>();
  private readonly byAgent = new Map<AgentId, string>();

  /** Associate an agent with a role. Evicts any prior role for that agent. */
  register(agentId: AgentId, role: string): void {
    const prior = this.byAgent.get(agentId);
    if (prior !== undefined) {
      const priorSet = this.byRole.get(prior);
      if (priorSet !== undefined) {
        priorSet.delete(agentId);
        if (priorSet.size === 0) this.byRole.delete(prior);
      }
    }
    this.byAgent.set(agentId, role);
    let members = this.byRole.get(role);
    if (members === undefined) {
      members = new Set<AgentId>();
      this.byRole.set(role, members);
    }
    members.add(agentId);
  }

  /** Remove an agent (call on worker_exited). */
  evict(agentId: AgentId): void {
    const role = this.byAgent.get(agentId);
    if (role === undefined) return;
    this.byAgent.delete(agentId);
    const members = this.byRole.get(role);
    if (members !== undefined) {
      members.delete(agentId);
      if (members.size === 0) this.byRole.delete(role);
    }
  }

  /** All agents currently holding a role. Returns frozen snapshot. */
  agentsInRole(role: string): readonly AgentId[] {
    const members = this.byRole.get(role);
    if (members === undefined) return [];
    return [...members];
  }

  /** Role of a specific agent (undefined if no role). */
  roleOf(agentId: AgentId): string | undefined {
    return this.byAgent.get(agentId);
  }

  /** Number of registered agents (test helper). */
  size(): number {
    return this.byAgent.size;
  }
}
