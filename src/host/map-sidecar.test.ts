import { describe, it, expect, vi, afterEach } from "vitest";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { createMapServer, type MapServer } from "./map-server.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** docs/44 Case 2 — outbound MAP sidecar (connect + register + cascade). */

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake AgentConnection capturing spawn/send/onNotification/disconnect. */
function fakeConn() {
  const notifications = new Map<string, (params: unknown) => void>();
  const spawn = vi.fn(async (o: { name: string }) => ({ agent: { id: `map-${o.name}` } }));
  const send = vi.fn(async () => ({}));
  const callExtension = vi.fn(async () => ({}));
  const disconnect = vi.fn(async () => ({}));
  const sendNotification = vi.fn(async () => {});
  const conn = {
    spawn,
    send,
    callExtension,
    disconnect,
    sendNotification,
    onNotification: vi.fn((method: string, h: (p: unknown) => void) => {
      notifications.set(method, h);
    }),
  };
  return { conn, spawn, send, callExtension, disconnect, sendNotification, notifications };
}

describe("createMapSidecar", () => {
  it("connects to the hub and returns a sidecar handle", async () => {
    const f = fakeConn();
    const connect = vi.fn(async () => f.conn as never);
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://hub:7836",
      scope: "swarm:test",
      swarmId: "sw1",
      connect,
      log: () => {},
    });
    expect(sidecar).toBeDefined();
    expect(connect).toHaveBeenCalledWith("ws://hub:7836", expect.objectContaining({ role: "sidecar" }));
    await sidecar!.close();
    expect(f.disconnect).toHaveBeenCalledOnce();
  });

  it("registers a spawned agent over the connection (conn.spawn)", async () => {
    const f = fakeConn();
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://hub",
      scope: "swarm:test",
      connect: async () => f.conn as never,
      log: () => {},
    });
    host.emit({
      type: "worker_spawned",
      payload: { childAgentId: "coord-1", parentAgentId: null, role: "coordinator", taskId: "t", depth: 0 },
    });
    await tick();
    expect(f.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "coord-1", role: "coordinator" }),
    );
    // Coordinator advertises acp via capabilities.protocols.
    const spec = f.spawn.mock.calls[0]![0] as { capabilities?: { protocols?: string[] } };
    expect(spec.capabilities?.protocols).toContain("acp");
    await sidecar!.close();
  });

  it("forwards lane events to the scope via conn.send", async () => {
    const f = fakeConn();
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://hub",
      scope: "swarm:test",
      connect: async () => f.conn as never,
      log: () => {},
    });
    host.emit({ type: "team_started", payload: { teamName: "t" } });
    await tick();
    expect(f.send).toHaveBeenCalledWith(
      { scope: "swarm:test" },
      expect.objectContaining({ type: "lane.team_started" }),
    );
    await sidecar!.close();
  });

  it("dispatches cascade actions arriving over the connection", async () => {
    const f = fakeConn();
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://hub",
      scope: "swarm:test",
      connect: async () => f.conn as never,
      log: () => {},
    });
    // The sidecar registered per-action notification handlers.
    const mergeHandler = f.notifications.get("x-cascade/request.merge");
    expect(mergeHandler).toBeDefined();
    // No branch adapter on a bare host → unsupported result emitted over send.
    mergeHandler!({ stream_id: "s1" });
    await tick();
    expect(f.send).toHaveBeenCalledWith(
      { scope: "swarm:test" },
      expect.objectContaining({ type: "x-cascade/stream.unsupported" }),
    );
    await sidecar!.close();
  });

  it("returns undefined (non-fatal) when connect fails", async () => {
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://unreachable",
      scope: "swarm:test",
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
      log: () => {},
    });
    expect(sidecar).toBeUndefined();
  });
});

/**
 * Integration: the real SDK AgentConnection dialing a real MAPServer (the inbound
 * P7 server doubling as a stand-in hub). Proves outbound registration works
 * over the wire, not just against a fake connection.
 */
describe("createMapSidecar — live against a MAPServer", () => {
  let server: MapServer | undefined;
  let sidecar: MapSidecar | undefined;
  afterEach(async () => {
    await sidecar?.close();
    await server?.close();
    sidecar = undefined;
    server = undefined;
  });

  it("connects and registers a spawned coordinator the server can see", async () => {
    server = await createMapServer({ port: 0, name: "hub" });
    const host = new StandaloneHost();
    sidecar = await createMapSidecar({
      host,
      server: server.url,
      scope: "swarm:rt",
      swarmId: "sw-rt",
      log: () => {},
    });
    expect(sidecar).toBeDefined();

    host.emit({
      type: "worker_spawned",
      payload: { childAgentId: "coord-x", parentAgentId: null, role: "coordinator", taskId: "t", depth: 0 },
    });
    // Allow the async conn.spawn round-trip to land in the server registry.
    await new Promise((r) => setTimeout(r, 300));

    const names = server.map.agents.list().map((a) => a.name);
    expect(names).toContain("coord-x");
  });
});

describe("createMapSidecar — trajectory reporting (Layer 1)", () => {
  // A worker-forwarded lane event arrives on the host bus with the worker's
  // agentId preserved (standalone-host re-emits child events verbatim).
  const emitWorkerLane = (host: StandaloneHost, type: string, payload: unknown): void => {
    (host as unknown as { events: EventEmitter }).events.emit("lane_event", {
      ts: Date.now(),
      agentId: "w1",
      type,
      payload,
    });
  };

  async function setup(callExtension?: () => Promise<unknown>) {
    const f = fakeConn();
    const conn = callExtension ? { ...f.conn, callExtension: vi.fn(callExtension) } : f.conn;
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://hub",
      scope: "swarm:test",
      connect: async () => conn as never,
      log: () => {},
    });
    host.emit({
      type: "worker_spawned",
      payload: { childAgentId: "w1", parentAgentId: null, role: "worker", taskId: "t", depth: 1 },
    });
    await tick();
    return { f, host, sidecar, callExtension: conn.callExtension };
  }

  it("reports via callExtension trajectory/checkpoint", async () => {
    const { f, host, sidecar } = await setup();
    emitWorkerLane(host, "trajectory_checkpoint", { sessionId: "w1", label: "do a thing" });
    await tick();
    expect(f.callExtension).toHaveBeenCalledWith(
      "trajectory/checkpoint",
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          id: "w1",
          agentId: "map-w1",
          sessionId: "w1",
          label: "do a thing",
        }),
      }),
    );
    await sidecar!.close();
  });

  it("falls back to a broadcast message when callExtension throws", async () => {
    const { f, host, sidecar, callExtension } = await setup(async () => {
      throw new Error("unsupported");
    });
    emitWorkerLane(host, "trajectory_checkpoint", { sessionId: "w1", label: "x" });
    await tick();
    expect(callExtension).toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledWith(
      { scope: "swarm:test" },
      expect.objectContaining({ type: "trajectory.checkpoint" }),
    );
    await sidecar!.close();
  });

  it("caches and replays the hub resource_id", async () => {
    const { host, sidecar, callExtension } = await setup(async () => ({ resource_id: "r1" }));
    emitWorkerLane(host, "trajectory_checkpoint", { sessionId: "w1", label: "a" });
    await tick();
    emitWorkerLane(host, "trajectory_checkpoint", { sessionId: "w1", label: "b" });
    await tick();
    const calls = (callExtension as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![1]).toEqual(expect.objectContaining({ resource_id: "r1" }));
    await sidecar!.close();
  });
});

describe("createMapSidecar — content serving (Layer 2)", () => {
  afterEach(() => {
    delete process.env.OPENSWARM_SESSION_DIR;
  });

  it("serves trajectory content on a content.request notification", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tcp-sc-"));
    process.env.OPENSWARM_SESSION_DIR = dir;
    fs.mkdirSync(path.join(dir, "s1"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s1", "events.jsonl"),
      JSON.stringify({ ts: 1, agentId: "a1", type: "turn_start", payload: { prompt: "hi" } }) + "\n",
    );

    const f = fakeConn();
    const host = new StandaloneHost();
    const sidecar = await createMapSidecar({
      host,
      server: "ws://hub",
      scope: "swarm:test",
      connect: async () => f.conn as never,
      log: () => {},
    });

    const handler = f.notifications.get("trajectory/content.request");
    expect(handler).toBeDefined();
    handler!({ checkpointId: "s1", requestId: "r1" });
    await tick();

    expect(f.sendNotification).toHaveBeenCalledWith(
      "trajectory/content.response",
      expect.objectContaining({
        requestId: "r1",
        checkpointId: "s1",
        content: expect.objectContaining({
          artifacts: expect.objectContaining({ prompts: "hi" }),
        }),
      }),
    );
    await sidecar!.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
