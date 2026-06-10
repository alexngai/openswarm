import { describe, it, expect, afterEach } from "vitest";
import type { Agent } from "@agentclientprotocol/sdk";
import {
  bootSwarmHost,
  type SwarmHostHandle,
  type BootSwarmHostOptions,
} from "./boot.js";

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

/**
 * Boot on a free base port, retrying on EADDRINUSE: `freePort` only guarantees
 * `base` is free, not base+1/base+2, and the probe→bind window can race other
 * parallel tests. Returns the handle + the base it bound.
 */
async function bootOnFreeBase(
  opts: Omit<BootSwarmHostOptions, "port">,
): Promise<{ handle: SwarmHostHandle; base: number }> {
  let lastErr: unknown;
  for (let i = 0; i < 10; i++) {
    const base = await freePort();
    try {
      const h = await bootSwarmHost({ port: base, ...opts });
      return { handle: h, base };
    } catch (err) {
      lastErr = err;
      if ((err as { code?: string }).code === "EADDRINUSE") continue;
      throw err;
    }
  }
  throw lastErr;
}

let handle: SwarmHostHandle | undefined;
afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
});

describe("bootSwarmHost", () => {
  it("derives the base / base+1 / base+2 port stride", async () => {
    const { handle: h, base } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    handle = h;
    expect(handle.ports).toEqual({ acp: base, health: base + 1, map: base + 2 });
  });

  it("serves /health on base+1 with swarmId + ports in the body", async () => {
    const { handle: h, base } = await bootOnFreeBase({
      swarmId: "sw_boot",
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    handle = h;
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
    const logs: string[] = [];
    const { handle: h } = await bootOnFreeBase({
      cwd: "/work/x",
      bootstrap: { coordinator: true, coordinatorCwd: "/work/x", rehydrate: "all" },
      log: (m) => logs.push(m),
    });
    handle = h;
    expect(logs.some((l) => /bootstrap coordinator requested/.test(l))).toBe(true);
    expect(logs.some((l) => /rehydrate=all/.test(l))).toBe(true);
  });

  it("shutdown closes the health server (port becomes free)", async () => {
    const { handle: h, base } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    await h.shutdown();
    handle = undefined; // already shut down
    // The health port should now be re-bindable.
    await expect(
      bootSwarmHost({
        port: base,
        bootstrap: { coordinator: false, rehydrate: "coordinators" },
        log: () => {},
      }).then((rebound) => rebound.shutdown()),
    ).resolves.toBeUndefined();
  });

  it("binds the ACP-WS server on the base port when acpFactory is set", async () => {
    const { handle: h, base } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      acpFactory: () => ({ agent: {} as unknown as Agent }),
      log: () => {},
    });
    handle = h;
    expect(handle.acp).toBeDefined();
    expect(handle.acp!.url).toBe(`ws://127.0.0.1:${base}/acp`);
    // A plain HTTP probe to the base port → 426 (it's a WS endpoint).
    const res = await fetch(`http://127.0.0.1:${base}/acp`);
    expect(res.status).toBe(426);
  });

  it("omits the ACP-WS server when no acpFactory (P5 health-only host)", async () => {
    const { handle: h } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    handle = h;
    expect(handle.acp).toBeUndefined();
  });

  it("binds the MAP server on base+2 when map is enabled", async () => {
    const { handle: h, base } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      map: true,
      log: () => {},
    });
    handle = h;
    expect(handle.mapServer).toBeDefined();
    expect(handle.mapServer!.url).toBe(`ws://127.0.0.1:${base + 2}/map`);
    const res = await fetch(`http://127.0.0.1:${base + 2}/map`);
    expect(res.status).toBe(426);
  });

  it("omits the MAP server when map is not enabled", async () => {
    const { handle: h } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      log: () => {},
    });
    handle = h;
    expect(handle.mapServer).toBeUndefined();
  });

  it("uses an injected host (makeHost seam)", async () => {
    let made = false;
    const fakeHost = { __fake: true } as never;
    const { handle: h } = await bootOnFreeBase({
      bootstrap: { coordinator: false, rehydrate: "coordinators" },
      makeHost: () => {
        made = true;
        return fakeHost;
      },
      log: () => {},
    });
    handle = h;
    expect(made).toBe(true);
    expect(handle.host).toBe(fakeHost);
  });
});
