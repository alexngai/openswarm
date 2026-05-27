import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  INITIAL_LIFECYCLE_STATE,
  type WorkerLifecycleState,
} from "./worker-lifecycle.js";

const ALL_STATES: WorkerLifecycleState[] = [
  "spawning",
  "trust_required",
  "ready_for_prompt",
  "prompt_accepted",
  "running",
  "blocked",
  "idle",
  "draining",
  "drained",
  "finished",
  "failed",
];

describe("isValidTransition", () => {
  it("allows spawning → ready_for_prompt", () => {
    expect(isValidTransition("spawning", "ready_for_prompt")).toBe(true);
  });

  it("allows spawning → failed", () => {
    expect(isValidTransition("spawning", "failed")).toBe(true);
  });

  it("allows running → blocked → running (round-trip)", () => {
    expect(isValidTransition("running", "blocked")).toBe(true);
    expect(isValidTransition("blocked", "running")).toBe(true);
  });

  it("rejects spawning → running (must go through ready_for_prompt)", () => {
    expect(isValidTransition("spawning", "running")).toBe(false);
  });

  it("rejects finished → anything (terminal)", () => {
    for (const state of ALL_STATES) {
      expect(isValidTransition("finished", state)).toBe(false);
    }
  });

  it("rejects failed → anything (terminal)", () => {
    for (const state of ALL_STATES) {
      expect(isValidTransition("failed", state)).toBe(false);
    }
  });

  it("every state's transition list is defined (no missing entries)", () => {
    // isValidTransition must not throw for any from/to combination.
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        expect(() => isValidTransition(from, to)).not.toThrow();
      }
    }
  });

  // -------------------------------------------------------------------------
  // v0.4 stage 4D — long-lived worker transitions
  // -------------------------------------------------------------------------

  it("allows running → idle (long-lived: task completes, worker awaits next prompt)", () => {
    expect(isValidTransition("running", "idle")).toBe(true);
  });

  it("allows idle → prompt_accepted (long-lived: run_more arrives)", () => {
    expect(isValidTransition("idle", "prompt_accepted")).toBe(true);
  });

  it("allows idle → draining (long-lived: drain requested while idle)", () => {
    expect(isValidTransition("idle", "draining")).toBe(true);
  });

  it("allows idle → drained (long-lived: shortcut when drain arrives during idle)", () => {
    expect(isValidTransition("idle", "drained")).toBe(true);
  });

  it("allows draining → drained (long-lived: drain completes after final task)", () => {
    expect(isValidTransition("draining", "drained")).toBe(true);
  });

  it("rejects drained → anything (terminal)", () => {
    for (const state of ALL_STATES) {
      expect(isValidTransition("drained", state)).toBe(false);
    }
  });

  it("rejects running → drained (drain must transit through idle or draining)", () => {
    expect(isValidTransition("running", "drained")).toBe(false);
  });

  it("rejects idle → running (run_more must transit prompt_accepted first)", () => {
    expect(isValidTransition("idle", "running")).toBe(false);
  });

  it("preserves legacy default: running → finished (non-long-lived path)", () => {
    expect(isValidTransition("running", "finished")).toBe(true);
  });
});

describe("INITIAL_LIFECYCLE_STATE", () => {
  it("is 'spawning'", () => {
    expect(INITIAL_LIFECYCLE_STATE).toBe("spawning");
  });
});
