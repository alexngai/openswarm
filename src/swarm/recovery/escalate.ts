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
  // Forward-declared "async": in P1 recover() returns synchronously; the real
  // pause-and-await-external-resolution behavior lands at P8 (hosted path). No
  // caller branches on `mode` today, so this labels the future shape rather
  // than a current contract (review note).
  mode: "async",
  async recover() {
    return { kind: "escalated", escalatedTo: "human" };
  },
};
