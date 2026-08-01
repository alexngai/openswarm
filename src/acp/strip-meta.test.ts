/**
 * B1.1 acceptance gate (docs/31 §1/§6): the hard invariant —
 * stripping every `_meta` from a team session's updates must leave a valid,
 * trust-coherent single-agent (baseline) session. Member identity for tool
 * calls lives in the standard `title` field, never in `_meta` alone.
 *
 * Drives the collapsed lane translator through a representative member turn
 * (lead narration + a worker tool call + a plan board) and asserts both the
 * enrichment (present) and the invariant (strip `_meta` ⇒ still coherent).
 */

import { describe, it, expect } from "vitest";
import { makeLaneTranslator } from "./lane-translator.js";
import type { LaneEvent } from "../swarm/events.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

function member(role: string, agentId: string): MemberInfo {
  return {
    memberId: `m-${agentId}`,
    role,
    agentId: agentId as AgentId,
    state: "running",
    handle: {} as MemberInfo["handle"],
  };
}

const L = "L" as AgentId;
const W = "W" as AgentId;
const roster = new Map<AgentId, MemberInfo>([
  [L, member("lead", L)],
  [W, member("architect", W)],
]);

/** Recursively remove every `_meta` key — what a baseline client effectively sees. */
function stripMeta<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripMeta) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "_meta") continue;
      out[k] = stripMeta(v);
    }
    return out as T;
  }
  return value;
}

/** True if `obj` (or any nested value) still mentions swarm enrichment. */
function hasSwarmResidue(obj: unknown): boolean {
  return JSON.stringify(obj).includes('"swarm"');
}

describe("strip-_meta invariant (B1.1)", () => {
  it("every member update stays coherent after _meta is stripped", async () => {
    const updates: SessionUpdate[] = [];
    const conn = {
      sessionUpdate: async (n: { update: SessionUpdate }) => {
        updates.push(n.update);
      },
    };
    const t = makeLaneTranslator(conn, "s1", { getRoster: () => roster });

    // Lead narrates; architect runs a tool; a lifecycle event drives the plan.
    t.onLaneEvent({ ts: 1, agentId: L, type: "text_delta", payload: { type: "text_delta", text: "on it" } });
    t.onLaneEvent({ ts: 2, agentId: W, type: "tool_use_start", payload: { type: "tool_use_start", id: "t1", name: "read_file" } });
    t.onLaneEvent({ ts: 3, agentId: W, type: "tool_use_input", payload: { type: "tool_use_input", id: "t1", jsonDelta: '{"path":"a.ts"}' } });
    t.onLaneEvent({ ts: 4, agentId: W, type: "tool_use_end", payload: { type: "tool_use_end", id: "t1" } });
    t.onLaneEvent({ ts: 5, agentId: W, type: "tool_result", payload: { type: "tool_result", toolUseId: "t1", content: "body", isError: false } });
    t.onLaneEvent({ ts: 6, agentId: W, type: "worker_spawned", payload: {} });
    await t.drain();

    expect(updates.length).toBeGreaterThan(0);

    // Enrichment present somewhere (proves we're testing the real rich path).
    expect(updates.some((u) => hasSwarmResidue(u))).toBe(true);

    for (const u of updates) {
      // SAFETY: member identity for tool calls is in the STANDARD title field.
      if (u.sessionUpdate === "tool_call") {
        expect((u as { title?: string }).title).toMatch(/^\[architect\] /);
      }

      const baseline = stripMeta(u);
      // No swarm enrichment survives the strip — nothing leaks outside `_meta`.
      expect(hasSwarmResidue(baseline)).toBe(false);

      // Each variant remains a valid baseline update after the strip.
      switch (baseline.sessionUpdate) {
        case "agent_message_chunk":
          expect((baseline as { content?: { text?: string } }).content?.text).toBeTypeOf("string");
          break;
        case "tool_call":
          expect((baseline as { toolCallId?: string }).toolCallId).toBeTruthy();
          expect((baseline as { title?: string }).title).toBeTruthy();
          expect((baseline as { kind?: string }).kind).toBeTruthy();
          break;
        case "tool_call_update":
          expect((baseline as { toolCallId?: string }).toolCallId).toBeTruthy();
          expect((baseline as { status?: string }).status).toBeTruthy();
          break;
        case "plan": {
          const entries = (baseline as { entries?: Array<Record<string, unknown>> }).entries ?? [];
          expect(entries.length).toBeGreaterThan(0);
          for (const e of entries) {
            expect(e.content).toBeTruthy();
            expect(e.priority).toBeTruthy();
            expect(e.status).toBeTruthy();
          }
          break;
        }
        default:
          break;
      }
    }
  });
});
