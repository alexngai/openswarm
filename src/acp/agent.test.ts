import { describe, it, expect } from "vitest";
import { AcpAgent } from "./agent.js";
import { parseArgv } from "../cli/argv.js";
import type { AgentRuntime } from "../cli/runtime.js";
import type { AgentEngine } from "../engine/index.js";
import type { CommonOpts } from "../cli/argv.js";

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

const conn = {} as never;
const opts = {} as CommonOpts;

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
