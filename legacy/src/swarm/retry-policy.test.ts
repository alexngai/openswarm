import { describe, it, expect } from "vitest";
import { planRetry } from "./retry-policy.js";
import type { EscalationPolicy } from "./host.js";

describe("planRetry", () => {
  // 1. kind none → never retry
  it("kind none → shouldRetry false regardless of attempt", () => {
    const policy: EscalationPolicy = { kind: "none" };
    expect(planRetry(policy, 0)).toEqual({ shouldRetry: false, delayMs: 0 });
    expect(planRetry(policy, 5)).toEqual({ shouldRetry: false, delayMs: 0 });
  });

  // 2. kind retry fixed → delays always 250ms until attempt >= max
  it("kind retry fixed → shouldRetry true with delayMs=250 for attempt < max", () => {
    const policy: EscalationPolicy = { kind: "retry", max: 3, backoff: "fixed" };
    expect(planRetry(policy, 0)).toEqual({ shouldRetry: true, delayMs: 250 });
    expect(planRetry(policy, 1)).toEqual({ shouldRetry: true, delayMs: 250 });
    expect(planRetry(policy, 2)).toEqual({ shouldRetry: true, delayMs: 250 });
  });

  // 3. kind retry with attempt === max → shouldRetry false
  it("kind retry fixed → shouldRetry false when attempt >= max", () => {
    const policy: EscalationPolicy = { kind: "retry", max: 3, backoff: "fixed" };
    expect(planRetry(policy, 3)).toEqual({ shouldRetry: false, delayMs: 0 });
    expect(planRetry(policy, 4)).toEqual({ shouldRetry: false, delayMs: 0 });
  });

  // 4. kind retry exponential → 250 / 500 / 1000 / ... progression, capped at 30_000
  it("kind retry exponential → delays follow 250 * 2^attempt progression", () => {
    const policy: EscalationPolicy = { kind: "retry", max: 10, backoff: "exponential" };
    expect(planRetry(policy, 0)).toEqual({ shouldRetry: true, delayMs: 250 });   // 250 * 2^0
    expect(planRetry(policy, 1)).toEqual({ shouldRetry: true, delayMs: 500 });   // 250 * 2^1
    expect(planRetry(policy, 2)).toEqual({ shouldRetry: true, delayMs: 1000 });  // 250 * 2^2
    expect(planRetry(policy, 3)).toEqual({ shouldRetry: true, delayMs: 2000 });  // 250 * 2^3
  });

  it("kind retry exponential → delayMs capped at 30_000", () => {
    const policy: EscalationPolicy = { kind: "retry", max: 20, backoff: "exponential" };
    // 250 * 2^7 = 32000 > 30000
    expect(planRetry(policy, 7)).toEqual({ shouldRetry: true, delayMs: 30_000 });
    expect(planRetry(policy, 10)).toEqual({ shouldRetry: true, delayMs: 30_000 });
  });

  // 5. kind handoff → shouldRetry false
  it("kind handoff → shouldRetry false, delayMs 0", () => {
    const policy: EscalationPolicy = { kind: "handoff", targetRole: "reviewer" };
    expect(planRetry(policy, 0)).toEqual({ shouldRetry: false, delayMs: 0 });
    expect(planRetry(policy, 5)).toEqual({ shouldRetry: false, delayMs: 0 });
  });
});
