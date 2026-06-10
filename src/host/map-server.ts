/**
 * map-server.ts — docs/44 P7 (H2). The inbound MAP server on `base + 2` at
 * `/map`.
 *
 * A hosted swarm exposes a MAP server that OpenHive's MAPClientManager connects
 * INTO (Path B — the swarm is the server, the hub is the client). Built on
 * `@multi-agent-protocol/sdk`'s `MAPServer` (protocol handling, agent registry,
 * event bus); this module owns the WebSocket transport + lifecycle.
 *
 * The MAPServer instance is exposed so the host→MAP bridge (map-bridge.ts) can
 * register agents and emit lifecycle/task/mail events driven by the
 * StandaloneHost's lane bus.
 */

import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { MAPServer } from "@multi-agent-protocol/sdk/server";
import type { Stream, AnyMessage } from "@multi-agent-protocol/sdk";

export interface MapServer {
  /** `ws://<host>:<port>/map` */
  readonly url: string;
  readonly port: number;
  /** The underlying MAP SDK server (agent registry, event bus, etc.). */
  readonly map: MAPServer;
  /** Live inbound MAP client connection count. */
  connectionCount(): number;
  close(): Promise<void>;
}

export interface CreateMapServerOptions {
  readonly port: number;
  readonly host?: string;
  /** WebSocket path (default `/map`). */
  readonly path?: string;
  /** Server name advertised to MAP clients (default `swarm-harness`). */
  readonly name?: string;
  readonly log?: (msg: string) => void;
}

/**
 * Adapt a `ws` WebSocket into the MAP SDK's `Stream` (parsed `AnyMessage`
 * duplex). Hand-rolled (rather than the SDK's browser-oriented
 * `websocketStream`) so it's robust against the `ws` EventEmitter API.
 */
function webSocketStream(ws: WebSocket): Stream {
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString("utf-8")
            : data.toString();
          controller.enqueue(JSON.parse(text) as AnyMessage);
        } catch {
          // Ignore malformed frames.
        }
      });
      ws.once("close", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      ws.once("error", (err) => {
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      });
    },
    cancel() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(chunk) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(chunk));
    },
  });

  return { readable, writable };
}

export async function createMapServer(
  opts: CreateMapServerOptions,
): Promise<MapServer> {
  const host = opts.host ?? "127.0.0.1";
  const wsPath = opts.path ?? "/map";
  const log = opts.log ?? (() => {});
  const map = new MAPServer({ name: opts.name ?? "swarm-harness" });

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required: connect to this port over WebSocket");
  });

  const wss = new WebSocketServer({ server: httpServer, path: wsPath });
  // Mirror the ACP-WS server: swallow the WebSocketServer's mirrored http
  // errors (bind failures are rejected via the httpServer 'error' below).
  wss.on("error", (err: Error) => log(`[map] server error: ${err.message}`));
  const sockets = new Set<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    // OpenHive connects as a MAP client (observes + controls); the swarm's own
    // agents are registered server-side by the bridge, not over this socket.
    const router = map.accept(webSocketStream(ws), { role: "client" });
    router.start();
    log(`[map] client connected (${sockets.size} active)`);
    ws.once("close", () => {
      sockets.delete(ws);
      log(`[map] client disconnected (${sockets.size} active)`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.removeListener("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(opts.port, host);
  });

  const addr = httpServer.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    url: `ws://${host}:${port}${wsPath}`,
    port,
    map,
    connectionCount: () => sockets.size,
    close: async () => {
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
      await map.close({ force: true }).catch(() => {});
      await new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
  };
}
