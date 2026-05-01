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
});

describe("INITIAL_LIFECYCLE_STATE", () => {
  it("is 'spawning'", () => {
    expect(INITIAL_LIFECYCLE_STATE).toBe("spawning");
  });
});
