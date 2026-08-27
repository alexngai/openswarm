/**
 * effective-context.test.ts — the self-calibrated tail estimate (docs/55
 * TE-24) as seen through effectiveContextTokens: the appended-message estimate
 * must use a tokens-per-char ratio derived from the last real usage, not a
 * fixed char/4.
 */
import { describe, it, expect } from "vitest";
import {
  initialCompactionState,
  recordTurnUsage,
  effectiveContextTokens,
} from "./compaction-runner.js";
import { estimateTokens } from "./compactor.js";
import type { ProviderMessage } from "../providers/index.js";

function userText(text: string): ProviderMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("effectiveContextTokens — calibrated tail estimate (TE-24)", () => {
  it("is 0 before any usage is reported (estimator-fallback regime)", () => {
    const state = initialCompactionState();
    expect(effectiveContextTokens(state, [userText("hi")])).toBe(0);
  });

  it("estimates the appended tail with a ratio calibrated from real usage", () => {
    const state = initialCompactionState();
    // Turn 1: two 1000-char messages truly cost 2000 tokens → 1.0 tokens/char
    // (a dense/CJK regime that char/4 would badly under-count).
    const covered = [userText("a".repeat(1_000)), userText("b".repeat(1_000))];
    // recordTurnUsage stamps lastUsageMessageCount = messageCountAtFinish + 1,
    // so the assistant reply the usage describes is covered too. Pass 1 here so
    // the covered high-water mark lands at 2 (both messages above).
    recordTurnUsage(state, { inputTokens: 2_000, outputTokens: 0 }, 1);

    // Turn 2 appends a 400-char tool result / prompt.
    const appended = userText("c".repeat(400));
    const messages = [...covered, appended];

    const effective = effectiveContextTokens(state, messages);
    // Calibrated ratio 1.0 → appended tail ≈ 400*1.0 + 1 = 401, NOT char/4's 101.
    expect(effective).toBe(2_000 + estimateTokens(appended, 1.0));
    expect(effective).toBe(2_401);
    // Prove it diverges from the old fixed char/4 behavior.
    expect(effective).not.toBe(2_000 + estimateTokens(appended));
  });

  it("falls back to char/4 when the calibrated ratio would be absurd", () => {
    const state = initialCompactionState();
    const covered = [userText("a".repeat(1_000))];
    // 40 tokens over 1000 chars = 0.04 < min (0.05) → reject, use default.
    recordTurnUsage(state, { inputTokens: 40, outputTokens: 0 }, 0);
    const appended = userText("c".repeat(400));
    const effective = effectiveContextTokens(state, [...covered, appended]);
    expect(effective).toBe(40 + estimateTokens(appended)); // default char/4
  });
});
