/**
 * inbound-acp-bridge.ts — ACP-over-MAP for the INBOUND MAP server (docs/44 P7).
 *
 * Companion to `map-acp-bridge.ts` (the OUTBOUND sidecar path). OpenHive's
 * SwarmCraft `MAPClientManager` dials our inbound MAP server (`base+2 /map`) and
 * opens an ACP stream there via the SDK's client-side `ACPStreamConnection`
 * (`ClientConnection.createACPStream({ targetAgent })`). The ACP JSON-RPC
 * messages arrive as MAP `map/send` envelopes addressed to a swarm agent; since
 * our agents are registered server-side (not as MAP connections), the SDK server
 * can't route ACP to them — it just fires `message.sent`/`message.queued` on the
 * server event bus. This bridge intercepts those, and for each ACP stream stands
 * up a coordinator team to serve it.
 *
 * Mechanism mirrors macro-agent's `map/acp-bridge.ts` (which OpenHive hosts
 * today, so the wire contract is proven): each ACP stream (keyed by `streamId`)
 * gets an in-memory `Stream` pair wired to an `AgentSideConnection`. Inbound ACP
 * messages are pushed into the readable side; the `AgentSideConnection` dispatches
 * them to our coordinator team (`createTeamConnection`, docs/44 P6) and writes
 * JSON-RPC responses + `session/update` notifications to the writable side, which
 * we wrap in `agent-to-client` MAP envelopes and deliver back to the originating
 * client (via `sendRawToClient` — a `map/event` subscription notification, what
 * `ACPStreamConnection` listens on).
 */

import {
  AgentSideConnection,
  type Stream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { createTeamConnection, type TeamConnection } from "../acp/team-connection.js";
import type { CommonOpts } from "../cli/argv.js";

/** ACP envelope as carried over MAP (matches the MAP SDK's ACPStreamConnection format). */
interface ACPEnvelope {
  acp: AnyMessage; // the ACP JSON-RPC message
  acpContext: {
    streamId: string;
    sessionId: string | null;
    direction: "client-to-agent" | "agent-to-client";
  };
}

/** Per-stream state: the in-memory stream, its coordinator team, cleanup. */
interface InboundStreamState {
  streamId: string;
  /** Client participant id (MAP `from`) — where responses route back to. */
  clientId: string;
  push: (message: AnyMessage) => void;
  close: () => void;
  connection: AgentSideConnection;
  team: TeamConnection | undefined;
}

export interface InboundAcpBridge {
  /**
   * Handle a MAP message delivered toward a local agent. Returns true if it was
   * an ACP client→agent envelope and was handled.
   */
  handleDelivery(message: unknown): boolean;
  /** Which coordinator-team stream each open ACP stream is bound to (observability/tests). */
  getStreamBindings(): Array<{ streamId: string; clientId: string }>;
  /** Number of active ACP streams. */
  streamCount(): number;
  /** Close all active streams + dispose their coordinator teams. */
  close(): Promise<void>;
}

export interface InboundAcpBridgeOptions {
  /** Hosted ACP coordinator-team options (model / permission / etc.). */
  readonly acpOpts: CommonOpts;
  /**
   * Deliver a raw MAP `map/event` notification to a specific client. Provided by
   * the map server, which tracks each client's WebSocket + subscriptions. When
   * absent the bridge still runs but responses can't reach the client (tests).
   */
  readonly sendRawToClient?: (clientId: string, event: unknown) => void;
  /** Best-effort broadcast onto the server event bus so observers see activity. */
  readonly emitEvent?: (event: unknown) => void;
  /**
   * Factory for the per-stream coordinator team. Defaults to
   * `createTeamConnection`; overridable for tests (inject a fake ACP agent so
   * the bridge's transport can be exercised without spinning a real team/model).
   */
  readonly createTeam?: (conn: AgentSideConnection, opts: CommonOpts) => TeamConnection;
  readonly log?: (msg: string) => void;
}

/** True when a MAP message payload is an ACP envelope. */
export function isACPEnvelope(payload: unknown): payload is ACPEnvelope {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    p.acp !== undefined &&
    p.acpContext !== undefined &&
    typeof (p.acpContext as { streamId?: unknown } | undefined)?.streamId === "string"
  );
}

export function createInboundAcpBridge(
  opts: InboundAcpBridgeOptions,
): InboundAcpBridge {
  const log = opts.log ?? (() => {});
  const makeTeam = opts.createTeam ?? createTeamConnection;
  const streams = new Map<string, InboundStreamState>();

  /** In-memory Stream pair: readable is fed by inbound MAP; writable → onOutbound. */
  function createInMemoryStream(onOutbound: (msg: AnyMessage) => void): {
    stream: Stream;
    push: (msg: AnyMessage) => void;
    close: () => void;
  } {
    let controller: ReadableStreamDefaultController<AnyMessage> | null = null;
    const readable = new ReadableStream<AnyMessage>({
      start(c) {
        controller = c;
      },
    });
    const writable = new WritableStream<AnyMessage>({
      write(chunk) {
        onOutbound(chunk);
      },
    });
    return {
      stream: { readable, writable },
      push: (msg) => {
        try {
          controller?.enqueue(msg);
        } catch {
          /* stream closed */
        }
      },
      close: () => {
        try {
          controller?.close();
        } catch {
          /* already closed */
        }
      },
    };
  }

  function getOrCreateStream(streamId: string, clientId: string): InboundStreamState {
    const existing = streams.get(streamId);
    if (existing) return existing;

    // Route an outbound ACP message (JSON-RPC response OR session/update
    // notification, written by the AgentSideConnection) back to the client.
    const sendToClient = (acpMessage: AnyMessage): void => {
      const envelope: ACPEnvelope = {
        acp: acpMessage,
        acpContext: { streamId, sessionId: null, direction: "agent-to-client" },
      };
      // Shape mirrors macro-agent: a `message_delivered` event carrying the
      // envelope, addressed to the originating client. `sendRawToClient` wraps
      // it in a `map/event` subscription notification (ACPStreamConnection's
      // listen path); `emitEvent` lets other observers see it too.
      const message = {
        id: `acp-resp-${idSuffix()}`,
        from: { agent: "swarm" },
        to: { agent: clientId },
        payload: envelope,
        timestamp: 0,
      };
      const event = {
        type: "message_delivered",
        data: { message, agentId: clientId },
        source: { agentId: "swarm" },
        id: message.id,
        timestamp: 0,
      };
      try {
        opts.sendRawToClient?.(clientId, { params: { event } });
      } catch (err) {
        log(`[inbound-acp] send-to-client failed: ${(err as Error).message}`);
      }
      try {
        opts.emitEvent?.(event);
      } catch {
        /* best effort */
      }
    };

    const { stream, push, close } = createInMemoryStream(sendToClient);

    const state: InboundStreamState = {
      streamId,
      clientId,
      push,
      close,
      connection: undefined as unknown as AgentSideConnection,
      team: undefined,
    };

    // AgentSideConnection drives our coordinator team as the ACP agent. Requests
    // read from the stream, responses/notifications write back through sendToClient.
    state.connection = new AgentSideConnection((agentConn) => {
      const team = makeTeam(agentConn, opts.acpOpts);
      state.team = team;
      log(`[inbound-acp] stream ${streamId} → new coordinator team`);
      return team.agent;
    }, stream);

    streams.set(streamId, state);
    return state;
  }

  return {
    handleDelivery(message: unknown): boolean {
      const m = message as { payload?: unknown; from?: unknown; sender?: unknown } | null;
      const payload = m?.payload;
      if (!isACPEnvelope(payload)) return false;
      const { acp, acpContext } = payload;
      if (acpContext.direction !== "client-to-agent") return false;

      const from = m?.from;
      const clientId =
        (typeof from === "string"
          ? from
          : (from as { agent?: string; id?: string } | undefined)?.agent ??
            (from as { id?: string } | undefined)?.id) ??
        (typeof m?.sender === "string" ? m.sender : "") ??
        "";

      const state = getOrCreateStream(acpContext.streamId, clientId);
      state.push(acp);
      return true;
    },

    getStreamBindings() {
      return Array.from(streams.values()).map((s) => ({
        streamId: s.streamId,
        clientId: s.clientId,
      }));
    },

    streamCount() {
      return streams.size;
    },

    async close() {
      for (const state of streams.values()) {
        state.close();
        try {
          await state.team?.close();
        } catch {
          /* best effort */
        }
      }
      streams.clear();
    },
  };
}

// Deterministic-enough unique suffix without Math.random()/Date.now() at module
// scope; monotonic counter is sufficient for stream-local response ids.
let __seq = 0;
function idSuffix(): string {
  __seq = (__seq + 1) & 0x7fffffff;
  return __seq.toString(36);
}
