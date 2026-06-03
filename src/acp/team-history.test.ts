import { describe, it, expect } from "vitest";
import {
  replayTeamSpine,
  findLeadAgentId,
  mergeLeadProse,
} from "./team-history.js";
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

describe("findLeadAgentId", () => {
  it("finds the lead from worker_spawned role, or undefined when none", () => {
    const events: LaneEvent[] = [
      { ts: 1, agentId: W, type: "worker_spawned", payload: { childAgentId: W, role: "architect" } },
      { ts: 2, agentId: L, type: "worker_spawned", payload: { childAgentId: L, role: "lead" } },
    ];
    expect(findLeadAgentId(events)).toBe(L);
    expect(findLeadAgentId([events[0]!])).toBeUndefined();
  });
});

describe("mergeLeadProse", () => {
  const spine: LaneEvent[] = [
    { ts: 10, agentId: L, type: "worker_spawned", payload: { childAgentId: L, role: "lead" } },
    { ts: 20, agentId: L, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } },
    { ts: 30, agentId: L, type: "message_stop", payload: { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } },
    { ts: 60, agentId: L, type: "message_stop", payload: { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } } },
  ];

  it("returns a copy of the spine when there is no prose", () => {
    const out = mergeLeadProse(spine, L, []);
    expect(out).toEqual(spine);
    expect(out).not.toBe(spine);
  });

  it("anchors each prose message just before its turn's message_stop", () => {
    const out = mergeLeadProse(spine, L, ["turn one", "turn two"]);
    const prose = out.filter((e) => e.type === "text_delta");
    expect(prose.map((e) => (e.payload as { text: string }).text)).toEqual([
      "turn one",
      "turn two",
    ]);
    // ts = boundary - 1, attributed to the lead.
    expect(prose[0]).toMatchObject({ ts: 29, agentId: L });
    expect(prose[1]).toMatchObject({ ts: 59, agentId: L });
    // Sorted: the first turn's tool call (20) precedes its narration (29) which
    // precedes the turn close (30).
    const order = out.map((e) => e.ts);
    expect(order).toEqual([10, 20, 29, 30, 59, 60]);
  });

  it("pins extra prose to the last boundary; never reorders the spine", () => {
    const out = mergeLeadProse(spine, L, ["a", "b", "c"]);
    const proseTs = out.filter((e) => e.type === "text_delta").map((e) => e.ts);
    expect(proseTs).toEqual([29, 59, 59]); // third pins to the last boundary
    // Spine events keep their relative order.
    const spineTs = out
      .filter((e) => e.type !== "text_delta")
      .map((e) => e.ts);
    expect(spineTs).toEqual([10, 20, 30, 60]);
  });

  it("pins prose to the first spine event when there are no boundaries", () => {
    const noStops: LaneEvent[] = [
      { ts: 5, agentId: L, type: "worker_spawned", payload: { childAgentId: L, role: "lead" } },
    ];
    const out = mergeLeadProse(noStops, L, ["only"]);
    const prose = out.find((e) => e.type === "text_delta");
    expect(prose?.ts).toBe(4); // first spine ts (5) - 1
  });
});
