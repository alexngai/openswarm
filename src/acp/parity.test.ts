/**
 * Stage A / team parity guard (docs/archive/33 §9). Both prompt paths funnel through
 * emitNormalizedEvent, so for the same engine events the single-agent translator
 * and the team lane translator must emit the SAME standard-field session/updates
 * — the team path adds only enrichment: a `[role]` title prefix, an `agentId:`
 * tool-call-id prefix, and `_meta.swarm`. Strip those and the two must match, so
 * a client renders single and team uniformly (and B1 `_meta` stays additive).
 */

import { describe, it, expect } from "vitest";
import { makeAcpTranslator } from "./translator.js";
import { makeLaneTranslator } from "./lane-translator.js";
import type { NormalizedEvent } from "../core/types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const LEAD = "L" as AgentId;

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

/** Strip the team path's enrichment so the two streams are comparable. */
function canon(u: SessionUpdate): Record<string, unknown> {
  const c = JSON.parse(JSON.stringify(u)) as Record<string, unknown>;
  delete c._meta;
  if (typeof c.toolCallId === "string") {
    c.toolCallId = (c.toolCallId as string).replace(/^L:/, "");
  }
  if (typeof c.title === "string") {
    c.title = (c.title as string).replace(/^\[lead\] /, "");
  }
  return c;
}

// A representative turn: narration + one tool call with a result.
const SEQ: NormalizedEvent[] = [
  { type: "text_delta", text: "working " },
  { type: "tool_use_start", id: "t1", name: "read_file" },
  { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' },
  { type: "tool_use_end", id: "t1" },
  { type: "tool_result", toolUseId: "t1", content: "body", isError: false },
];

describe("Stage A / team session/update parity", () => {
  it("single-agent and team emit identical standard fields (modulo enrichment)", async () => {
    // Single-agent path.
    const single = recorder();
    const t1 = makeAcpTranslator(single.conn, "s1");
    for (const ev of SEQ) await t1.emit(ev);

    // Team path: the lead narrates (text not suppressed), no lifecycle -> no plan.
    const team = recorder();
    const roster = new Map<AgentId, MemberInfo>([
      [LEAD, { memberId: "m-L", role: "lead", agentId: LEAD, state: "running", handle: {} as MemberInfo["handle"] }],
    ]);
    const t2 = makeLaneTranslator(team.conn, "s1", { getRoster: () => roster });
    for (const ev of SEQ) {
      t2.onLaneEvent({ ts: 1, agentId: LEAD, type: ev.type, payload: ev } as LaneEvent);
    }
    await t2.drain();

    // The team path additionally emits a roster-derived `plan` board — a
    // team-only feature, not a per-event parity concern. Compare the rest.
    const a = single.updates.filter((u) => u.sessionUpdate !== "plan").map(canon);
    const b = team.updates.filter((u) => u.sessionUpdate !== "plan").map(canon);
    expect(b).toEqual(a);
    // Sanity: the comparison actually exercised the shared shapes.
    expect(a.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "tool_call_update",
    ]);
  });

  it("team enrichment is purely additive (prefix + _meta present pre-strip)", async () => {
    const team = recorder();
    const roster = new Map<AgentId, MemberInfo>([
      [LEAD, { memberId: "m-L", role: "lead", agentId: LEAD, state: "running", handle: {} as MemberInfo["handle"] }],
    ]);
    const t = makeLaneTranslator(team.conn, "s1", { getRoster: () => roster });
    t.onLaneEvent({ ts: 1, agentId: LEAD, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } });
    await t.drain();
    const call = team.updates.find((u) => u.sessionUpdate === "tool_call") as {
      title?: string;
      toolCallId?: string;
      _meta?: { swarm?: unknown };
    };
    expect(call.title).toMatch(/^\[lead\] /);
    expect(call.toolCallId).toMatch(/^L:/);
    expect(call._meta?.swarm).toBeDefined();
  });
});
