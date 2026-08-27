/**
 * acp-ws-server.ts — docs/44 P6 (H1). ACP-over-WebSocket transport.
 *
 * OpenHive connects to a hosted swarm's coordinator over ACP at
 * `ws://<host>:<base>/acp` (the base port of the 3-port stride). This server
 * accepts WebSocket connections and, for each, builds the ACP `Stream` the SDK
 * expects and hands it to an `AgentSideConnection` — exactly like the stdio
 * path (`src/acp/index.ts`), but framed over a socket instead of stdin/stdout.
 *
 * Transport-only: the per-connection ACP agent is supplied by the caller via
 * `makeConnection`, so this module stays decoupled from the single/team agent
 * machinery (the host wires the coordinator-team factory).
 */

import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentSideConnection,
  type Stream,
  type AnyMessage,
  type Agent,
} from "@agentclientprotocol/sdk";

/** What `makeConnection` returns: the ACP agent + optional teardown. */
export interface AcpConnection {
  readonly agent: Agent;
  /** Invoked when the WebSocket closes (dispose the per-connection team, etc.). */
  close?(): Promise<void>;
}

export interface CreateAcpWsServerOptions {
  readonly port: number;
  readonly host?: string;
  /** WebSocket path (default `/acp`). */
  readonly path?: string;
  /** Build the ACP agent for a new connection. */
  readonly makeConnection: (conn: AgentSideConnection) => AcpConnection;
  readonly log?: (msg: string) => void;
}

export interface AcpWsServer {
  readonly url: string;
  readonly port: number;
  /** Live WebSocket connection count. */
  connectionCount(): number;
  close(): Promise<void>;
}

/**
 * Adapt a `ws` WebSocket into an ACP `Stream` (parsed-message duplex). The SDK
 * works with `AnyMessage` objects, not bytes — so parse each inbound text frame
 * and stringify each outbound message (no ndjson framing needed over WS).
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
          // Ignore malformed frames — a peer sending garbage shouldn't kill
          // the connection's read side.
        }
      });
      ws.once("close", () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
      ws.once("error", (err) => {
        try {
          controller.error(err);
        } catch {
          // Already errored/closed.
        }
      });
    },
    cancel() {
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    write(chunk) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(chunk));
      }
    },
  });

  return { readable, writable };
}

export async function createAcpWsServer(
  opts: CreateAcpWsServerOptions,
): Promise<AcpWsServer> {
  const host = opts.host ?? "127.0.0.1";
  const wsPath = opts.path ?? "/acp";
  const log = opts.log ?? (() => {});

  // A bare HTTP server we attach the WS upgrade to. Non-upgrade requests get a
  // 426 so a stray browser/probe gets a clear answer (health lives on base+1).
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required: connect to this port over WebSocket");
  });

  const wss = new WebSocketServer({ server: httpServer, path: wsPath });
  // The WebSocketServer mirrors the underlying http server's errors (e.g.
  // EADDRINUSE on listen) onto its own 'error' channel. Without a handler that
  // surfaces as an uncaught exception — the bind failure is already rejected via
  // the httpServer 'error' below, so here we just log and swallow.
  wss.on("error", (err: Error) => {
    log(`[acp-ws] server error: ${err.message}`);
  });
  const sockets = new Set<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    let handle: AcpConnection | undefined;
    // The SDK drives the protocol; `toAgent` builds our handler for this conn.
    const _conn = new AgentSideConnection((conn) => {
      handle = opts.makeConnection(conn);
      return handle.agent;
    }, webSocketStream(ws));
    void _conn;
    log(`[acp-ws] client connected (${sockets.size} active)`);

    ws.once("close", () => {
      sockets.delete(ws);
      log(`[acp-ws] client disconnected (${sockets.size} active)`);
      void Promise.resolve()
        .then(() => handle?.close?.())
        .catch(() => {
          // Best-effort per-connection teardown.
        });
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
    connectionCount: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) {
          try {
            ws.close();
          } catch {
            // Already closing.
          }
        }
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      }),
  };
}
