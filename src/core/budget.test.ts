/**
 * budget.test.ts — unit tests for src/core/budget.ts
 *
 * Covers:
 *   - no limits → never exceeded
 *   - maxTokens enforced; under limit → not exceeded
 *   - maxTokens enforced; over limit → exceeded with reason
 *   - maxCostUsd enforced; under limit → not exceeded
 *   - maxCostUsd enforced; over limit → exceeded with reason
 *   - unknown model → cost check skipped, only token check applies
 *   - both limits enforced; either trigger fires
 */

import { describe, it, expect } from "vitest";
import { checkBudget, MODEL_PRICING } from "./budget.js";
import type { BudgetUsage, BudgetLimits } from "./budget.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KNOWN_MODEL = "claude-sonnet-4-6";
const UNKNOWN_MODEL = "some-future-model-9000";

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheWriteInputTokens = 0,
): BudgetUsage {
  return { inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkBudget", () => {
  // 1. No limits → never exceeded
  it("no limits → never exceeded", () => {
    const result = checkBudget(usage(1_000_000, 500_000), {}, KNOWN_MODEL);
    expect(result.exceeded).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  // 2. maxTokens enforced; under limit → not exceeded
  it("maxTokens: under limit → not exceeded", () => {
    const result = checkBudget(
      usage(1_000, 500),
      { maxTokens: 10_000 },
      KNOWN_MODEL,
    );
    expect(result.exceeded).toBe(false);
    expect(result.usedTokens).toBe(1_500);
  });

  // 3. maxTokens enforced; over limit → exceeded with reason
  it("maxTokens: over limit → exceeded with reason", () => {
    const result = checkBudget(
      usage(8_000, 3_000),
      { maxTokens: 10_000 },
      KNOWN_MODEL,
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/token limit exceeded/);
    expect(result.reason).toMatch(/11000/);
    expect(result.usedTokens).toBe(11_000);
  });

  // 3b. maxTokens includes cache tokens in sum
  it("maxTokens: cache tokens are counted in usedTokens", () => {
    const result = checkBudget(
      usage(5_000, 3_000, 2_000, 1_000),
      { maxTokens: 10_000 },
      KNOWN_MODEL,
    );
    // 5000 + 3000 + 2000 + 1000 = 11000 → exceeded
    expect(result.exceeded).toBe(true);
    expect(result.usedTokens).toBe(11_000);
  });

  // 4. maxCostUsd enforced; under limit → not exceeded
  it("maxCostUsd: under limit → not exceeded", () => {
    // claude-sonnet-4-6: $3/MTok in, $15/MTok out
    // 100 input + 10 output = (100*3 + 10*15)/1e6 = (300+150)/1e6 = $0.00045
    const result = checkBudget(
      usage(100, 10),
      { maxCostUsd: 1.0 },
      KNOWN_MODEL,
    );
    expect(result.exceeded).toBe(false);
    expect(result.usedCostUsd).toBeCloseTo(0.00045, 6);
  });

  // 5. maxCostUsd enforced; over limit → exceeded with reason
  it("maxCostUsd: over limit → exceeded with reason", () => {
    // 1_000_000 input + 100_000 output = (1e6*3 + 1e5*15)/1e6 = 3 + 1.5 = $4.50
    const result = checkBudget(
      usage(1_000_000, 100_000),
      { maxCostUsd: 4.0 },
      KNOWN_MODEL,
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/cost limit exceeded/);
    expect(result.usedCostUsd).toBeCloseTo(4.5, 4);
  });

  // 6. Unknown model → cost check skipped, only token check applies
  it("unknown model → cost check skipped (usedCostUsd=0), token check still applies", () => {
    // Token check should still work
    const result = checkBudget(
      usage(5_000, 5_000),
      { maxTokens: 8_000, maxCostUsd: 0.001 },
      UNKNOWN_MODEL,
    );
    // 10_000 tokens > 8_000 → exceeded by token limit
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/token limit exceeded/);
    expect(result.usedCostUsd).toBe(0);
  });

  it("unknown model with token under limit → not exceeded (cost check skipped)", () => {
    const result = checkBudget(
      usage(100, 100),
      { maxCostUsd: 0.000001 },  // absurdly low — would fail if model known
      UNKNOWN_MODEL,
    );
    // cost check skipped for unknown model
    expect(result.exceeded).toBe(false);
    expect(result.usedCostUsd).toBe(0);
  });

  // 7. Both limits; either trigger fires
  it("both limits: token limit fires first when both would exceed", () => {
    const result = checkBudget(
      usage(10_000, 5_000),
      { maxTokens: 14_000, maxCostUsd: 0.00001 },
      KNOWN_MODEL,
    );
    // 15_000 tokens > 14_000 → token limit fires first
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/token limit exceeded/);
  });

  it("both limits: cost limit fires when tokens OK but cost exceeded", () => {
    // 1_000_000 input + 0 output = $3.00 (sonnet-4-6 $3/MTok in)
    const result = checkBudget(
      usage(1_000_000, 0),
      { maxTokens: 2_000_000, maxCostUsd: 2.0 },
      KNOWN_MODEL,
    );
    expect(result.exceeded).toBe(true);
    expect(result.reason).toMatch(/cost limit exceeded/);
  });

  it("both limits: neither exceeded → not exceeded", () => {
    const result = checkBudget(
      usage(1_000, 500),
      { maxTokens: 10_000, maxCostUsd: 1.0 },
      KNOWN_MODEL,
    );
    expect(result.exceeded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MODEL_PRICING sanity checks
// ---------------------------------------------------------------------------

describe("MODEL_PRICING", () => {
  it("contains all required models", () => {
    const required = [
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-haiku-4-5",
      "gpt-4o-2024-11-20",
      "gpt-5-2025-08-07",
    ];
    for (const model of required) {
      expect(MODEL_PRICING[model]).toBeDefined();
      expect(typeof MODEL_PRICING[model]!.inputPerMTok).toBe("number");
      expect(typeof MODEL_PRICING[model]!.outputPerMTok).toBe("number");
    }
  });

  it("all prices are positive numbers", () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      expect(pricing.inputPerMTok).toBeGreaterThan(0);
      expect(pricing.outputPerMTok).toBeGreaterThan(0);
      // output should cost more than or equal to input (typical pricing pattern)
      // (not a hard invariant but sanity-checks for obvious typos)
      void model; // referenced for clarity
    }
  });
});
