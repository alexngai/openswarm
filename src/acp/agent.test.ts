import { describe, it, expect } from "vitest";
import { AcpAgent } from "./agent.js";
import { parseArgv } from "../cli/argv.js";
import type { AgentRuntime } from "../cli/runtime.js";
import type { AgentEngine } from "../engine/index.js";
import type { CommonOpts } from "../cli/argv.js";
import type { NormalizedEvent } from "../core/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function stubEngine(): AgentEngine {
  return {
    id: "stub",
    capabilities: {},
    run: async function* () {
      /* no events */
    },
    getCumulativeUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  } as unknown as AgentEngine;
}

function stubRuntime(): AgentRuntime {
  return {
    dispatcher: {},
    tools: [],
    permEngine: {},
    auth: {},
    hooksConfig: {},
    mcpClients: [],
    pluginStateStore: {},
    resolvedModelId: "claude-sonnet-4-6",
    makeEngine: async () => ({ engine: stubEngine() }),
  } as unknown as AgentRuntime;
}

function scriptedRuntime(events: NormalizedEvent[]): AgentRuntime {
  const engine = {
    id: "scripted",
    capabilities: {},
    run: async function* () {
      for (const e of events) yield e;
    },
    getCumulativeUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  } as unknown as AgentEngine;
  return {
    ...stubRuntime(),
    makeEngine: async () => ({ engine }),
  } as AgentRuntime;
}

const conn = {} as never;
const opts = { permissionMode: "workspace-write" } as CommonOpts;

describe("AcpAgent", () => {
  it("initialize returns the agent info", async () => {
    const agent = new AcpAgent(conn, stubRuntime(), opts);
    const res = await agent.initialize({ protocolVersion: 1 });
    expect(res.agentInfo?.name).toBe("swarm-harness");
  });

  it("newSession returns a session id; prompt on it ends the turn", async () => {
    const agent = new AcpAgent(conn, stubRuntime(), opts);
    const { sessionId } = await agent.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);
    const res = await agent.prompt({ sessionId, prompt: [] });
    expect(res.stopReason).toBe("end_turn");
  });

  it("prompt on an unknown session refuses", async () => {
    const agent = new AcpAgent(conn, stubRuntime(), opts);
    const res = await agent.prompt({ sessionId: "does-not-exist", prompt: [] });
    expect(res.stopReason).toBe("refusal");
  });

  it("cancel aborts the session without throwing", async () => {
    const agent = new AcpAgent(conn, stubRuntime(), opts);
    const { sessionId } = await agent.newSession({
      cwd: "/tmp",
      mcpServers: [],
    });
    await expect(agent.cancel({ sessionId })).resolves.toBeUndefined();
  });

  it("authenticate is a no-op", async () => {
    const agent = new AcpAgent(conn, stubRuntime(), opts);
    await expect(agent.authenticate({ methodId: "x" })).resolves.toEqual({});
  });

  it("prompt drives the engine and streams updates, ending end_turn", async () => {
    const events: NormalizedEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "tool_use_start", id: "t1", name: "read_file" },
      { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' },
      { type: "tool_use_end", id: "t1" },
      { type: "tool_result", toolUseId: "t1", content: "body", isError: false },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ];
    const updates: SessionUpdate[] = [];
    const recordingConn = {
      sessionUpdate: async (n: { update: SessionUpdate }) => {
        updates.push(n.update);
      },
    } as never;

    const agent = new AcpAgent(recordingConn, scriptedRuntime(events), opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "read it" }],
    });

    expect(res.stopReason).toBe("end_turn");
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds).toContain("agent_message_chunk");
    const toolCall = updates.find((u) => u.sessionUpdate === "tool_call") as
      | { kind?: string }
      | undefined;
    expect(toolCall?.kind).toBe("read");
  });
});

describe("parseArgv — acp subcommand", () => {
  it("parses `acp` with shared CommonOpts", () => {
    const parsed = parseArgv(["acp", "--permission-mode", "read-only"]);
    expect(parsed.kind).toBe("acp");
    if (parsed.kind === "acp") {
      expect(parsed.opts.permissionMode).toBe("read-only");
    }
  });

  it("defaults opts for a bare `acp`", () => {
    const parsed = parseArgv(["acp"]);
    expect(parsed.kind).toBe("acp");
    if (parsed.kind === "acp") {
      expect(parsed.opts.permissionMode).toBe("workspace-write");
    }
  });
});
