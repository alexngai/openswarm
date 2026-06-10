import { describe, it, expect, afterEach } from "vitest";
import type { Agent } from "@agentclientprotocol/sdk";
import { bootSwarmHost, type SwarmHostHandle } from "./boot.js";

/** docs/44 P5 — bootSwarmHost port layout, health, bootstrap, shutdown. */

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let handle: SwarmHostHandle | undefined;
afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
});

describe("bootSwarmHost", () => {
  it("derives the base / base+1 / base+2 port stride", async () => {
    const base = await freePort();
    handle = await bootSwarmHost({
      port: base,
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    expect(handle.ports).toEqual({ acp: base, health: base + 1, map: base + 2 });
  });

  it("serves /health on base+1 with swarmId + ports in the body", async () => {
    const base = await freePort();
    handle = await bootSwarmHost({
      port: base,
      swarmId: "sw_boot",
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    const res = await fetch(`http://127.0.0.1:${base + 1}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ok",
      swarmId: "sw_boot",
      ports: { acp: base, health: base + 1, map: base + 2 },
    });
  });

  it("logs the bootstrap-coordinator intent when requested", async () => {
    const base = await freePort();
    const logs: string[] = [];
    handle = await bootSwarmHost({
      port: base,
      cwd: "/work/x",
      bootstrap: { coordinator: true, coordinatorCwd: "/work/x", rehydrate: "all" },
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => /bootstrap coordinator requested/.test(l))).toBe(true);
    expect(logs.some((l) => /rehydrate=all/.test(l))).toBe(true);
  });

  it("shutdown closes the health server (port becomes free)", async () => {
    const base = await freePort();
    handle = await bootSwarmHost({
      port: base,
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    await handle.shutdown();
    handle = undefined; // already shut down
    // The health port should now be re-bindable.
    await expect(
      bootSwarmHost({
        port: base,
        bootstrap: { coordinator: false, rehydrate: "coordinators" },
        log: () => {},
      }).then((h) => h.shutdown()),
    ).resolves.toBeUndefined();
  });

  it("binds the ACP-WS server on the base port when acpFactory is set", async () => {
    const base = await freePort();
    handle = await bootSwarmHost({
      port: base,
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      acpFactory: () => ({ agent: {} as unknown as Agent }),
      log: () => {},
    });
    expect(handle.acp).toBeDefined();
    expect(handle.acp!.url).toBe(`ws://127.0.0.1:${base}/acp`);
    // A plain HTTP probe to the base port → 426 (it's a WS endpoint).
    const res = await fetch(`http://127.0.0.1:${base}/acp`);
    expect(res.status).toBe(426);
  });

  it("omits the ACP-WS server when no acpFactory (P5 health-only host)", async () => {
    const base = await freePort();
    handle = await bootSwarmHost({
      port: base,
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    expect(handle.acp).toBeUndefined();
  });

  it("uses an injected host (makeHost seam)", async () => {
    const base = await freePort();
    let made = false;
    const fakeHost = { __fake: true } as never;
    handle = await bootSwarmHost({
      port: base,
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      makeHost: () => {
        made = true;
        return fakeHost;
      },
      log: () => {},
    });
    expect(made).toBe(true);
    expect(handle.host).toBe(fakeHost);
  });
});
