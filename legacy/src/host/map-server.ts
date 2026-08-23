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
import type { CascadeRouter } from "./cascade-actions.js";
import {
  createInboundAcpBridge,
  isACPEnvelope,
  type InboundAcpBridge,
} from "./inbound-acp-bridge.js";
import type { CommonOpts } from "../cli/argv.js";

export interface MapServer {
  /** `ws://<host>:<port>/map` */
  readonly url: string;
  readonly port: number;
  /** The underlying MAP SDK server (agent registry, event bus, etc.). */
  readonly map: MAPServer;
  /** ACP-over-MAP bridge for inbound streams (present when `acp` was enabled). */
  readonly acpBridge?: InboundAcpBridge;
  /** Live inbound MAP client connection count. */
  connectionCount(): number;
  close(): Promise<void>;
}

export interface CreateMapServerOptions {
  readonly port: number;
  readonly host?: string;
  /** WebSocket path (default `/map`). */
  readonly path?: string;
  /** Server name advertised to MAP clients (default `openswarm`). */
  readonly name?: string;
  /**
   * Extra request/response handlers merged after the SDK built-ins (docs/44 P8
   * — the `_macro/*` extension methods OpenHive invokes).
   */
  readonly additionalHandlers?: Record<
    string,
    (params: unknown, ctx?: unknown) => Promise<unknown>
  >;
  /**
   * Called for each accepted connection's router BEFORE it starts, so callers
   * can register per-connection notification handlers (docs/44 P8 — cascade
   * actions arrive as `x-cascade/request.*` notifications).
   */
  readonly onConnection?: (router: CascadeRouter) => void;
  /**
   * Enable ACP-over-MAP on the inbound server (docs/44 P7). When set, incoming
   * ACP streams (from OpenHive's `MAPClientManager.createACPStream`) are served
   * by an on-demand coordinator team. `acpOpts` carries the hosted team config.
   */
  readonly acp?: { readonly acpOpts: CommonOpts };
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
  const map = new MAPServer({
    name: opts.name ?? "openswarm",
    ...(opts.additionalHandlers !== undefined && {
      additionalHandlers: opts.additionalHandlers,
    }),
  });

  // ── ACP-over-MAP server plumbing (docs/44 P7) ──────────────────────────────
  // Access the SDK server internals the ACP path needs (not on the public type).
  const mapInternals = map as unknown as {
    eventBus?: { on(evt: string, cb: (e: unknown) => void): void; emit(e: unknown): void };
    subscriptions?: { matchesFilter?: (event: unknown, filter: unknown) => boolean };
  };

  // The SDK's matchesFilter() throws on an undefined filter (a bare
  // client.subscribe() with no args — which ACP streams use). Treat a missing
  // filter as "match all" so ACP subscriptions receive events. (macro-agent parity.)
  if (mapInternals.subscriptions?.matchesFilter) {
    const orig = mapInternals.subscriptions.matchesFilter.bind(mapInternals.subscriptions);
    mapInternals.subscriptions.matchesFilter = (event, filter) =>
      filter == null ? true : orig(event, filter);
  }

  // Per-client delivery state, used to push ACP responses back to a specific
  // client as `map/event` subscription notifications (what the client's
  // ACPStreamConnection listens on). Populated by parsing the server's outgoing
  // responses in the connection handler below.
  const clientWebSockets = new Map<string, WebSocket>();
  const clientSubscriptions = new Map<string, string[]>();
  const subscriptionSequence = new Map<string, number>();
  const originalSends = new Map<WebSocket, (data: unknown, ...a: unknown[]) => void>();
  let eventSeq = 0;

  function sendRawToClient(clientId: string, rawEvent: unknown): void {
    const ws = clientWebSockets.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const rawSend = originalSends.get(ws) ?? (ws.send.bind(ws) as (d: unknown, ...a: unknown[]) => void);
    const subIds = clientSubscriptions.get(clientId) ?? [];
    const evt = (rawEvent as { params?: { event?: unknown } })?.params?.event ?? rawEvent;
    const evtId = (evt as { id?: string })?.id ?? `acp-evt-${(eventSeq = (eventSeq + 1) & 0x7fffffff).toString(36)}`;
    for (const subId of subIds) {
      // sequenceNumber must be a per-subscription monotonic counter incrementing
      // by exactly 1 — the SDK warns on any gap. Never use a clock here.
      const nextSeq = (subscriptionSequence.get(subId) ?? 0) + 1;
      subscriptionSequence.set(subId, nextSeq);
      rawSend(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "map/event",
          params: {
            subscriptionId: subId,
            sequenceNumber: nextSeq,
            eventId: evtId,
            timestamp: Date.now(),
            event: evt,
          },
        }),
      );
    }
  }

  // The inbound ACP bridge + the event-bus hook that feeds it. ACP envelopes
  // addressed to our (server-side registered) agents don't resolve to a MAP
  // connection, so the SDK fires message.sent/queued rather than delivering —
  // we intercept there.
  let acpBridge: InboundAcpBridge | undefined;
  if (opts.acp) {
    acpBridge = createInboundAcpBridge({
      acpOpts: opts.acp.acpOpts,
      sendRawToClient,
      emitEvent: (e) => {
        try {
          mapInternals.eventBus?.emit(e);
        } catch {
          /* best effort */
        }
      },
      log,
    });
    const bridge = acpBridge;
    const handleMessageEvent = (event: unknown): void => {
      const message = (event as { data?: { message?: unknown } })?.data?.message;
      if (!message || !isACPEnvelope((message as { payload?: unknown }).payload)) return;
      // Defer so the map/send ACK goes out before the ACP response (protocol
      // ordering — the eventBus fires synchronously inside send handling).
      setImmediate(() => {
        try {
          bridge.handleDelivery(message);
        } catch (err) {
          log(`[inbound-acp] handleDelivery failed: ${(err as Error).message}`);
        }
      });
    };
    mapInternals.eventBus?.on("message.sent", handleMessageEvent);
    mapInternals.eventBus?.on("message.queued", handleMessageEvent);
  }

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

    // ACP delivery needs to push events to specific clients. Learn this client's
    // subscription ids + identity by parsing the server's OUTGOING responses
    // (openswarm's webSocketStream writes via `ws.send`, so wrapping it captures
    // them), and drop subscriptions on unsubscribe. (macro-agent parity.)
    if (opts.acp) {
      const rawSend = ws.send.bind(ws) as (data: unknown, ...a: unknown[]) => void;
      originalSends.set(ws, rawSend);
      const subIds: string[] = [];
      (ws as unknown as { send: (d: unknown, ...a: unknown[]) => unknown }).send = (
        data: unknown,
        ...args: unknown[]
      ) => {
        try {
          const msg = typeof data === "string" ? JSON.parse(data) : null;
          const result = msg?.result;
          if (typeof result?.subscriptionId === "string") subIds.push(result.subscriptionId);
          for (const id of [
            result?.agent?.id,
            result?.connection?.participantId,
            result?.sessionId,
          ]) {
            if (typeof id === "string") {
              clientWebSockets.set(id, ws);
              clientSubscriptions.set(id, subIds);
            }
          }
        } catch {
          /* non-JSON frame — ignore */
        }
        return rawSend(data, ...args);
      };
      ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString("utf-8")
            : data.toString();
          const msg = JSON.parse(text);
          if (msg?.method === "map/unsubscribe" && typeof msg?.params?.subscriptionId === "string") {
            const subId = msg.params.subscriptionId as string;
            const idx = subIds.indexOf(subId);
            if (idx >= 0) subIds.splice(idx, 1);
            subscriptionSequence.delete(subId);
          }
        } catch {
          /* ignore */
        }
      });
      ws.once("close", () => {
        for (const subId of subIds) subscriptionSequence.delete(subId);
        for (const [id, sock] of clientWebSockets) if (sock === ws) clientWebSockets.delete(id);
        originalSends.delete(ws);
      });
    }

    // OpenHive connects as a MAP client (observes + controls); the swarm's own
    // agents are registered server-side by the bridge, not over this socket.
    const router = map.accept(webSocketStream(ws), { role: "client" });
    // Register per-connection handlers (cascade actions) BEFORE start() so no
    // early notification is missed.
    opts.onConnection?.(router as unknown as CascadeRouter);
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
    ...(acpBridge !== undefined && { acpBridge }),
    connectionCount: () => sockets.size,
    close: async () => {
      if (acpBridge !== undefined) await acpBridge.close().catch(() => {});
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
