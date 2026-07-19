/**
 * footer.test.tsx — unit coverage for the footer's cache/cost formatting
 * (docs/55 TE-19/20). Pure-function tests; the composed render is covered
 * by app.test.tsx.
 */

import { describe, it, expect } from "bun:test";
import { formatCost, formatCache } from "./footer.js";
import type { UsageStats } from "../repl/state.js";

function stats(over: Partial<UsageStats> = {}): UsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    turns: 1,
    ...over,
  };
}

describe("formatCost", () => {
  it("shows $0.00 before any usage", () => {
    expect(formatCost(undefined, "claude-sonnet-4-6")).toBe("$0.00");
  });

  it("prices a MODEL_PRICING model including cache traffic", () => {
    // Sonnet: 1M in ($3) + 1M out ($15) + 1M cache read (0.1x = $0.30)
    const s = stats({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    expect(formatCost(s, "claude-sonnet-4-6")).toBe("$18.30");
  });

  it("shows n/a for an unpriced model instead of guessing a rate", () => {
    const s = stats({ inputTokens: 1_000_000 });
    expect(formatCost(s, "deepseek-chat")).toBe("n/a");
  });
});

describe("formatCache", () => {
  it("is empty before any usage or when nothing rode the input side", () => {
    expect(formatCache(undefined)).toBe("");
    expect(formatCache(stats())).toBe("");
  });

  it("reports the running cache-read share of the input side", () => {
    const s = stats({ inputTokens: 2_000, cacheReadInputTokens: 8_000 });
    expect(formatCache(s)).toBe(" · cache: 80%");
  });

  it("annotates the last turn's lane signal when present", () => {
    const s = stats({
      inputTokens: 5_000,
      cacheReadInputTokens: 5_000,
      lastTurnCache: "hit",
    });
    expect(formatCache(s)).toBe(" · cache: 50% (hit)");
  });
});
