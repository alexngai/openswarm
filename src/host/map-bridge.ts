/**
 * map-bridge.ts — docs/44 P7/Case-2. Bridge the StandaloneHost lane bus onto a
 * MAP destination: register agents as they spawn (coordinators advertise ACP)
 * and forward lifecycle events.
 *
 * The destination is abstracted behind `MapSink` so the SAME bridge drives both
 * directions: the inbound MAP server (P7 — the hub dials us) and the outbound
 * sidecar connection (Case 2 — we dial the hub). `inboundMapSink` wraps a
 * MAPServer; the sidecar provides an outbound sink over its AgentConnection.
 *
 * Mirrors macro-agent's lifecycle bridge: coordinators carry
 * `capabilities: ['acp']` (the hub resolves its ACP target by the first agent
 * advertising acp); worker lifecycle becomes MAP events.
 */

import type { EventEmitter } from "node:events";
import type { LaneEvent } from "../swarm/events.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";
import type { MapServer } from "./map-server.js";

/** Where the bridge registers agents + emits events. Direction-agnostic. */
export interface MapSink {
  registerAgent(spec: {
    name: string;
    role: string;
    sessionId: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }): { id: string } | Promise<{ id: string }>;
  unregisterAgent(id: string): void | Promise<void>;
  emitEvent(event: {
    type: string;
    data: unknown;
    source?: { agentId?: string };
  }): void | Promise<void>;
}

export interface MapBridgeOptions {
  /** Stable swarm id, stamped onto event sources. */
  readonly swarmId?: string;
  readonly log?: (msg: string) => void;
}

/** A coordinator is the team root (depth 0) or an explicit `coordinator` role. */
function isCoordinator(role: string | undefined, depth: number | undefined): boolean {
  return role === "coordinator" || depth === 0;
}

/** Wrap an inbound MAP server as a sink (P7 — the hub connects to us). */
export function inboundMapSink(mapServer: MapServer): MapSink {
  return {
    registerAgent: (spec) => mapServer.map.agents.register(spec),
    unregisterAgent: (id) => {
      mapServer.map.agents.unregister(id);
    },
    emitEvent: (e) => {
      mapServer.map.emit(e);
    },
  };
}

export function bridgeHostToMap(
  host: StandaloneHost,
  sink: MapSink,
  opts: MapBridgeOptions = {},
): () => void {
  const log = opts.log ?? (() => {});
  const events = (host as unknown as { readonly events: EventEmitter }).events;
  // agentId → promise of the MAP-assigned id. A promise (not the id) so an
  // exit that races an in-flight async registration (outbound conn.spawn)
  // still unregisters the right agent once it resolves.
  const registered = new Map<string, Promise<string>>();

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
        const idP = Promise.resolve(
          sink.registerAgent({
            name: p.childAgentId,
            role,
            sessionId: p.childAgentId,
            // The hub finds the ACP target by the first agent advertising `acp`.
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
          }),
        ).then((a) => a.id);
        registered.set(p.childAgentId, idP);
        void idP
          .then((id) => {
            void sink.emitEvent({
              type: "agent.registered",
              data: { agentId: id, role, capabilities: coordinator ? ["acp"] : [] },
              source: { agentId: id },
            });
            log(`[map-bridge] registered ${role} ${p.childAgentId} → ${id}`);
          })
          .catch((err: unknown) =>
            log(`[map-bridge] register failed for ${p.childAgentId}: ${(err as Error).message}`),
          );
        break;
      }
      case "worker_exited": {
        const p = evt.payload as { agentId: string };
        const idP = registered.get(p.agentId);
        if (idP !== undefined) {
          registered.delete(p.agentId);
          void idP
            .then((id) => {
              void sink.unregisterAgent(id);
              void sink.emitEvent({
                type: "agent.unregistered",
                data: { agentId: id },
                source: { agentId: id },
              });
            })
            .catch(() => {});
        }
        break;
      }
      // Task lifecycle → OpenHive-recognized typed payloads (its coordination
      // listener routes task.created / task.status). On the outbound sidecar
      // these are delivered as scope messages (conn.send) — exactly the
      // `message.sent` shape OpenHive's task projection consumes.
      case "task_created": {
        const p = evt.payload as { taskId?: string; prompt?: string };
        void sink.emitEvent({
          type: "task.created",
          data: {
            ...(p.taskId !== undefined && { taskId: p.taskId }),
            ...(p.prompt !== undefined && { title: p.prompt }),
          },
        });
        break;
      }
      case "task_completed": {
        const p = evt.payload as { taskId?: string };
        void sink.emitEvent({
          type: "task.status",
          data: { ...(p.taskId !== undefined && { taskId: p.taskId }), status: "completed" },
        });
        break;
      }
      case "task_failed": {
        const p = evt.payload as { taskId?: string; error?: string };
        void sink.emitEvent({
          type: "task.status",
          data: {
            ...(p.taskId !== undefined && { taskId: p.taskId }),
            status: "failed",
            ...(p.error !== undefined && { error: p.error }),
          },
        });
        break;
      }
      case "worker_lifecycle_changed":
      case "team_started":
      case "team_completed":
      case "team_aborted":
      case "message_sent":
        // Lifecycle/mail observability — generic `lane.*`. (Full mail-thread
        // projection onto MAP conversations is the larger agent-inbox bridge.)
        void sink.emitEvent({ type: `lane.${evt.type}`, data: evt.payload });
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
