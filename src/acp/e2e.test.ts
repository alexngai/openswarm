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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { once } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
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
  /** Set by the subprocess harness so tests can call agent methods. */
  conn?: ClientSideConnection;
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

// ---------------------------------------------------------------------------
// Subprocess e2e — drive the real `acp` process over stdio pipes. This is the
// truest harness: it exercises the actual entry (runAcp), stdout discipline,
// and ndjson byte framing — everything a real editor hits except the editor's
// own client quirks. Requires `bun` on PATH (skipped otherwise).
// ---------------------------------------------------------------------------

function findBun(): string | null {
  try {
    if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0) {
      return "bun";
    }
  } catch {
    // not on PATH
  }
  const home = process.env.HOME;
  if (home && existsSync(`${home}/.bun/bin/bun`)) return `${home}/.bun/bin/bun`;
  return null;
}

const BUN = findBun();

/** Connect a ClientSideConnection to a spawned agent process over stdio. */
function connectSubprocess(child: ChildProcess, harness: ClientHarness): void {
  const output = Writable.toWeb(
    child.stdin!,
  ) as unknown as WritableStream<Uint8Array>;
  const input = Readable.toWeb(
    child.stdout!,
  ) as unknown as ReadableStream<Uint8Array>;
  // The connection is created for its side effects (it begins reading stdout);
  // callers drive it through the returned-by-reference harness + the child.
  const conn = new ClientSideConnection(() => harness, ndJsonStream(output, input));
  // Stash the connection on the harness so the test can call agent methods.
  harness.conn = conn;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const closed = once(child, "close");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await closed;
  } catch {
    // ignore
  } finally {
    clearTimeout(timer);
  }
}

const SCRIPTED_TURN = JSON.stringify([
  { event: { type: "text_delta", text: "working " } },
  { event: { type: "tool_use_start", id: "t1", name: "read_file" } },
  { event: { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' } },
  { event: { type: "tool_use_end", id: "t1" } },
  { event: { type: "tool_result", toolUseId: "t1", content: "body", isError: false } },
  {
    event: {
      type: "message_stop",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  },
]);

describe("ACP e2e (subprocess)", () => {
  (BUN ? it : it.skip)(
    "drives the real `acp` process end to end over stdio",
    async () => {
      const fixture = path.join(
        os.tmpdir(),
        `acp-e2e-${process.pid}-subprocess.json`,
      );
      fs.writeFileSync(fixture, SCRIPTED_TURN);
      const child = spawn(
        BUN!,
        [
          "src/cli.ts",
          "acp",
          "--single",
          "--no-plugins",
          "--no-skills",
          "--no-mcp",
          "--no-hooks",
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, SWARM_HARNESS_TEST_SCRIPT: fixture },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      child.on("error", () => {});
      const harness = new ClientHarness();
      connectSubprocess(child, harness);
      const conn = harness.conn!;
      try {
        const init = await conn.initialize({
          protocolVersion: 1,
          clientCapabilities: {},
        });
        expect(init.agentInfo?.name).toBe("swarm-harness");
        expect(init.agentCapabilities?.loadSession).toBe(true);

        const { sessionId } = await conn.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const res = await conn.prompt({
          sessionId,
          prompt: [{ type: "text", text: "read a.ts" }],
        });
        expect(res.stopReason).toBe("end_turn");

        const kinds = harness.updates.map((u) => u.sessionUpdate);
        expect(kinds).toContain("agent_message_chunk");
        expect(kinds).toContain("tool_call");
        expect(harness.text()).toContain("working");
      } finally {
        await stopChild(child);
        fs.rmSync(fixture, { force: true });
      }
    },
    30_000,
  );

  (BUN && LIVE ? it : it.skip)(
    "drives the real `acp` process against a live model",
    async () => {
      const child = spawn(
        BUN!,
        [
          "src/cli.ts",
          "acp",
          "--single",
          "--permission-mode",
          "read-only",
          "--no-plugins",
          "--no-skills",
          "--no-mcp",
          "--no-hooks",
        ],
        { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "ignore"] },
      );
      child.on("error", () => {});
      const harness = new ClientHarness();
      connectSubprocess(child, harness);
      const conn = harness.conn!;
      try {
        await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await conn.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const res = await conn.prompt({
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
        await stopChild(child);
      }
    },
    60_000,
  );

  // True end-to-end permission round-trip: a real team member's mode-denied
  // tool call (write under read-only) escalates over IPC to the ACP client.
  (BUN && LIVE ? it : it.skip)(
    "routes a member permission escalation to the client (team, read-only)",
    async () => {
      const child = spawn(
        BUN!,
        [
          "src/cli.ts",
          "acp",
          "--team",
          "--permission-mode",
          "read-only",
          "--no-plugins",
          "--no-skills",
          "--no-mcp",
          "--no-hooks",
        ],
        { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "ignore"] },
      );
      child.on("error", () => {});
      const permRequests: RequestPermissionRequest[] = [];
      const harness = new ClientHarness((req) => {
        permRequests.push(req);
        // Reject so nothing is actually written — we only verify the round-trip.
        return { outcome: { outcome: "selected", optionId: "reject" } };
      });
      connectSubprocess(child, harness);
      const conn = harness.conn!;
      try {
        await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await conn.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const res = await conn.prompt({
          sessionId,
          prompt: [
            {
              type: "text",
              text:
                "Use your file-writing tool to create a file named acp-perm-probe.txt " +
                "with the text HI. Actually invoke the write tool — do not just describe it.",
            },
          ],
        });
        expect(res.stopReason).toBe("end_turn");
        // The member attempted a write under read-only -> escalation arrived here.
        expect(permRequests.length).toBeGreaterThan(0);
        expect(permRequests[0]!.toolCall.title).toBeTruthy();
      } finally {
        await stopChild(child);
      }
    },
    90_000,
  );

  // Steering: two prompts to one team session. The second steers the same
  // long-lived root, which resumes the first turn's session -> retains context.
  (BUN && LIVE ? it : it.skip)(
    "two-prompt steering retains context on the persistent root (team)",
    async () => {
      const child = spawn(
        BUN!,
        [
          "src/cli.ts",
          "acp",
          "--team",
          "--permission-mode",
          "workspace-write",
          "--no-plugins",
          "--no-skills",
          "--no-mcp",
          "--no-hooks",
        ],
        { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "ignore"] },
      );
      child.on("error", () => {});
      const harness = new ClientHarness();
      connectSubprocess(child, harness);
      const conn = harness.conn!;
      try {
        await conn.initialize({ protocolVersion: 1, clientCapabilities: {} });
        const { sessionId } = await conn.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        const r1 = await conn.prompt({
          sessionId,
          prompt: [
            { type: "text", text: "Remember this number for later: 42. Acknowledge briefly." },
          ],
        });
        expect(r1.stopReason).toBe("end_turn");

        // Only inspect text produced by the SECOND prompt.
        const before = harness.updates.length;
        const r2 = await conn.prompt({
          sessionId,
          prompt: [
            {
              type: "text",
              text: "What number did I ask you to remember? Reply with just the number.",
            },
          ],
        });
        expect(r2.stopReason).toBe("end_turn");
        const p2text = harness.updates
          .slice(before)
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => {
            const c = (u as { content?: { type?: string; text?: string } }).content;
            return c?.type === "text" ? (c.text ?? "") : "";
          })
          .join("");
        expect(p2text).toMatch(/\b42\b/);
      } finally {
        await stopChild(child);
      }
    },
    120_000,
  );
});
