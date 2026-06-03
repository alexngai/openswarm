import { describe, it, expect } from "vitest";
import { AcpTeamAgent } from "./team-agent.js";
import type { TeamRunner } from "./team-runner.js";
import type { TeamResult } from "../swarm/topologies-types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { TeamSession, MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";
import type { CommonOpts } from "../cli/argv.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const BASE_RESULT: TeamResult = {
  succeeded: 1,
  failed: 0,
  timeout: 0,
  cancelled: 0,
  resultWriteFailures: 0,
  deadLetterViolation: false,
  deadLetterWriteFailures: 0,
};

interface FakeRunnerOpts {
  events?: LaneEvent[];
  roster?: ReadonlyMap<AgentId, MemberInfo>;
  result?: Partial<TeamResult>;
}

function fakeRunner(o: FakeRunnerOpts = {}): TeamRunner {
  let handler: ((e: LaneEvent) => void) | undefined;
  return {
    subscribeEvents: (h) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    runTeam: async () => {
      for (const e of o.events ?? []) handler?.(e);
      return { ...BASE_RESULT, ...o.result };
    },
    getActiveTeam: () =>
      o.roster ? ({ members: o.roster } as unknown as TeamSession) : undefined,
  };
}

function member(role: string, agentId: string): MemberInfo {
  return {
    memberId: `m-${agentId}`,
    role,
    agentId: agentId as AgentId,
    state: "running",
    handle: {} as MemberInfo["handle"],
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

  it("streams lead text and member-attributed tool calls from the lane bus", async () => {
    const lead = "lead-1" as AgentId;
    const worker = "wkr-1" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([
      [lead, member("lead", lead)],
      [worker, member("architect", worker)],
    ]);
    const events: LaneEvent[] = [
      { ts: 1, agentId: lead, type: "text_delta", payload: { type: "text_delta", text: "on it" } },
      { ts: 2, agentId: worker, type: "text_delta", payload: { type: "text_delta", text: "secret worker chatter" } },
      { ts: 3, agentId: worker, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } },
      { ts: 4, agentId: worker, type: "tool_use_input", payload: { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' } },
      { ts: 5, agentId: worker, type: "tool_use_end", payload: { type: "tool_use_end", id: "t1" } },
    ];
    const updates: SessionUpdate[] = [];
    const agent = new AcpTeamAgent(recordingConn(updates), fakeRunner({ events, roster }), opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

    expect(res.stopReason).toBe("end_turn");

    // Lead narrates; the worker's raw text is suppressed (collapse).
    const texts = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content?: { text?: string } }).content?.text);
    expect(texts).toContain("on it");
    expect(texts).not.toContain("secret worker chatter");

    // The worker's tool call surfaces, attributed and id-namespaced.
    const toolCall = updates.find((u) => u.sessionUpdate === "tool_call") as
      | { title?: string; toolCallId?: string; kind?: string }
      | undefined;
    expect(toolCall?.title).toContain("[architect]");
    expect(toolCall?.kind).toBe("read");
    expect(toolCall?.toolCallId).toBe("wkr-1:t1");
  });

  it("emits a roster-derived plan on lifecycle events", async () => {
    const lead = "lead-1" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([[lead, member("lead", lead)]]);
    const events: LaneEvent[] = [
      { ts: 1, agentId: lead, type: "worker_spawned", payload: {} },
    ];
    const updates: SessionUpdate[] = [];
    const agent = new AcpTeamAgent(recordingConn(updates), fakeRunner({ events, roster }), opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

    const plan = updates.find((u) => u.sessionUpdate === "plan") as
      | { entries?: Array<{ content: string; status: string }> }
      | undefined;
    expect(plan?.entries).toEqual([
      { content: "lead", priority: "medium", status: "in_progress" },
    ]);
  });

  it("maps a cancelled team result to cancelled", async () => {
    const agent = new AcpTeamAgent(
      recordingConn([]),
      fakeRunner({ result: { cancelled: 1 } }),
      opts,
    );
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    expect(res.stopReason).toBe("cancelled");
  });

  it("refuses a prompt on an unknown session", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    const res = await agent.prompt({ sessionId: "nope", prompt: [] });
    expect(res.stopReason).toBe("refusal");
  });
});
