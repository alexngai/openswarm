/**
 * Live MAP round-trip for Layer 1 — a real MAPServer + real AgentConnection over
 * WebSocket (no mocks). The default MAPServer doesn't enable the trajectory
 * extension, so we stand up a trajectory-enabled hub (the SDK's
 * TrajectoryManager) and assert it stores the checkpoint the sidecar reports via
 * callExtension over the wire.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createMapServer, type MapServer } from "./map-server.js";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import { encodeFrame } from "../swarm/ipc/framing.js";
import {
  TrajectoryManagerImpl,
  InMemoryTrajectoryStore,
  EventBusImpl,
  createTrajectoryHandlers,
} from "@multi-agent-protocol/sdk/server";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function trajectoryHub(): { server: Promise<MapServer>; trajectory: InstanceType<typeof TrajectoryManagerImpl> } {
  const trajectory = new TrajectoryManagerImpl({
    store: new InMemoryTrajectoryStore(),
    eventBus: new EventBusImpl(),
  });
  const handlers = createTrajectoryHandlers({ trajectory }) as Record<string, unknown>;
  return {
    trajectory,
    server: createMapServer({ port: 0, name: "hub", additionalHandlers: handlers as never }),
  };
}

/** A fake worker subprocess whose stdout we can push IPC frames into. */
function fakeProcPair(): { child: ChildProcess; emitFromWorker: (frame: object) => void } {
  const stdout = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout,
    stdin: new PassThrough(),
    stderr: null,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal?: string) => emitter.emit("close", null, signal ?? null)),
  }) as unknown as ChildProcess;
  return {
    child,
    emitFromWorker: (frame) =>
      stdout.push(encodeFrame(frame as Parameters<typeof encodeFrame>[0])),
  };
}

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

  it("full chain: a worker's trajectory IPC frame reaches the hub via the sidecar", async () => {
    const hub = trajectoryHub();
    server = await hub.server;

    const { child, emitFromWorker } = fakeProcPair();
    const spawnFn = vi.fn(() => child);
    const host = new StandaloneHost({ spawnWorker: spawnFn as never });
    sidecar = await createMapSidecar({
      host,
      server: server.url,
      scope: "swarm:chain",
      swarmId: "sw-chain",
      log: () => {},
    });

    // Spawn a worker (fake process) — emits worker_spawned → the bridge registers it.
    const p = host.spawn({
      task: {
        id: "t1",
        prompt: "do the task",
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
      },
      permissionMode: "workspace-write",
    });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 10 },
    });
    const handle = await p;
    await wait(300); // let the async MAP registration land

    // The worker recorded its session and emits the trajectory checkpoint frame
    // over real IPC — through the host transport, bridge, sidecar, to the hub.
    emitFromWorker({
      kind: "notification",
      method: "lane_event",
      params: {
        ts: Date.now(),
        agentId: handle.agentId,
        type: "trajectory_checkpoint",
        payload: { sessionId: "sess-chain", label: "do the task" },
      },
    });
    await wait(400);

    const stored = (hub.trajectory as { get: (id: string) => unknown }).get("sess-chain") as
      | { sessionId?: string }
      | undefined;
    expect(stored).toBeDefined();
    expect(stored!.sessionId).toBe("sess-chain");
  }, 25000);
});
