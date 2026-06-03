import { describe, it, expect } from "vitest";
import { AcpTeamAgent } from "./team-agent.js";
import type { TeamRunner } from "./team-runner.js";
import type { TeamResult } from "../swarm/topologies-types.js";
import type { CommonOpts } from "../cli/argv.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function fakeRunner(over: Partial<TeamResult> = {}): TeamRunner {
  return {
    runTeam: async () => ({
      succeeded: 1,
      failed: 0,
      timeout: 0,
      cancelled: 0,
      resultWriteFailures: 0,
      deadLetterViolation: false,
      deadLetterWriteFailures: 0,
      aggregateOutput: "team output",
      ...over,
    }),
    subscribeEvents: () => () => {},
    getActiveTeam: () => undefined,
  };
}

function recordingConn(updates: SessionUpdate[]) {
  return {
    sessionUpdate: async (n: { update: SessionUpdate }) => {
      updates.push(n.update);
    },
  } as never;
}

const opts = { permissionMode: "workspace-write" } as CommonOpts;

describe("AcpTeamAgent", () => {
  it("initialize advertises loadSession off in team mode", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    const res = await agent.initialize({ protocolVersion: 1 });
    expect(res.agentInfo?.name).toBe("swarm-harness");
    expect(res.agentCapabilities?.loadSession).toBe(false);
  });

  it("prompt runs the team, surfaces aggregate output, ends end_turn", async () => {
    const updates: SessionUpdate[] = [];
    const agent = new AcpTeamAgent(
      recordingConn(updates),
      fakeRunner({ aggregateOutput: "done" }),
      opts,
    );
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(res.stopReason).toBe("end_turn");
    const chunk = updates.find((u) => u.sessionUpdate === "agent_message_chunk") as
      | { content?: { text?: string } }
      | undefined;
    expect(chunk?.content?.text).toBe("done");
  });

  it("maps a cancelled team result to cancelled", async () => {
    const agent = new AcpTeamAgent(
      recordingConn([]),
      fakeRunner({ cancelled: 1, aggregateOutput: undefined }),
      opts,
    );
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    expect(res.stopReason).toBe("cancelled");
  });

  it("refuses a prompt on an unknown session", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    const res = await agent.prompt({ sessionId: "nope", prompt: [] });
    expect(res.stopReason).toBe("refusal");
  });
});
