/**
 * TeamRunner — the team-side analog of Stage A's AgentEngine: run a team and
 * subscribe to its LaneEvent stream. AcpTeamAgent depends on this interface so
 * it can be unit-tested with a fake; `createOrchestratorRunner` wires the real
 * Orchestrator.
 *
 * The real adapter mirrors the team-daemon's proven wiring
 * (src/swarm/team-daemon.ts:262-294): own a StandaloneHost, hand it to a
 * persistent Orchestrator, and subscribe to the host's lane-event bus via the
 * established duck-typed `events` access (also used by host/map-bridge.ts).
 */

import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Orchestrator } from "../swarm/orchestrator.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import type { TeamSpec } from "../swarm/team-spec.js";
import type { TeamResult } from "../swarm/topologies-types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { TeamSession, MemberInfo } from "../swarm/team-session.js";
import type { InteractionHandler } from "../swarm/host.js";
import type { AgentId, PermissionMode } from "../core/types.js";

/** Outcome of a steer injection (B2.0). */
export interface SteerResult {
  /** True when at least one inbox received the message. */
  readonly delivered: boolean;
  /** The resolved recipient (`role:lead`, `role:<x>`, `*`, or an agent id). */
  readonly to: string;
}

export interface TeamRunner {
  runTeam(spec: TeamSpec, opts?: { readonly signal?: AbortSignal }): Promise<TeamResult>;
  /** Subscribe to the team's lane-event stream; returns an unsubscribe fn. */
  subscribeEvents(handler: (event: LaneEvent) => void): () => void;
  /** The live TeamSession (persistent mode) for steering; undefined until a run. */
  getActiveTeam(): TeamSession | undefined;
  /**
   * Inject a steering message into the running team's inbox bus (B2.0). The
   * member sees it on its next `check_inbox` — mid-turn, no turn boundary.
   * `target` defaults to the lead. Never throws; an absent team / unknown target
   * resolves to `delivered: false`.
   */
  steer(message: string, target?: string): Promise<SteerResult>;
}

/** A human-readable label for a steer target (bare names are roles). */
export function resolveSteerTarget(target?: string): string {
  if (target === undefined || target === "" || target === "lead") return "role:lead";
  if (target === "*" || target.startsWith("role:")) return target;
  return `role:${target}`;
}

/**
 * Resolve a steer target to concrete member agentIds from the live roster.
 * Direct agentId sends (unlike `role:`/`*` selectors) work cross-scope, which
 * matters because the orchestrator (the sender) isn't in the team's scope.
 * Bare names match a role first, then a member/agent id.
 */
export function steerRecipients(
  members: ReadonlyMap<AgentId, MemberInfo>,
  target?: string,
): AgentId[] {
  const entries = [...members.entries()];
  if (target === "*") return entries.map(([id]) => id);
  const want =
    target === undefined || target === "" || target === "lead"
      ? "lead"
      : target.startsWith("role:")
        ? target.slice("role:".length)
        : target;
  const byRole = entries.filter(([, m]) => m.role === want).map(([id]) => id);
  if (byRole.length > 0) return byRole;
  // Fall back to a direct member/agent id match.
  return entries.filter(([id]) => id === want).map(([id]) => id);
}

/** Discards the orchestrator's results-JSONL sink — ACP surfaces output via lane events. */
class NullWritable extends Writable {
  override _write(
    _chunk: unknown,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    cb();
  }
}

export interface OrchestratorRunnerOptions {
  readonly permissionMode: PermissionMode;
  readonly concurrency?: number;
  /** Routes worker permission escalations to an operator (the ACP client). */
  readonly interactionHandler?: InteractionHandler;
}

export function createOrchestratorRunner(
  opts: OrchestratorRunnerOptions,
): TeamRunner {
  const host = new StandaloneHost({
    permissionMode: opts.permissionMode,
    ...(opts.interactionHandler !== undefined && {
      interactionHandler: opts.interactionHandler,
    }),
  });
  const orch = new Orchestrator({
    concurrency: opts.concurrency ?? 4,
    permissionMode: opts.permissionMode,
    resultsOut: new NullWritable(),
    host,
    persistent: true,
  });
  const bus = (host as unknown as { readonly events: EventEmitter }).events;
  return {
    runTeam: (spec, opts) => orch.runTeam(spec, opts),
    subscribeEvents: (handler) => {
      bus.on("lane_event", handler);
      return () => {
        bus.off("lane_event", handler);
      };
    },
    getActiveTeam: () => orch.getActiveTeam(),
    steer: async (message, target) => {
      const to = resolveSteerTarget(target);
      const team = orch.getActiveTeam();
      if (team === undefined) return { delivered: false, to };
      // Send DIRECT to each resolved member: the orchestrator (sender) isn't in
      // the team's scope, so `role:`/`*` selectors wouldn't resolve, but direct
      // agentId sends cross scopes.
      const recipients = steerRecipients(team.members, target);
      let delivered = 0;
      for (const agentId of recipients) {
        try {
          const res = await host.send(agentId, {
            from: host.agentId,
            to: agentId,
            content: message,
            timestamp: Date.now(),
          });
          delivered += res.delivered;
        } catch {
          // skip a failed recipient
        }
      }
      return { delivered: delivered > 0, to };
    },
  };
}
