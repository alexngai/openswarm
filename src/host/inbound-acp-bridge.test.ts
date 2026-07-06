/**
 * Tests for the INBOUND ACP-over-MAP bridge (docs/44 P7).
 *
 * Two layers:
 *  1. Pure envelope detection + delivery routing (fake team, no transport).
 *  2. A full round-trip: a real SDK `ClientSideConnection` driven through a
 *     MAP-loopback transport into the bridge, with an injected fake coordinator
 *     team — proves initialize / session/new / prompt + a streamed session
 *     update all cross the bridge correctly, with no model.
 */

import { describe, it, expect } from "vitest";
import {
  ClientSideConnection,
  type AgentSideConnection,
  type Agent,
  type Stream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import {
  createInboundAcpBridge,
  isACPEnvelope,
  type InboundAcpBridge,
} from "./inbound-acp-bridge.js";
import type { TeamConnection } from "../acp/team-connection.js";
import type { CommonOpts } from "../cli/argv.js";

const OPTS = { permissionMode: "workspace-write" } as CommonOpts;

function clientToAgent(acp: unknown, streamId: string, clientId = "client-1"): unknown {
  return {
    payload: { acp, acpContext: { streamId, sessionId: null, direction: "client-to-agent" } },
    from: { agent: clientId },
  };
}

/** A bridge with a no-op fake team — enough for routing assertions. */
function routingBridge(): InboundAcpBridge {
  return createInboundAcpBridge({
    acpOpts: OPTS,
    createTeam: () => ({ agent: {} as unknown as Agent, close: async () => {} }),
  });
}

describe("isACPEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    expect(
      isACPEnvelope({ acp: { jsonrpc: "2.0", id: 1 }, acpContext: { streamId: "s", sessionId: null, direction: "client-to-agent" } }),
    ).toBe(true);
  });

  it("rejects non-objects + missing fields", () => {
    expect(isACPEnvelope(null)).toBe(false);
    expect(isACPEnvelope("acp")).toBe(false);
    expect(isACPEnvelope({ acp: {} })).toBe(false);
    expect(isACPEnvelope({ acpContext: { streamId: "s" } })).toBe(false);
    expect(isACPEnvelope({ acp: {}, acpContext: {} })).toBe(false);
    expect(isACPEnvelope({ acp: {}, acpContext: { streamId: 5 } })).toBe(false);
  });
});

describe("handleDelivery routing", () => {
  it("ignores non-ACP messages", () => {
    const b = routingBridge();
    expect(b.handleDelivery({ payload: { hello: "world" } })).toBe(false);
    expect(b.handleDelivery({})).toBe(false);
    expect(b.streamCount()).toBe(0);
  });

  it("ignores agent-to-client envelopes (only serves client→agent)", () => {
    const b = routingBridge();
    const msg = {
      payload: { acp: { jsonrpc: "2.0", id: 1 }, acpContext: { streamId: "s1", sessionId: null, direction: "agent-to-client" } },
      from: { agent: "client-1" },
    };
    expect(b.handleDelivery(msg)).toBe(false);
    expect(b.streamCount()).toBe(0);
  });

  it("creates a stream for a client→agent envelope and records the binding", () => {
    const b = routingBridge();
    expect(b.handleDelivery(clientToAgent({ jsonrpc: "2.0", id: 1, method: "initialize" }, "s1", "hub-42"))).toBe(true);
    expect(b.streamCount()).toBe(1);
    expect(b.getStreamBindings()).toEqual([{ streamId: "s1", clientId: "hub-42" }]);
  });

  it("reuses the stream for subsequent messages on the same streamId", () => {
    const b = routingBridge();
    b.handleDelivery(clientToAgent({ jsonrpc: "2.0", id: 1, method: "initialize" }, "s1"));
    b.handleDelivery(clientToAgent({ jsonrpc: "2.0", id: 2, method: "session/new" }, "s1"));
    expect(b.streamCount()).toBe(1);
  });

  it("keeps separate streams per streamId", () => {
    const b = routingBridge();
    b.handleDelivery(clientToAgent({ jsonrpc: "2.0", id: 1 }, "s1"));
    b.handleDelivery(clientToAgent({ jsonrpc: "2.0", id: 1 }, "s2"));
    expect(b.streamCount()).toBe(2);
  });
});

describe("full round-trip via MAP-loopback (real ClientSideConnection, fake team)", () => {
  it("drives initialize + session/new + prompt with a streamed update", async () => {
    const STREAM = "acp-stream-xyz";
    const CLIENT = "hub-client";

    // The client's readable is fed by the bridge's outbound responses.
    let clientCtl: ReadableStreamDefaultController<AnyMessage> | null = null;
    const clientReadable = new ReadableStream<AnyMessage>({ start: (c) => { clientCtl = c; } });

    // Fake coordinator team: canned responses + one streamed session update.
    const makeTeam = (conn: AgentSideConnection): TeamConnection => {
      const agent = {
        async initialize() {
          return { protocolVersion: 1, agentInfo: { name: "fake", version: "0" }, agentCapabilities: { loadSession: true } };
        },
        async newSession() {
          return { sessionId: "sess-1" };
        },
        async prompt(req: { sessionId: string }) {
          await conn.sessionUpdate({
            sessionId: req.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
          } as unknown as Parameters<AgentSideConnection["sessionUpdate"]>[0]);
          return { stopReason: "end_turn" as const };
        },
        async cancel() {},
      };
      return { agent: agent as unknown as Agent, close: async () => {} };
    };

    const bridge = createInboundAcpBridge({
      acpOpts: OPTS,
      createTeam: makeTeam,
      // Unwrap the agent→client envelope and push the ACP message into the
      // client's readable — the MAP `map/event` delivery, minus the wire.
      sendRawToClient: (_clientId, raw) => {
        const env = (raw as { params: { event: { data: { message: { payload: { acp: AnyMessage } } } } } }).params.event.data.message.payload;
        clientCtl?.enqueue(env.acp);
      },
    });

    // The client's writable wraps each outgoing ACP message into a MAP
    // client→agent envelope and delivers it to the bridge.
    const clientWritable = new WritableStream<AnyMessage>({
      write(chunk) {
        bridge.handleDelivery(clientToAgent(chunk, STREAM, CLIENT));
      },
    });
    const clientStream = { readable: clientReadable, writable: clientWritable } as Stream;

    const updates: Array<{ update?: { content?: { text?: string } } }> = [];
    const harness = {
      async sessionUpdate(n: { update?: { content?: { text?: string } } }) { updates.push(n); },
      async requestPermission() { return { outcome: { outcome: "selected", optionId: "allow" } }; },
    };
    const client = new ClientSideConnection(() => harness as never, clientStream);

    const init = await client.initialize({ protocolVersion: 1, clientCapabilities: {} } as never);
    expect((init as { agentCapabilities?: { loadSession?: boolean } }).agentCapabilities?.loadSession).toBe(true);
    expect(bridge.streamCount()).toBe(1);

    const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    expect(sessionId).toBe("sess-1");

    const res = await client.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] } as never);
    expect((res as { stopReason?: string }).stopReason).toBe("end_turn");
    expect(updates.some((u) => u.update?.content?.text === "PONG")).toBe(true);

    await bridge.close();
  });
});
