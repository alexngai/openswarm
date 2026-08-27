/**
 * critic-loop-adapter.test.ts — the compact per-cell audit summary (docs/50 §10.4 step 1).
 * parseCriticLoopSummary is pure over a lane trace; verified end-to-end against a real
 * extracted E2B trace, which read {rounds:2, approvedAtRound:2}.
 */
import { describe, it, expect } from "vitest";
import { parseCriticLoopSummary } from "./critic-loop-adapter.js";

const line = (o: unknown): string => JSON.stringify(o);

describe("parseCriticLoopSummary", () => {
  it("counts executor rounds and reads approvedAtRound from the team_note", () => {
    const trace = [
      line({ type: "team_started", payload: {} }),
      line({ type: "worker_spawned", payload: { role: "executor" } }),
      line({ type: "worker_spawned", payload: { role: "reviewer" } }),
      line({ type: "worker_spawned", payload: { role: "executor" } }),
      line({ type: "worker_spawned", payload: { role: "reviewer" } }),
      line({ type: "team_note", payload: { note: 'critic-loop signal "APPROVED" received from x after iteration 2' } }),
      line({ type: "team_completed", payload: {} }),
    ].join("\n");
    expect(parseCriticLoopSummary(trace)).toEqual({ rounds: 2, approvedAtRound: 2 });
  });

  it("approvedAtRound is null when the critic never approves (hit the cap)", () => {
    const trace = Array.from({ length: 3 }, () => [
      line({ type: "worker_spawned", payload: { role: "executor" } }),
      line({ type: "worker_spawned", payload: { role: "reviewer" } }),
    ].join("\n")).join("\n");
    expect(parseCriticLoopSummary(trace)).toEqual({ rounds: 3, approvedAtRound: null });
  });

  it("keys on event type — a text_delta mentioning 'worker_spawned' is not miscounted", () => {
    const trace = [
      "not json at all",
      line({ type: "text_delta", payload: { text: "worker_spawned executor — APPROVED after iteration 9" } }),
      line({ type: "worker_spawned", payload: { role: "executor" } }),
      line({ type: "worker_spawned", payload: { role: "reviewer" } }),
      line({ type: "team_note", payload: { note: "approved after iteration 1" } }),
    ].join("\n");
    expect(parseCriticLoopSummary(trace)).toEqual({ rounds: 1, approvedAtRound: 1 });
  });
});
