import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AcpTeamAgent } from "./team-agent.js";
import { AcpPermissionRouter } from "./team-permission.js";
import { acpEventsPath, acpSessionDir, acpSidecarPath } from "./spine.js";
import { writeSessionSidecar } from "../cli/session-sidecar.js";
import type { TeamRunner } from "./team-runner.js";
import type { TeamResult } from "../swarm/topologies-types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { TeamSession, MemberInfo } from "../swarm/team-session.js";
import type { AgentResult } from "../swarm/host.js";
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

const OK_TURN: AgentResult = {
  status: "success",
  output: "ok",
  usage: { inputTokens: 0, outputTokens: 0 },
  wallClockMs: 1,
};

interface FakeRunnerOpts {
  events?: LaneEvent[];
  roster?: ReadonlyMap<AgentId, MemberInfo>;
  result?: Partial<TeamResult>;
}

function fakeRunner(o: FakeRunnerOpts = {}): TeamRunner {
  let handler: ((e: LaneEvent) => void) | undefined;
  const team = o.roster
    ? ({ members: o.roster, dispose: vi.fn(async () => {}) } as unknown as TeamSession)
    : undefined;
  return {
    subscribeEvents: (h) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    runTeam: vi.fn(async () => {
      for (const e of o.events ?? []) handler?.(e);
      return { ...BASE_RESULT, ...o.result };
    }),
    getActiveTeam: () => team,
  };
}

function member(role: string, agentId: string): MemberInfo {
  return {
    memberId: `m-${agentId}`,
    role,
    agentId: agentId as AgentId,
    state: "running",
    handle: {
      agentId: agentId as AgentId,
      runMore: vi.fn(async () => OK_TURN),
      kill: vi.fn(async () => {}),
      wait: vi.fn(async () => OK_TURN),
    } as unknown as MemberInfo["handle"],
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
  it("initialize advertises loadSession on (team transcript replay, B1.4)", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    const res = await agent.initialize({ protocolVersion: 1 });
    expect(res.agentInfo?.name).toBe("swarm-harness");
    expect(res.agentCapabilities?.loadSession).toBe(true);
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
    const texts = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content?: { text?: string } }).content?.text);
    expect(texts).toContain("on it");
    expect(texts).not.toContain("secret worker chatter");
    const toolCall = updates.find((u) => u.sessionUpdate === "tool_call") as
      | { title?: string; toolCallId?: string; kind?: string }
      | undefined;
    expect(toolCall?.title).toContain("[architect]");
    expect(toolCall?.toolCallId).toBe("wkr-1:t1");
  });

  it("steers the same root via runMore on a subsequent prompt", async () => {
    const lead = "L" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([[lead, member("lead", lead)]]);
    const runner = fakeRunner({ roster });
    const agent = new AcpTeamAgent(recordingConn([]), runner, opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    // First prompt runs the team.
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
    expect(runner.runTeam).toHaveBeenCalledTimes(1);

    // Second prompt steers the captured root — runMore, NOT a second runTeam.
    const handle = roster.get(lead)!.handle as unknown as {
      runMore: ReturnType<typeof vi.fn>;
    };
    const res = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "and now this" }],
    });
    expect(res.stopReason).toBe("end_turn");
    expect(runner.runTeam).toHaveBeenCalledTimes(1); // still once
    expect(handle.runMore).toHaveBeenCalledWith("and now this");
  });

  it("cancel tears down the whole team (root + peers)", async () => {
    const lead = "L" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([[lead, member("lead", lead)]]);
    const runner = fakeRunner({ roster });
    const agent = new AcpTeamAgent(recordingConn([]), runner, opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await agent.cancel({ sessionId });
    // R2: cancel disposes the team rather than killing only the lead, so the
    // peers it spawned can't leak into the next prompt's fresh run.
    const team = runner.getActiveTeam() as unknown as {
      dispose: ReturnType<typeof vi.fn>;
    };
    expect(team.dispose).toHaveBeenCalled();
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
      | { entries?: Array<Record<string, unknown>> }
      | undefined;
    const entries = plan?.entries ?? [];
    // Standard projection (strip _meta → coherent baseline plan).
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      content: "lead",
      priority: "medium",
      status: "in_progress",
    });
    // B1.1: each entry also carries _meta.swarm.member.
    expect(
      (entries[0] as { _meta?: { swarm?: { member?: { name?: string } } } })._meta
        ?.swarm?.member?.name,
    ).toBe("lead");
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

  it("maps a failed steered turn to refusal but keeps the root", async () => {
    const lead = "L" as AgentId;
    const m = member("lead", lead);
    const runMore = m.handle.runMore as unknown as ReturnType<typeof vi.fn>;
    // First prompt uses runTeam; the first runMore call is the second prompt.
    runMore.mockResolvedValueOnce({
      status: "failure",
      error: "boom",
      usage: { inputTokens: 0, outputTokens: 0 },
      wallClockMs: 1,
    } as AgentResult);
    const roster = new Map<AgentId, MemberInfo>([[lead, m]]);
    const runner = fakeRunner({ roster });
    const agent = new AcpTeamAgent(recordingConn([]), runner, opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
    const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] });
    expect(res.stopReason).toBe("refusal");
    // A failed (not killed) turn leaves the long-lived root alive — still steered.
    expect(runner.runTeam).toHaveBeenCalledTimes(1);
  });

  it("drops the root and refuses when runMore rejects, respawning next turn", async () => {
    const lead = "L" as AgentId;
    const m = member("lead", lead);
    const runMore = m.handle.runMore as unknown as ReturnType<typeof vi.fn>;
    // First prompt uses runTeam; make the first runMore (second prompt) reject.
    runMore.mockRejectedValueOnce(new Error("root died"));
    const roster = new Map<AgentId, MemberInfo>([[lead, m]]);
    const runner = fakeRunner({ roster });
    const agent = new AcpTeamAgent(recordingConn([]), runner, opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });
    const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] });
    expect(res.stopReason).toBe("refusal");
    // The dropped handle forces the next prompt back through runTeam.
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "third" }] });
    expect(runner.runTeam).toHaveBeenCalledTimes(2);
  });

  it("binds the permission router to the session for the connection lifetime", async () => {
    const router = new AcpPermissionRouter();
    const spy = vi.spyOn(router, "setActiveSession");
    const lead = "L" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([[lead, member("lead", lead)]]);
    const agent = new AcpTeamAgent(
      recordingConn([]),
      fakeRunner({ roster }),
      opts,
      router,
    );
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    // Bound once at newSession (not per-prompt)...
    expect(spy).toHaveBeenCalledWith(sessionId);
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    // ...and never cleared after a prompt — peers can outlive the turn and must
    // still be able to escalate (root-only quiescence, R-b).
    expect(spy).not.toHaveBeenCalledWith(undefined);
  });

  it("threads the ACP session cwd into the coordinator spec", async () => {
    const runner = fakeRunner();
    const agent = new AcpTeamAgent(recordingConn([]), runner, opts);
    const { sessionId } = await agent.newSession({
      cwd: "/work/project",
      mcpServers: [],
    });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    const spec = (runner.runTeam as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(spec.members[0].cwd).toBe("/work/project");
  });

  it("drains non-lead peers before resolving a prompt (subtree quiescence, Q1)", async () => {
    const lead = "L" as AgentId;
    const peer = "P" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([
      [lead, member("lead", lead)],
      [peer, member("worker", peer)],
    ]);
    const runner = fakeRunner({ roster });
    const agent = new AcpTeamAgent(recordingConn([]), runner, opts);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });
    // The peer's wait() was awaited; the lead's (long-lived) was not.
    const peerWait = roster.get(peer)!.handle.wait as ReturnType<typeof vi.fn>;
    const leadWait = roster.get(lead)!.handle.wait as ReturnType<typeof vi.fn>;
    expect(peerWait).toHaveBeenCalled();
    expect(leadWait).not.toHaveBeenCalled();
  });

  it("rejects a second session (single shared team per connection, R1)", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(
      agent.newSession({ cwd: "/tmp", mcpServers: [] }),
    ).rejects.toThrow(/single session/i);
  });

  it("loadSession replays the persisted spine and registers the session (B1.4)", async () => {
    const sessionId = randomUUID();
    const dir = acpSessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const w = "wkr" as AgentId;
    const lines = [
      JSON.stringify({ type: "_metadata", protocol_version: "1.0", created_at: 1 }),
      JSON.stringify({ ts: 1, agentId: w, type: "worker_spawned", payload: { childAgentId: w, role: "architect" } }),
      JSON.stringify({ ts: 2, agentId: w, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } }),
      JSON.stringify({ ts: 3, agentId: w, type: "tool_use_end", payload: { type: "tool_use_end", id: "t1" } }),
    ];
    fs.writeFileSync(acpEventsPath(sessionId), lines.join("\n") + "\n");
    try {
      const updates: SessionUpdate[] = [];
      const agent = new AcpTeamAgent(recordingConn(updates), fakeRunner(), opts);
      const res = await agent.loadSession({ sessionId, cwd: "/tmp", mcpServers: [] });
      expect(res).toEqual({});
      // The spine's tool call was re-projected, attributed from the roster.
      const call = updates.find((u) => u.sessionUpdate === "tool_call") as
        | { title?: string }
        | undefined;
      expect(call?.title).toBe("[architect] Read file");
      // The session is registered -> a continuing prompt isn't refused.
      const pr = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] });
      expect(pr.stopReason).not.toBe("refusal");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadSession also enforces the single-session binding (R1)", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    await agent.newSession({ cwd: "/tmp", mcpServers: [] });
    await expect(
      agent.loadSession({ sessionId: randomUUID(), cwd: "/tmp", mcpServers: [] }),
    ).rejects.toThrow(/single session/i);
  });

  it("loadSession weaves the lead's prior narration into the replay (B1.4 prose)", async () => {
    const sessionId = randomUUID();
    const dir = acpSessionDir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const lead = "lead-1";
    // Spine: a lead with one turn boundary.
    fs.writeFileSync(
      acpEventsPath(sessionId),
      [
        JSON.stringify({ type: "_metadata", protocol_version: "1.0", created_at: 1 }),
        JSON.stringify({ ts: 1, agentId: lead, type: "worker_spawned", payload: { childAgentId: lead, role: "lead" } }),
        JSON.stringify({ ts: 10, agentId: lead, type: "message_stop", payload: { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } }),
      ].join("\n") + "\n",
    );
    // The sidecar makes the lead session id available for prose lookup.
    writeSessionSidecar(acpSidecarPath(sessionId), "lead-sess");
    try {
      const updates: SessionUpdate[] = [];
      // Inject the prose reader so no real SDK transcript is needed.
      const agent = new AcpTeamAgent(
        recordingConn(updates),
        fakeRunner(),
        opts,
        undefined,
        undefined,
        async () => ["hello from the lead"],
      );
      await agent.loadSession({ sessionId, cwd: "/tmp", mcpServers: [] });
      const chunk = updates.find(
        (u) => u.sessionUpdate === "agent_message_chunk",
      ) as { content?: { text?: string } } | undefined;
      expect(chunk?.content?.text).toBe("hello from the lead");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a prompt on an unknown session", async () => {
    const agent = new AcpTeamAgent(recordingConn([]), fakeRunner(), opts);
    const res = await agent.prompt({ sessionId: "nope", prompt: [] });
    expect(res.stopReason).toBe("refusal");
  });
});
