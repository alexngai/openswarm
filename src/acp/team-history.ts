/**
 * Team `session/load` replay (B1.4, docs/34 §5) — re-project a persisted
 * orchestration spine onto ACP `session/update` notifications in wall-clock
 * order. The team analog of Stage A's `history.ts`.
 *
 * Source is the spine `events.jsonl` (B1.3): recorded, attributed `LaneEvent`s.
 * We feed them through the same collapsed lane translator the live path uses,
 * so the replayed transcript renders identically — `[role]`-attributed tool
 * calls + results + a roster-derived plan board, in wall-clock order (Q4).
 *
 * Prose (B1.4 prose replay): the spine omits live-only `text_delta`, so the
 * lead's narration is recovered separately from its SDK session JSONL and woven
 * back in via `mergeLeadProse` — each prior assistant message is synthesized as a
 * lead `text_delta` LaneEvent placed at its turn's `message_stop` boundary, so it
 * replays through the same translator and lands in wall-clock order. Tool
 * *arguments* (live-only `tool_use_input`) remain absent; those stay a known
 * coarseness of spine replay.
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentId, NormalizedEvent } from "../core/types.js";
import type { LaneEvent } from "../swarm/events.js";
import type { MemberInfo } from "../swarm/team-session.js";
import { makeLaneTranslator } from "./lane-translator.js";

/**
 * Reconstruct a roster (agentId → role) from the spine's `worker_spawned`
 * events, which carry `childAgentId` + `role`. The translator needs this for
 * `[role]` attribution and the plan board during replay.
 */
function rosterFromSpine(
  events: readonly LaneEvent[],
): ReadonlyMap<AgentId, MemberInfo> {
  const roster = new Map<AgentId, MemberInfo>();
  for (const e of events) {
    if (e.type !== "worker_spawned") continue;
    const p = e.payload as { childAgentId?: string; role?: string } | undefined;
    const id = p?.childAgentId;
    if (id === undefined || roster.has(id as AgentId)) continue;
    roster.set(id as AgentId, {
      memberId: id,
      role: p?.role ?? "worker",
      agentId: id as AgentId,
      // Replayed members are historical; state only feeds the plan fallback,
      // which the translator overrides from lifecycle events anyway.
      state: "finished",
      handle: undefined as unknown as MemberInfo["handle"],
    });
  }
  return roster;
}

/** The lead's agentId (role "lead" in the spine's worker_spawned events). */
export function findLeadAgentId(
  events: readonly LaneEvent[],
): AgentId | undefined {
  for (const [id, m] of rosterFromSpine(events)) {
    if (m.role === "lead") return id;
  }
  return undefined;
}

/**
 * Weave the lead's prior narration back into the spine. Each assistant message
 * (in order) is synthesized as a lead `text_delta` LaneEvent anchored to the
 * lead's i-th turn boundary (`message_stop`), timestamped just before it so it
 * sorts after that turn's tool activity and before the turn closes. Extra prose
 * (more messages than boundaries) pins to the last boundary; with no boundaries
 * at all, prose pins to the first spine event. Returns a new, ts-sorted list.
 *
 * Approximate by design: the SDK transcript API exposes no per-message
 * timestamps, so we anchor at turn granularity rather than sub-turn. Coherent
 * for the common case (the lead narrates each turn); never reorders the spine
 * itself.
 */
export function mergeLeadProse(
  spine: readonly LaneEvent[],
  leadAgentId: AgentId,
  proseTexts: readonly string[],
): LaneEvent[] {
  if (proseTexts.length === 0) return [...spine];
  const boundaries = spine
    .filter((e) => e.agentId === leadAgentId && e.type === "message_stop")
    .map((e) => e.ts);
  const fallbackTs = spine.length > 0 ? spine[0]!.ts : 0;

  const proseEvents: LaneEvent[] = proseTexts.map((text, i) => {
    const anchor =
      boundaries[i] ?? boundaries[boundaries.length - 1] ?? fallbackTs;
    const payload: NormalizedEvent = { type: "text_delta", text };
    return {
      ts: anchor - 1, // just before the turn's message_stop
      agentId: leadAgentId,
      type: "text_delta",
      payload,
    };
  });

  return [...spine, ...proseEvents]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * Replay a prior team session's spine as `session/update` notifications.
 * Pure w.r.t. the team — depends only on the spine events and the conn.
 */
export async function replayTeamSpine(
  conn: Pick<AgentSideConnection, "sessionUpdate">,
  sessionId: string,
  events: readonly LaneEvent[],
  memberText: "collapse" | "interleave" = "collapse",
): Promise<void> {
  if (events.length === 0) return;
  const roster = rosterFromSpine(events);
  const translator = makeLaneTranslator(conn, sessionId, {
    getRoster: () => roster,
    memberText,
  });
  for (const e of events) translator.onLaneEvent(e);
  await translator.drain();
}
