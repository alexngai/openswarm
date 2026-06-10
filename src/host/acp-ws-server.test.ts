import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Stream,
  type AnyMessage,
  type Agent,
  type Client,
} from "@agentclientprotocol/sdk";
import { initializeResponse } from "../acp/capabilities.js";
import { createAcpWsServer, type AcpWsServer } from "./acp-ws-server.js";

/** docs/44 P6 — ACP-over-WebSocket transport round-trip. */

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

/** Client-side adapter mirroring the server's WS→Stream bridge. */
function clientStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      ws.on("message", (data: Buffer) => {
        try {
          controller.enqueue(JSON.parse(data.toString()) as AnyMessage);
        } catch {
          /* ignore */
        }
      });
      ws.once("close", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write(chunk) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(chunk));
    },
  });
  return { readable, writable };
}

async function connectClient(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

let server: AcpWsServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("createAcpWsServer", () => {
  it("round-trips an ACP initialize over WebSocket and tracks the connection", async () => {
    let closeCalls = 0;
    const fakeAgent = {
      initialize: async (req: { protocolVersion: number }) =>
        initializeResponse({ protocolVersion: req.protocolVersion }),
    } as unknown as Agent;

    const port = await freePort();
    server = await createAcpWsServer({
      port,
      makeConnection: () => ({
        agent: fakeAgent,
        close: async () => {
          closeCalls++;
        },
      }),
    });
    expect(server.url).toBe(`ws://127.0.0.1:${port}/acp`);

    const ws = await connectClient(server.url);
    const client = new ClientSideConnection(
      () =>
        ({
          requestPermission: async () => ({
            outcome: { outcome: "cancelled" },
          }),
          sessionUpdate: async () => {},
        }) as unknown as Client,
      clientStream(ws),
    );

    const res = await client.initialize({ protocolVersion: PROTOCOL_VERSION });
    expect(res.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(server.connectionCount()).toBe(1);

    // Disconnect → per-connection close() fires, count drops to 0.
    ws.close();
    await vi.waitFor(() => {
      expect(server!.connectionCount()).toBe(0);
      expect(closeCalls).toBe(1);
    });
  });

  it("answers non-WS HTTP requests with 426 Upgrade Required", async () => {
    const port = await freePort();
    server = await createAcpWsServer({
      port,
      makeConnection: () => ({ agent: {} as unknown as Agent }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/acp`);
    expect(res.status).toBe(426);
  });

  it("rejects when the port is already bound", async () => {
    const port = await freePort();
    server = await createAcpWsServer({
      port,
      makeConnection: () => ({ agent: {} as unknown as Agent }),
    });
    await expect(
      createAcpWsServer({
        port,
        makeConnection: () => ({ agent: {} as unknown as Agent }),
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
