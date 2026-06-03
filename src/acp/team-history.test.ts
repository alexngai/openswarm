import { describe, it, expect } from "vitest";
import { replayTeamSpine } from "./team-history.js";
import type { LaneEvent } from "../swarm/events.js";
import type { AgentId } from "../core/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function recorder() {
  const updates: SessionUpdate[] = [];
  return {
    updates,
    conn: {
      sessionUpdate: async (n: { update: SessionUpdate }) => {
        updates.push(n.update);
      },
    },
  };
}

const L = "L" as AgentId;
const W = "W" as AgentId;

describe("replayTeamSpine", () => {
  it("is a no-op on an empty spine", async () => {
    const { conn, updates } = recorder();
    await replayTeamSpine(conn, "s1", []);
    expect(updates).toEqual([]);
  });

  it("re-projects a spine into attributed tool calls + a plan board", async () => {
    const { conn, updates } = recorder();
    const events: LaneEvent[] = [
      { ts: 1, agentId: L, type: "worker_spawned", payload: { childAgentId: L, role: "lead" } },
      { ts: 2, agentId: W, type: "worker_spawned", payload: { childAgentId: W, role: "architect" } },
      { ts: 3, agentId: W, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } },
      { ts: 4, agentId: W, type: "tool_use_end", payload: { type: "tool_use_end", id: "t1" } },
      { ts: 5, agentId: W, type: "tool_result", payload: { type: "tool_result", toolUseId: "t1", content: "body", isError: false } },
    ];
    await replayTeamSpine(conn, "s1", events);

    // Roster reconstructed from worker_spawned -> [architect] attribution + ids.
    const call = updates.find((u) => u.sessionUpdate === "tool_call") as
      | { title?: string; toolCallId?: string }
      | undefined;
    expect(call?.title).toBe("[architect] Read file");
    expect(call?.toolCallId).toBe("W:t1");
    // A plan board was emitted, derived from the reconstructed roster.
    const plan = updates.find((u) => u.sessionUpdate === "plan") as
      | { entries?: Array<{ content?: string }> }
      | undefined;
    expect(plan).toBeDefined();
    const roles = (plan!.entries ?? []).map((e) => e.content).sort();
    expect(roles).toEqual(["architect", "lead"]);
    // Member work carries _meta.swarm (replay uses the same enriched funnel).
    expect(
      (call as { _meta?: { swarm?: { member?: { role?: string } } } })._meta?.swarm
        ?.member?.role,
    ).toBe("architect");
  });
});
