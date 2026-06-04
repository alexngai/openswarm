import { describe, it, expect } from "vitest";
import { RichRenderer } from "./rich-view.js";
import { makeLaneTranslator } from "./lane-translator.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { LaneEvent } from "../swarm/events.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";

function withMeta(u: object, member?: { id: string; name: string; role: string }): SessionUpdate {
  return (member ? { ...u, _meta: { swarm: { v: 1, member } } } : u) as SessionUpdate;
}
const chunk = (text: string, member?: { id: string; name: string; role: string }) =>
  withMeta({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, member);
const toolCall = (
  toolCallId: string,
  title: string,
  member?: { id: string; name: string; role: string },
) => withMeta({ sessionUpdate: "tool_call", toolCallId, title, kind: "read", status: "pending" }, member);
const toolDone = (toolCallId: string, member?: { id: string; name: string; role: string }) =>
  withMeta({ sessionUpdate: "tool_call_update", toolCallId, status: "completed" }, member);

const LEAD = { id: "m-L", name: "lead", role: "lead" };
const ARCH = { id: "m-A", name: "architect", role: "architect" };

describe("RichRenderer", () => {
  it("splits updates into per-member lanes (text + tools + role), first-seen order", () => {
    const r = new RichRenderer();
    r.apply(chunk("on it. ", LEAD));
    r.apply(toolCall("A:t1", "[architect] Read file", ARCH));
    r.apply(chunk("more lead. ", LEAD));
    r.apply(toolDone("A:t1", ARCH));

    const { lanes } = r.view();
    expect(lanes.map((l) => l.memberId)).toEqual(["m-L", "m-A"]); // first-seen
    const lead = lanes.find((l) => l.memberId === "m-L")!;
    expect(lead.role).toBe("lead");
    expect(lead.text).toBe("on it. more lead. ");
    const arch = lanes.find((l) => l.memberId === "m-A")!;
    expect(arch.role).toBe("architect");
    expect(arch.tools).toHaveLength(1);
    // tool_call_update mutated the existing tool in place.
    expect(arch.tools[0]).toMatchObject({ toolCallId: "A:t1", status: "completed" });
  });

  it("builds the task board from plan entries with member linkage", () => {
    const r = new RichRenderer();
    r.apply(
      withMeta({
        sessionUpdate: "plan",
        entries: [
          { content: "lead", priority: "medium", status: "in_progress", _meta: { swarm: { v: 1, member: LEAD } } },
          { content: "architect", priority: "medium", status: "completed", _meta: { swarm: { v: 1, member: ARCH } } },
        ],
      }),
    );
    const view = r.view();
    expect(view.board).toEqual([
      { content: "lead", priority: "medium", status: "in_progress", memberId: "m-L" },
      { content: "architect", priority: "medium", status: "completed", memberId: "m-A" },
    ]);
    // A plan is a board-only update — it must not spawn an (empty) lane.
    expect(view.lanes).toHaveLength(0);
  });

  it("strips to a single lane when _meta is absent (baseline degradation)", () => {
    const r = new RichRenderer();
    r.apply(chunk("hello ")); // no member meta
    r.apply(toolCall("t1", "Read file")); // no member meta
    r.apply(chunk("world"));
    const { lanes } = r.view();
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.memberId).toBe("");
    expect(lanes[0]!.text).toBe("hello world");
    expect(lanes[0]!.tools).toHaveLength(1);
  });

  it("consumes the real lane translator's output into ≥2 lanes (round-trip)", async () => {
    const updates: SessionUpdate[] = [];
    const conn = {
      sessionUpdate: async (n: { update: SessionUpdate }) => {
        updates.push(n.update);
      },
    };
    const L = "L" as AgentId;
    const W = "W" as AgentId;
    const roster = new Map<AgentId, MemberInfo>([
      [L, { memberId: "m-L", role: "lead", agentId: L, state: "running", handle: {} as MemberInfo["handle"] }],
      [W, { memberId: "m-W", role: "architect", agentId: W, state: "running", handle: {} as MemberInfo["handle"] }],
    ]);
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster, memberText: "interleave" });
    t.onLaneEvent({ ts: 1, agentId: L, type: "text_delta", payload: { type: "text_delta", text: "lead voice" } });
    t.onLaneEvent({ ts: 2, agentId: W, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } });
    t.onLaneEvent({ ts: 3, agentId: W, type: "tool_use_end", payload: { type: "tool_use_end", id: "t1" } });
    await t.drain();

    const r = new RichRenderer();
    for (const u of updates) r.apply(u);
    const { lanes } = r.view();
    const roles = lanes.map((l) => l.role).filter(Boolean).sort();
    expect(roles).toEqual(["architect", "lead"]);
    // The architect's tool call landed in the architect lane.
    const arch = lanes.find((l) => l.role === "architect")!;
    expect(arch.tools.length).toBeGreaterThan(0);
    expect(arch.tools[0]!.title).toContain("[architect]");
  });
});
