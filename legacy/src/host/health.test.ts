import { describe, it, expect, afterEach } from "vitest";
import { createHealthServer, type HealthServer } from "./health.js";

/** docs/44 P5 — the gateway/health server (base+1). */

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

let server: HealthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createHealthServer", () => {
  it("answers GET /health with 200 + status:ok + merged status fields", async () => {
    server = await createHealthServer({
      port: 0,
      getStatus: () => ({ swarmId: "sw_1", uptimeMs: 5 }),
    });
    const { status, body } = await getJson(`${server.url}/health`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", swarmId: "sw_1", uptimeMs: 5 });
  });

  it("also answers /healthz", async () => {
    server = await createHealthServer({ port: 0 });
    const { status, body } = await getJson(`${server.url}/healthz`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    server = await createHealthServer({ port: 0 });
    const { status } = await getJson(`${server.url}/nope`);
    expect(status).toBe(404);
  });

  it("rejects when the port is already bound", async () => {
    server = await createHealthServer({ port: 0 });
    // Re-bind the now-assigned port → EADDRINUSE.
    await expect(
      createHealthServer({ port: server.port }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
