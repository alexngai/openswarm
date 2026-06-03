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
 * Fidelity (honest limits): the spine is the *orchestration* spine, not a full
 * transcript. Live-only deltas (`text_delta`, `tool_use_input`) are not
 * persisted, so replay shows tool names/results + the plan timeline, NOT the
 * lead's prose or tool arguments. Full prose replay + live engine context-resume
 * need the lead's SDK session id persisted — tracked as a follow-on (docs/34).
 */

import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { AgentId } from "../core/types.js";
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
