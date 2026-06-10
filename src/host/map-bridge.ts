/**
 * map-bridge.ts — docs/44 P7 (H2). Bridge the StandaloneHost lane bus onto the
 * MAP server: register agents as they spawn (coordinators advertise ACP) and
 * forward lifecycle events to connected MAP clients.
 *
 * Mirrors macro-agent's `src/map/lifecycle-bridge.ts`: agents register via the
 * registry (so the `capabilities` field survives), coordinators carry
 * `capabilities: ['acp']` (OpenHive resolves its ACP target by the first agent
 * advertising acp), and worker lifecycle becomes MAP events.
 */

import type { EventEmitter } from "node:events";
import type { LaneEvent } from "../swarm/events.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";
import type { MapServer } from "./map-server.js";

export interface MapBridgeOptions {
  /** Stable swarm id, stamped onto event sources. */
  readonly swarmId?: string;
  readonly log?: (msg: string) => void;
}

/** A coordinator is the team root (depth 0) or an explicit `coordinator` role. */
function isCoordinator(role: string | undefined, depth: number | undefined): boolean {
  return role === "coordinator" || depth === 0;
}

export function bridgeHostToMap(
  host: StandaloneHost,
  mapServer: MapServer,
  opts: MapBridgeOptions = {},
): () => void {
  const log = opts.log ?? (() => {});
  const events = (host as unknown as { readonly events: EventEmitter }).events;
  // agentId → MAP-assigned registry id, so exits can unregister the right one.
  const registered = new Map<string, string>();

  const handler = (evt: LaneEvent): void => {
    try {
      routeEvent(evt);
    } catch (err) {
      log(`[map-bridge] error handling ${evt.type}: ${(err as Error).message}`);
    }
  };

  function routeEvent(evt: LaneEvent): void {
    switch (evt.type) {
      case "worker_spawned": {
        const p = evt.payload as {
          childAgentId: string;
          role?: string;
          teamScope?: string;
          depth?: number;
        };
        const role = p.role ?? "worker";
        const coordinator = isCoordinator(p.role, p.depth);
        const agent = mapServer.map.agents.register({
          name: p.childAgentId,
          role,
          sessionId: p.childAgentId,
          // OpenHive finds the ACP target by the first agent advertising `acp`.
          ...(coordinator && { capabilities: ["acp"] }),
          metadata: {
            ...(opts.swarmId !== undefined && { swarmId: opts.swarmId }),
            ...(p.teamScope !== undefined && { teamScope: p.teamScope }),
            ...(p.depth !== undefined && { depth: p.depth }),
            ...(coordinator && {
              protocols: ["acp"],
              messaging: { canReceive: true },
            }),
          },
        });
        registered.set(p.childAgentId, agent.id);
        mapServer.map.emit({
          type: "agent.registered",
          data: { agentId: agent.id, role, capabilities: coordinator ? ["acp"] : [] },
          source: { agentId: agent.id },
        });
        log(`[map-bridge] registered ${role} ${p.childAgentId} → ${agent.id}`);
        break;
      }
      case "worker_exited": {
        const p = evt.payload as { agentId: string };
        const mapId = registered.get(p.agentId);
        if (mapId !== undefined) {
          mapServer.map.agents.unregister(mapId);
          registered.delete(p.agentId);
          mapServer.map.emit({
            type: "agent.unregistered",
            data: { agentId: mapId },
            source: { agentId: mapId },
          });
        }
        break;
      }
      case "worker_lifecycle_changed":
      case "team_started":
      case "team_completed":
      case "team_aborted":
      case "task_created":
      case "task_completed":
      case "task_failed":
      case "message_sent":
        // Forward as observability events on the MAP bus (lifecycle/task/mail).
        mapServer.map.emit({
          type: `lane.${evt.type}`,
          data: evt.payload,
        });
        break;
      default:
        // Other lane events aren't projected onto MAP.
        break;
    }
  }

  events.on("lane_event", handler);
  return () => {
    events.off("lane_event", handler);
  };
}
