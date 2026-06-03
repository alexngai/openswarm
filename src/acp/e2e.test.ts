/**
 * End-to-end ACP tests driving the agent through the SDK's real
 * ClientSideConnection over a linked in-memory stream pair. This exercises the
 * actual protocol layer (JSON-RPC dispatch + notifications + the
 * requestPermission round-trip) rather than calling AcpAgent methods directly.
 *
 * The deterministic cases use a scripted/gating engine and run in CI. The live
 * case (gated by SWARM_ACP_LIVE=1) builds the real runtime and drives an actual
 * model turn — run it with a Claude credential available:
 *
 *   SWARM_ACP_LIVE=1 npx vitest run src/acp/e2e.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  AgentSideConnection,
  ClientSideConnection,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  Stream,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { AcpAgent } from "./agent.js";
import { buildAgentRuntime } from "../cli/runtime.js";
import { PermissionEngine } from "../permissions/index.js";
import type { AgentRuntime } from "../cli/runtime.js";
import type { AgentEngine, RunConfig } from "../engine/index.js";
import type { CommonOpts } from "../cli/argv.js";
import type { NormalizedEvent } from "../core/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

class ClientHarness implements Client {
  readonly updates: SessionUpdate[] = [];
  constructor(
    private readonly onPermission: (
      r: RequestPermissionRequest,
    ) => RequestPermissionResponse = () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }),
  ) {}

  async sessionUpdate(p: SessionNotification): Promise<void> {
    this.updates.push(p.update);
  }

  async requestPermission(
    p: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return this.onPermission(p);
  }

  text(): string {
    return this.updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => {
        const c = (u as { content?: { type?: string; text?: string } }).content;
        return c?.type === "text" ? (c.text ?? "") : "";
      })
      .join("");
  }
}

/** A pair of cross-wired in-memory message streams (agent <-> client). */
function streamPair(): { agent: Stream; client: Stream } {
  const a2c = new TransformStream();
  const c2a = new TransformStream();
  return {
    agent: { writable: a2c.writable, readable: c2a.readable } as Stream,
    client: { writable: c2a.writable, readable: a2c.readable } as Stream,
  };
}

function connect(
  makeAgent: (conn: AgentSideConnection) => AcpAgent,
  harness: ClientHarness,
): { client: ClientSideConnection; dispose: () => Promise<void> } {
  const { agent, client } = streamPair();
  // eslint-disable-next-line no-new
  new AgentSideConnection(makeAgent, agent);
  const clientConn = new ClientSideConnection(() => harness, client);
  const dispose = async () => {
    await agent.writable.close().catch(() => {});
    await client.writable.close().catch(() => {});
  };
  return { client: clientConn, dispose };
}

// ---------------------------------------------------------------------------
// Fake runtimes
// ---------------------------------------------------------------------------

function baseRuntime(): AgentRuntime {
  return {
    dispatcher: {},
    tools: [],
    permEngine: new PermissionEngine("workspace-write"),
    auth: {},
    hooksConfig: {},
    mcpClients: [],
    pluginStateStore: {},
    resolvedModelId: "claude-sonnet-4-6",
    makeEngine: async () => ({ engine: {} as unknown as AgentEngine }),
  } as unknown as AgentRuntime;
}

/** Runtime whose engine replays a fixed NormalizedEvent sequence. */
function scriptedRuntime(events: NormalizedEvent[]): AgentRuntime {
  const engine = {
    id: "scripted",
    capabilities: {},
    run: async function* () {
      for (const e of events) yield e;
    },
    getCumulativeUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  } as unknown as AgentEngine;
  return { ...baseRuntime(), makeEngine: async () => ({ engine }) } as AgentRuntime;
}

/**
 * Runtime whose engine calls config.canUseTool("write_file", ...) and emits the
 * decision as text, under a read-only PermissionEngine so the call must prompt.
 */
function gatingRuntime(): AgentRuntime {
  const engine = {
    id: "gating",
    capabilities: {},
    run: async function* (config: RunConfig) {
      const decision = await config.canUseTool("write_file", {
        path: "x.ts",
        content: "hi",
      });
      yield { type: "text_delta", text: decision.allow ? "ALLOWED" : "DENIED" };
      yield {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    getCumulativeUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  } as unknown as AgentEngine;
  return {
    ...baseRuntime(),
    permEngine: new PermissionEngine("read-only"),
    dispatcher: {
      get: (name: string) => ({
        spec: { name, description: "", requiredPermission: "write" },
      }),
    } as unknown as AgentRuntime["dispatcher"],
    makeEngine: async () => ({ engine }),
  } as AgentRuntime;
}

const opts = { permissionMode: "workspace-write" } as CommonOpts;

// ---------------------------------------------------------------------------
// Deterministic e2e
// ---------------------------------------------------------------------------

describe("ACP e2e (ClientSideConnection <-> AcpAgent)", () => {
  it("drives initialize + session/new + a full prompt turn", async () => {
    const harness = new ClientHarness();
    const rt = scriptedRuntime([
      { type: "text_delta", text: "working " },
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' },
      { type: "tool_use_end", id: "t1" },
      { type: "tool_result", toolUseId: "t1", content: "body", isError: false },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const { client, dispose } = connect(
      (conn) => new AcpAgent(conn, rt, opts),
      harness,
    );
    try {
      const init = await client.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
      });
      expect(init.agentInfo?.name).toBe("swarm-harness");
      expect(init.agentCapabilities?.loadSession).toBe(true);

      const { sessionId } = await client.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      expect(sessionId.length).toBeGreaterThan(0);

      const res = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "read a.ts" }],
      });
      expect(res.stopReason).toBe("end_turn");

      const kinds = harness.updates.map((u) => u.sessionUpdate);
      expect(kinds).toContain("agent_message_chunk");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_call_update");
      expect(harness.text()).toContain("working");
    } finally {
      await dispose();
    }
  });

  it("round-trips a permission request and honors a reject", async () => {
    const harness = new ClientHarness(() => ({
      outcome: { outcome: "selected", optionId: "reject" },
    }));
    const { client, dispose } = connect(
      (conn) => new AcpAgent(conn, gatingRuntime(), opts),
      harness,
    );
    try {
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      const res = await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "write x.ts" }],
      });
      expect(res.stopReason).toBe("end_turn");
      // The agent asked; the client rejected; the engine saw the denial.
      expect(harness.text()).toBe("DENIED");
    } finally {
      await dispose();
    }
  });

  it("round-trips a permission request and honors an allow", async () => {
    const harness = new ClientHarness(() => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }));
    const { client, dispose } = connect(
      (conn) => new AcpAgent(conn, gatingRuntime(), opts),
      harness,
    );
    try {
      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      const { sessionId } = await client.newSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      await client.prompt({
        sessionId,
        prompt: [{ type: "text", text: "write x.ts" }],
      });
      expect(harness.text()).toBe("ALLOWED");
    } finally {
      await dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Live e2e — gated by SWARM_ACP_LIVE=1 (needs a Claude credential)
// ---------------------------------------------------------------------------

const LIVE = process.env.SWARM_ACP_LIVE === "1";

describe("ACP e2e (live model)", () => {
  (LIVE ? it : it.skip)(
    "drives a real model turn through the client",
    async () => {
      const liveOpts: CommonOpts = {
        permissionMode: "read-only",
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
      const built = await buildAgentRuntime(liveOpts);
      if (built.kind !== "runtime") {
        throw new Error(`runtime build failed (exit ${built.code})`);
      }
      const rt = built.runtime;
      const harness = new ClientHarness();
      const { client, dispose } = connect(
        (conn) => new AcpAgent(conn, rt, liveOpts),
        harness,
      );
      try {
        await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await client.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const res = await client.prompt({
          sessionId,
          prompt: [
            {
              type: "text",
              text: "Reply with exactly the word READY and nothing else.",
            },
          ],
        });
        expect(res.stopReason).toBe("end_turn");
        expect(harness.text().toUpperCase()).toContain("READY");
      } finally {
        await dispose();
        for (const c of rt.mcpClients) {
          await c.close().catch(() => {});
        }
      }
    },
    60_000,
  );
});
