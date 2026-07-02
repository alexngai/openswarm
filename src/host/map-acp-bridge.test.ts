import { describe, it, expect, vi, afterEach } from "vitest";
import { wireAcpOverMap, type AcpOverMap } from "./map-acp-bridge.js";
import {
  AgentConnection,
  ClientConnection,
  createACPStream,
  createStreamPair,
} from "@multi-agent-protocol/sdk";
import { TestServer } from "@multi-agent-protocol/sdk/testing";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import type { CommonOpts } from "../cli/argv.js";

/**
 * docs/44 Case 2 — ACP-over-MAP structural wiring. The full ACP chat round-trip
 * is driven by a real OpenHive `ACPStreamConnection` client (per-stream sessions
 * arrive as ACP envelopes); here we verify the adapter wires onto the connection
 * and tears down cleanly. The team-session logic itself is covered by the P6
 * ACP suite (`createTeamConnection` / `AcpTeamAgent`).
 */

const acpOpts: CommonOpts = {
  permissionMode: "workspace-write",
  outputFormat: "json",
  headless: true,
  plugins: true,
  skills: true,
  mcp: true,
  hooks: true,
  dumpTools: false,
  enableWebSearch: false,
  plan: false,
  framework: "auto",
};

function fakeConn(): { conn: AgentConnection; onMessage: ReturnType<typeof vi.fn> } {
  const onMessage = vi.fn();
  const conn = { onMessage } as unknown as AgentConnection;
  return { conn, onMessage };
}

describe("wireAcpOverMap", () => {
  it("constructs the ACP-over-MAP adapter on the connection", () => {
    const { conn, onMessage } = fakeConn();
    const acp = wireAcpOverMap({ connection: conn, acpOpts, log: () => {} });
    // The SDK adapter subscribes to inbound MAP messages (ACP envelopes).
    expect(onMessage).toHaveBeenCalled();
    expect(acp.streamCount()).toBe(0);
  });

  it("closes cleanly with no active streams", async () => {
    const { conn } = fakeConn();
    const acp = wireAcpOverMap({ connection: conn, acpOpts, log: () => {} });
    await expect(acp.close()).resolves.toBeUndefined();
    expect(acp.streamCount()).toBe(0);
  });
});

/**
 * Full ACP-over-MAP round trip through the real SDK: a TestServer hub (standing
 * in for OpenHive), our outbound sidecar + ACP-over-MAP adapter, and a real
 * `ClientConnection` + `createACPStream` (OpenHive's client side). Validates the
 * cross-SDK ACP type/version bridging end-to-end — initialize + newSession round-
 * trip through `AcpTeamAgent`. (prompt() would run a real coordinator/model, so
 * it's out of scope for the deterministic test.)
 */
describe("ACP-over-MAP — live round trip via TestServer", () => {
  let sidecar: MapSidecar | undefined;
  let acpMap: AcpOverMap | undefined;
  let client: ClientConnection | undefined;
  afterEach(async () => {
    try {
      await client?.disconnect();
    } catch {
      /* ignore */
    }
    await acpMap?.close();
    await sidecar?.close();
    sidecar = undefined;
    acpMap = undefined;
    client = undefined;
  });

  it("initialize + newSession round-trip through the coordinator team", async () => {
    const hub = new TestServer({ name: "openhive" });
    const host = new StandaloneHost({});

    // Sidecar dials the hub (via the connect seam → TestServer stream pair).
    sidecar = await createMapSidecar({
      host,
      server: "test://hub",
      scope: "swarm:e2e",
      swarmId: "sw-e2e",
      log: () => {},
      connect: async (_url, o) => {
        const [clientStream, serverStream] = createStreamPair();
        hub.acceptConnection(serverStream);
        const conn = new AgentConnection(clientStream, o as never);
        await (conn as unknown as { connect(): Promise<unknown> }).connect();
        return conn;
      },
    });
    expect(sidecar).toBeDefined();
    acpMap = wireAcpOverMap({ connection: sidecar!.connection, acpOpts, log: () => {} });

    // OpenHive's client side connects to the same hub.
    const [cStream, sStream] = createStreamPair();
    hub.acceptConnection(sStream);
    client = new ClientConnection(cStream, {
      name: "e2e-client",
      capabilities: {
        observation: { canObserve: true, canQuery: true },
        messaging: { canSend: true, canReceive: true },
      },
    } as never);
    await (client as unknown as { connect(): Promise<unknown> }).connect();

    // Resolve the sidecar agent and open an ACP stream to it.
    const listed = (await (
      client as unknown as { listAgents(): Promise<{ agents: Array<{ id: string; name: string }> }> }
    ).listAgents()) as { agents: Array<{ id: string; name: string }> };
    const sc = listed.agents.find((a) => /sidecar/.test(a.name));
    expect(sc).toBeDefined();

    const acp = createACPStream(client as never, {
      targetAgent: sc!.id as never,
      timeout: 8000,
      client: {
        requestPermission: async () => ({ outcome: { outcome: "allow" } }) as never,
        sessionUpdate: async () => {},
      },
    });

    const init = (await (
      acp as unknown as {
        initialize(p: unknown): Promise<{ agentInfo?: { name?: string }; agentCapabilities?: { loadSession?: boolean } }>;
      }
    ).initialize({ protocolVersion: 1, clientInfo: { name: "e2e", version: "1" } })) as {
      agentInfo?: { name?: string };
      agentCapabilities?: { loadSession?: boolean };
    };
    expect(init.agentInfo?.name).toBe("openswarm");
    expect(init.agentCapabilities?.loadSession).toBe(true);

    const sess = (await (
      acp as unknown as { newSession(p: unknown): Promise<{ sessionId?: string }> }
    ).newSession({ mcpServers: [], cwd: process.cwd() })) as { sessionId?: string };
    expect(typeof sess.sessionId).toBe("string");

    await (acp as unknown as { close(): Promise<void> }).close().catch(() => {});
  }, 20000);
});
