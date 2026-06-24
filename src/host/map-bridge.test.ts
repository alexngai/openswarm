import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { bridgeHostToMap, type MapSink } from "./map-bridge.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";
import type { LaneEvent } from "../swarm/events.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeSink(): MapSink & {
  registerAgent: ReturnType<typeof vi.fn>;
  emitTrajectory: ReturnType<typeof vi.fn>;
} {
  return {
    registerAgent: vi.fn((spec: { name: string }) => ({ id: `map-${spec.name}` })),
    unregisterAgent: vi.fn(),
    emitEvent: vi.fn(),
    emitTrajectory: vi.fn(),
  };
}

/** Emit a lane event on the host bus exactly as a worker-forwarded event arrives
 *  (agentId preserved — standalone-host re-emits child events verbatim). */
function emitLane(events: EventEmitter, evt: Omit<LaneEvent, "ts">): void {
  events.emit("lane_event", { ts: 1, ...evt });
}

describe("bridgeHostToMap — trajectory (Layer 1)", () => {
  it("reports a trajectory checkpoint for a registered worker", async () => {
    const events = new EventEmitter();
    const host = { events } as unknown as StandaloneHost;
    const sink = fakeSink();
    bridgeHostToMap(host, sink, { swarmId: "sw1" });

    emitLane(events, {
      agentId: "w1" as never,
      type: "worker_spawned",
      payload: { childAgentId: "w1", role: "worker", depth: 1 },
    });
    await tick();
    emitLane(events, {
      agentId: "w1" as never,
      type: "trajectory_checkpoint",
      payload: { sessionId: "w1", label: "do a thing", transcriptPath: "/t/e.jsonl" },
    });
    await tick();

    expect(sink.emitTrajectory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "w1",
        agentId: "map-w1",
        sessionId: "w1",
        label: "do a thing",
        metadata: expect.objectContaining({
          swarmId: "sw1",
          transcriptPath: "/t/e.jsonl",
        }),
      }),
    );
  });

  it("does not report a trajectory for an unregistered worker", async () => {
    const events = new EventEmitter();
    const host = { events } as unknown as StandaloneHost;
    const sink = fakeSink();
    bridgeHostToMap(host, sink);

    emitLane(events, {
      agentId: "ghost" as never,
      type: "trajectory_checkpoint",
      payload: { sessionId: "ghost", label: "x" },
    });
    await tick();

    expect(sink.emitTrajectory).not.toHaveBeenCalled();
  });
});
