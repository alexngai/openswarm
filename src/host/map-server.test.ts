import { describe, it, expect, afterEach } from "vitest";
import { createMapServer, type MapServer } from "./map-server.js";
import { bridgeHostToMap } from "./map-bridge.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import type { AgentId } from "../core/types.js";

/** docs/44 P7 — MAP server transport + host→MAP bridge (agent register + events). */

let server: MapServer | undefined;
let dispose: (() => void) | undefined;
afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await server?.close();
  server = undefined;
});

describe("createMapServer", () => {
  it("binds /map and answers non-WS HTTP with 426", async () => {
    server = await createMapServer({ port: 0, name: "sw_test" });
    expect(server.url).toBe(`ws://127.0.0.1:${server.port}/map`);
    const res = await fetch(`http://127.0.0.1:${server.port}/map`);
    expect(res.status).toBe(426);
  });

  it("rejects when the port is already bound", async () => {
    server = await createMapServer({ port: 0 });
    await expect(
      createMapServer({ port: server.port }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("bridgeHostToMap", () => {
  it("registers a coordinator with the acp capability on worker_spawned", async () => {
    server = await createMapServer({ port: 0 });
    const host = new StandaloneHost();
    dispose = bridgeHostToMap(host, server, { swarmId: "sw_1", log: () => {} });

    host.emit({
      type: "worker_spawned",
      payload: {
        childAgentId: "coord-1",
        parentAgentId: null,
        role: "coordinator",
        taskId: "t1",
        teamScope: "swarm:default",
        depth: 0,
      },
    });

    const agents = server.map.agents.list();
    const coord = agents.find((a) => a.name === "coord-1");
    expect(coord).toBeDefined();
    expect(coord!.role).toBe("coordinator");
    expect(coord!.capabilities).toContain("acp");
  });

  it("registers a depth>0 worker WITHOUT acp", async () => {
    server = await createMapServer({ port: 0 });
    const host = new StandaloneHost();
    dispose = bridgeHostToMap(host, server);

    host.emit({
      type: "worker_spawned",
      payload: {
        childAgentId: "w-1",
        parentAgentId: "coord-1" as AgentId,
        role: "worker",
        taskId: "t2",
        teamScope: "swarm:default",
        depth: 1,
      },
    });

    const w = server.map.agents.list().find((a) => a.name === "w-1");
    expect(w).toBeDefined();
    expect(w!.capabilities ?? []).not.toContain("acp");
  });

  it("unregisters the agent on worker_exited", async () => {
    server = await createMapServer({ port: 0 });
    const host = new StandaloneHost();
    dispose = bridgeHostToMap(host, server);

    host.emit({
      type: "worker_spawned",
      payload: { childAgentId: "w-2", parentAgentId: null, role: "worker", taskId: "t3", depth: 1 },
    });
    expect(server.map.agents.list().some((a) => a.name === "w-2")).toBe(true);

    host.emit({ type: "worker_exited", payload: { agentId: "w-2", exitCode: 0 } });
    expect(server.map.agents.list().some((a) => a.name === "w-2")).toBe(false);
  });

  it("forwards lifecycle/task events onto the MAP event bus", async () => {
    server = await createMapServer({ port: 0 });
    const host = new StandaloneHost();
    dispose = bridgeHostToMap(host, server);

    const seen: string[] = [];
    server.map.on("*", (e) => seen.push(e.type));

    host.emit({ type: "team_started", payload: { teamName: "t", scope: "swarm:default" } });
    host.emit({ type: "task_completed", payload: { taskId: "t1" } });

    expect(seen).toContain("lane.team_started");
    expect(seen).toContain("lane.task_completed");
  });

  it("disposer stops further projection", async () => {
    server = await createMapServer({ port: 0 });
    const host = new StandaloneHost();
    const off = bridgeHostToMap(host, server);
    off();
    host.emit({
      type: "worker_spawned",
      payload: { childAgentId: "ghost", parentAgentId: null, role: "worker", taskId: "t", depth: 1 },
    });
    expect(server.map.agents.list().some((a) => a.name === "ghost")).toBe(false);
  });
});
