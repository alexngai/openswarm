/**
 * Live MAP round-trip for Layer 1 — a real MAPServer + real AgentConnection over
 * WebSocket (no mocks). The default MAPServer doesn't enable the trajectory
 * extension, so we stand up a trajectory-enabled hub (the SDK's
 * TrajectoryManager) and assert it stores the checkpoint the sidecar reports via
 * callExtension over the wire.
 */

import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createMapServer, type MapServer } from "./map-server.js";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import {
  TrajectoryManagerImpl,
  InMemoryTrajectoryStore,
  EventBusImpl,
  createTrajectoryHandlers,
} from "@multi-agent-protocol/sdk/server";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Emit a worker-forwarded lane event (agentId preserved, as the host re-emits). */
function emitWorkerLane(host: StandaloneHost, agentId: string, type: string, payload: unknown): void {
  (host as unknown as { events: EventEmitter }).events.emit("lane_event", {
    ts: Date.now(),
    agentId,
    type,
    payload,
  });
}

describe("trajectory pipeline — live MAPServer round-trip", () => {
  let server: MapServer | undefined;
  let sidecar: MapSidecar | undefined;

  afterEach(async () => {
    await sidecar?.close().catch(() => {});
    await server?.close().catch(() => {});
    server = undefined;
    sidecar = undefined;
  });

  it("Layer 1 (extension): the hub stores the checkpoint the sidecar reports", async () => {
    const trajectory = new TrajectoryManagerImpl({
      store: new InMemoryTrajectoryStore(),
      eventBus: new EventBusImpl(),
    });
    const handlers = createTrajectoryHandlers({ trajectory }) as Record<string, unknown>;
    server = await createMapServer({ port: 0, name: "hub", additionalHandlers: handlers as never });

    const host = new StandaloneHost();
    sidecar = await createMapSidecar({
      host,
      server: server.url,
      scope: "swarm:live",
      swarmId: "sw-live",
      log: () => {},
    });
    expect(sidecar).toBeDefined();

    host.emit({
      type: "worker_spawned",
      payload: { childAgentId: "w1", parentAgentId: null, role: "worker", taskId: "t", depth: 1 },
    });
    await wait(300);
    emitWorkerLane(host, "w1", "trajectory_checkpoint", {
      sessionId: "sess-live",
      label: "do the thing",
    });
    await wait(400);

    const stored = (trajectory as { get: (id: string) => unknown }).get("sess-live") as
      | { sessionId?: string; label?: string }
      | undefined;
    expect(stored).toBeDefined();
    expect(stored!.sessionId).toBe("sess-live");
    expect(stored!.label).toBe("do the thing");
  }, 25000);

});
