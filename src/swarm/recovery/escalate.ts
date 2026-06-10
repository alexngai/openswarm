/**
 * escalate — surface the conflict for out-of-band resolution: a human, or the
 * OpenHive hub's cascade `resolve` action (docs/44 P8). Pure in P1 — it returns
 * the escalated resolution and the topology emits the surfacing lane event.
 * Awaiting an external `resolve_conflict` + notifying the lead via agent-inbox
 * lands with the hosted path (P8).
 */

import type { ConflictRecoveryStrategy } from "./types.js";

export const escalateStrategy: ConflictRecoveryStrategy = {
  name: "escalate",
  mode: "async",
  async recover() {
    return { kind: "escalated", escalatedTo: "human" };
  },
};
