import { describe, it, expect, vi, afterEach } from "vitest";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { createMapServer, type MapServer } from "./map-server.js";
import { StandaloneHost } from "../swarm/standalone-host.js";

/** docs/44 Case 2 — outbound MAP sidecar (connect + register + cascade). */

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake AgentConnection capturing spawn/send/onNotification/disconnect. */
function fakeConn() {
  const notifications = new Map<string, (params: unknown) => void>();
  const spawn = vi.fn(async (o: { name: string }) => ({ agent: { id: `map-${o.name}` } }));
  const send = vi.fn(async () => ({}));
  const callExtension = vi.fn(async () => ({}));
  const disconnect = vi.fn(async () => ({}));
  const conn = {
    spawn,
    send,
    callExtension,
    disconnect,
    onNotification: vi.fn((method: string, h: (p: unknown) => void) => {
      notifications.set(method, h);
    }),
  };
  return { conn, spawn, send, callExtension, disconnect, notifications };
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
