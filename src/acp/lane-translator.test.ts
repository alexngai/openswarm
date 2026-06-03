import { describe, it, expect } from "vitest";
import { makeLaneTranslator } from "./lane-translator.js";
import type { LaneEvent } from "../swarm/events.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function member(
  role: string,
  agentId: string,
  state: MemberInfo["state"] = "running",
): MemberInfo {
  return {
    memberId: `m-${agentId}`,
    role,
    agentId: agentId as AgentId,
    state,
    handle: {} as MemberInfo["handle"],
  };
}

function recorder() {
  const updates: SessionUpdate[] = [];
  const conn = {
    sessionUpdate: async (n: { update: SessionUpdate }) => {
      updates.push(n.update);
    },
  };
  return { conn, updates };
}

const L = "L" as AgentId;
const W = "W" as AgentId;
const roster = new Map<AgentId, MemberInfo>([
  [L, member("lead", L)],
  [W, member("worker", W)],
]);

describe("makeLaneTranslator", () => {
  it("narrates lead text and suppresses member text (collapse)", async () => {
    const { conn, updates } = recorder();
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster });
    t.onLaneEvent({ ts: 1, agentId: L, type: "text_delta", payload: { type: "text_delta", text: "lead says" } });
    t.onLaneEvent({ ts: 2, agentId: W, type: "text_delta", payload: { type: "text_delta", text: "worker says" } });
    await t.drain();
    const texts = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content?: { text?: string } }).content?.text);
    expect(texts).toEqual(["lead says"]);
  });

  it("attributes and id-namespaces member tool calls", async () => {
    const { conn, updates } = recorder();
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster });
    t.onLaneEvent({ ts: 1, agentId: W, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } });
    t.onLaneEvent({ ts: 2, agentId: W, type: "tool_use_input", payload: { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' } });
    t.onLaneEvent({ ts: 3, agentId: W, type: "tool_use_end", payload: { type: "tool_use_end", id: "t1" } });
    t.onLaneEvent({ ts: 4, agentId: W, type: "tool_result", payload: { type: "tool_result", toolUseId: "t1", content: "body", isError: false } });
    await t.drain();

    const call = updates.find((u) => u.sessionUpdate === "tool_call") as { title?: string; toolCallId?: string };
    // tool_call fires at start before input arrives -> generic title, namespaced id.
    expect(call?.title).toBe("[worker] Read file");
    expect(call?.toolCallId).toBe("W:t1");
    const result = updates.find((u) => u.sessionUpdate === "tool_call_update" && (u as { status?: string }).status === "completed") as { toolCallId?: string };
    expect(result?.toolCallId).toBe("W:t1");
  });

  it("preserves wire order across async sends", async () => {
    const { conn, updates } = recorder();
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster });
    for (let i = 0; i < 5; i++) {
      t.onLaneEvent({ ts: i, agentId: L, type: "text_delta", payload: { type: "text_delta", text: String(i) } });
    }
    await t.drain();
    const texts = updates
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content?: { text?: string } }).content?.text);
    expect(texts).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("emits a roster plan on lifecycle, deduped across identical updates", async () => {
    const { conn, updates } = recorder();
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster });
    t.onLaneEvent({ ts: 1, agentId: L, type: "worker_spawned", payload: {} });
    t.onLaneEvent({ ts: 2, agentId: W, type: "worker_ready", payload: {} });
    await t.drain();
    const plans = updates.filter((u) => u.sessionUpdate === "plan");
    expect(plans).toHaveLength(1); // identical roster -> deduped
    expect((plans[0] as { entries?: unknown }).entries).toEqual([
      { content: "lead", priority: "medium", status: "in_progress" },
      { content: "worker", priority: "medium", status: "in_progress" },
    ]);
  });

  it("ignores worker-engine events whose payload isn't a NormalizedEvent", async () => {
    const { conn, updates } = recorder();
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster });
    t.onLaneEvent({ ts: 1, agentId: L, type: "text_delta", payload: null });
    t.onLaneEvent({ ts: 2, agentId: L, type: "text_delta", payload: 42 });
    await t.drain();
    expect(updates).toEqual([]);
  });
});
