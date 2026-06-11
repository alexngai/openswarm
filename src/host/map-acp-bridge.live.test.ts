import { describe, it, expect, afterEach } from "vitest";
import {
  AgentConnection,
  ClientConnection,
  createACPStream,
  createStreamPair,
} from "@multi-agent-protocol/sdk";
import { TestServer } from "@multi-agent-protocol/sdk/testing";
import { createMapSidecar, type MapSidecar } from "./map-sidecar.js";
import { wireAcpOverMap, type AcpOverMap } from "./map-acp-bridge.js";
import { StandaloneHost } from "../swarm/standalone-host.js";
import type { CommonOpts } from "../cli/argv.js";

/**
 * docs/44 Case 2 — LIVE ACP-over-MAP chat round trip. Runs a REAL coordinator
 * (spawns a Claude worker subprocess) and verifies session updates stream back
 * over MAP to the client, ending with a stop reason.
 *
 * Gated: `SWARM_HARNESS_LIVE_ACP_MAP=1 npx vitest run src/host/map-acp-bridge.live.test.ts`
 * (needs a working Claude auth, e.g. a Max plan; `danger-full-access` so the
 * coordinator may `exec`).
 */

const LIVE = process.env.SWARM_HARNESS_LIVE_ACP_MAP === "1";

const acpOpts: CommonOpts = {
  permissionMode: "danger-full-access",
  outputFormat: "json",
  headless: true,
  plugins: false,
  skills: false,
  mcp: false,
  hooks: false,
  dumpTools: false,
  enableWebSearch: false,
  framework: "auto",
};

describe.skipIf(!LIVE)("ACP-over-MAP — live coordinator chat", () => {
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
    sidecar = acpMap = client = undefined;
  });

  it("prompt() runs the coordinator and streams session updates over MAP", async () => {
    const hub = new TestServer({ name: "openhive" });
    const host = new StandaloneHost({ permissionMode: "danger-full-access" });
    sidecar = await createMapSidecar({
      host,
      server: "test://hub",
      scope: "swarm:live",
      swarmId: "sw-live",
      log: () => {},
      connect: async (_u, o) => {
        const [cs, ss] = createStreamPair();
        hub.acceptConnection(ss);
        const c = new AgentConnection(cs, o as never);
        await (c as unknown as { connect(): Promise<unknown> }).connect();
        return c;
      },
    });
    acpMap = wireAcpOverMap({ connection: sidecar!.connection, acpOpts, log: () => {} });

    const [cs, ss] = createStreamPair();
    hub.acceptConnection(ss);
    client = new ClientConnection(cs, {
      name: "live-client",
      capabilities: {
        observation: { canObserve: true, canQuery: true },
        messaging: { canSend: true, canReceive: true },
      },
    } as never);
    await (client as unknown as { connect(): Promise<unknown> }).connect();

    const list = (await (
      client as unknown as { listAgents(): Promise<{ agents: Array<{ id: string; name: string }> }> }
    ).listAgents()).agents;
    const sc = list.find((a) => /sidecar/.test(a.name))!;

    let updates = 0;
    const acp = createACPStream(client as never, {
      targetAgent: sc.id as never,
      timeout: 120_000,
      client: {
        requestPermission: async () => ({ outcome: { outcome: "allow" } }) as never,
        sessionUpdate: async () => {
          updates++;
        },
      },
    });
    const a = acp as unknown as {
      initialize(p: unknown): Promise<unknown>;
      newSession(p: unknown): Promise<{ sessionId: string }>;
      prompt(p: unknown): Promise<{ stopReason?: string }>;
      close(): Promise<void>;
    };

    await a.initialize({ protocolVersion: 1, clientInfo: { name: "live", version: "1" } });
    const sess = await a.newSession({ mcpServers: [], cwd: process.cwd() });
    const res = await a.prompt({
      sessionId: sess.sessionId,
      prompt: [{ type: "text", text: "Reply with exactly the word PONG and nothing else." }],
    });

    expect(updates).toBeGreaterThan(0); // session updates streamed back over MAP
    expect(res.stopReason).toBeTruthy(); // turn completed
    await a.close().catch(() => {});
  }, 180_000);
});
