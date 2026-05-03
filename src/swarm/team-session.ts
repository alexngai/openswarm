/**
 * TeamSession — runtime instance of a coordinated team of agents.
 *
 * Owns the team-scoped namespace (`swarm:<name>`); registers members
 * with the host's agentToScope and RoleIndex via the existing spawn
 * pipeline; provides team-scoped send (delegates to host.send); and
 * cleans up on dispose.
 *
 * Stage 4A primitive — does NOT include topology lifecycle (await,
 * CompletionRule). That comes with stage 4B (TeamSpec) and stage 4E
 * (topology executors).
 *
 * One TeamSession per team-name per orchestrator process.
 */

import { randomUUID } from "node:crypto";
import type { AgentId, PermissionMode } from "../core/types.js";
import type {
  AgentHandle,
  AgentMessage,
  SendResult,
  SpawnRequest,
  TaskPacket,
} from "./host.js";
import type { LaneEvent } from "./events.js";
import type { StandaloneHost } from "./standalone-host.js";
import type { MemberSpec } from "./team-spec.js";

export interface TeamSessionOptions {
  /** Unique within orchestrator. */
  readonly name: string;
  readonly host: StandaloneHost;
  /** Applied to spawned members. */
  readonly permissionMode: PermissionMode;
  /** For stage 4D (long-lived workers); ignored in 4A. */
  readonly idleTimeoutMs?: number;
}

export interface MemberInfo {
  readonly memberId: string;
  readonly role: string;
  readonly agentId: AgentId;
  readonly handle: AgentHandle;
  readonly state: "spawning" | "running" | "idle" | "finished" | "failed";
}

export class TeamSession {
  readonly name: string;
  /** `swarm:<name>` */
  readonly scope: string;
  private readonly host: StandaloneHost;
  private readonly permissionMode: PermissionMode;
  private readonly _members = new Map<AgentId, MemberInfo>();
  private disposed = false;

  constructor(opts: TeamSessionOptions) {
    this.name = opts.name;
    this.scope = `swarm:${opts.name}`;
    this.host = opts.host;
    this.permissionMode = opts.permissionMode;
  }

  get members(): ReadonlyMap<AgentId, MemberInfo> {
    return this._members;
  }

  /**
   * All distinct roles present in the team. Useful for `team_members()` and
   * broadcast resolution.
   */
  get roles(): ReadonlyMap<string, AgentId[]> {
    const byRole = new Map<string, AgentId[]>();
    for (const [agentId, info] of this._members) {
      const list = byRole.get(info.role) ?? [];
      list.push(agentId);
      byRole.set(info.role, list);
    }
    return byRole;
  }

  /** Spawn a single member into this team scope. Returns the AgentHandle. */
  async spawnMember(spec: MemberSpec): Promise<AgentHandle> {
    if (this.disposed) {
      throw new Error(`TeamSession ${this.name}: cannot spawn after dispose`);
    }
    const memberId = spec.id ?? `${spec.role}-${randomUUID().slice(0, 8)}`;

    // Build the TaskPacket. Default policies: kind: "none" everywhere
    // (stage 4A doesn't wire branch/commit/escalation; those are 4E).
    const taskPacket: TaskPacket = {
      id: randomUUID(),
      prompt: spec.prompt,
      branchPolicy: spec.branchPolicy ?? { kind: "none" },
      commitPolicy: spec.commitPolicy ?? { kind: "none" },
      escalationPolicy: spec.escalationPolicy ?? { kind: "none" },
      ...(spec.budget !== undefined && { budget: spec.budget }),
      role: spec.role,
    };

    const spawnRequest: SpawnRequest = {
      task: taskPacket,
      permissionMode: this.permissionMode,
      role: spec.role,
      teamScope: this.scope,
      ...(spec.model !== undefined && { model: spec.model }),
    };

    const handle = await this.host.spawn(spawnRequest);

    const info: MemberInfo = {
      memberId,
      role: spec.role,
      agentId: handle.agentId,
      handle,
      // Simplification for 4A; full lifecycle states wire in 4D.
      state: "running",
    };
    this._members.set(handle.agentId, info);
    return handle;
  }

  /** Spawn N members in parallel. */
  async spawnAll(specs: readonly MemberSpec[]): Promise<AgentHandle[]> {
    return Promise.all(specs.map((s) => this.spawnMember(s)));
  }

  /**
   * Send a message scoped to this team. Delegates to host.send (already
   * scope-aware via 4A.3).
   *
   * Note: AgentMessage.to is a single AgentId; the host's send() handles
   * broadcast/role addressing via the `to` arg. We pass `from` as the
   * message.to for broadcast cases — host fans out based on the addressing
   * arg.
   */
  async send(
    from: AgentId,
    to: AgentId | "*" | `role:${string}`,
    content: string,
  ): Promise<SendResult> {
    const isBroadcast =
      typeof to === "string" && (to === "*" || to.startsWith("role:"));
    const message: AgentMessage = {
      from,
      to: isBroadcast ? from : (to as AgentId),
      content,
      timestamp: Date.now(),
    };
    return this.host.send(to, message);
  }

  /**
   * Lane events filtered to this team's scope.
   *
   * Stage 4A: placeholder iterable that returns immediately. Live event
   * filtering will wire into the host's event bus in stage 4D when
   * long-lived workers need it. Topologies (stage 4E) consume events via
   * their own subscriptions to host.events().
   */
  // eslint-disable-next-line require-yield
  async *events(): AsyncIterable<LaneEvent> {
    return;
  }

  /** Kill all members. Called on aborted runs. */
  async kill(_reason: string): Promise<void> {
    for (const info of this._members.values()) {
      try {
        await info.handle.kill();
      } catch {
        // best-effort
      }
    }
    // Note: a `team_killed` lane event would be ideal but the LaneEventType
    // union doesn't yet carry that variant. Adding it belongs to stage 4B/4E
    // alongside the topology lifecycle wiring; keeping this commit additive
    // (no edits to events.ts) per stage 4A.4 scope rules.
  }

  /**
   * Cleanup: kill members, mark disposed. Idempotent.
   *
   * Note: agentToScope and RoleIndex entries are cleaned up when each
   * worker exits (host's onWorkerExited handler). dispose() doesn't
   * need to touch those — it just terminates.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.kill("dispose");
    this._members.clear();
  }
}
