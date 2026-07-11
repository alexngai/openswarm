/**
 * budget.ts — token + cost accounting and threshold checking.
 *
 * Pure module — no UI deps, no swarm deps, no side effects.
 * Used by engine event loops (single-agent + swarm) to enforce
 * --max-tokens and --max-cost-usd limits (v0.2.Q7).
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BudgetLimits {
  readonly maxTokens?: number;    // total in + out + cache
  readonly maxCostUsd?: number;   // computed via model-pricing
}

export interface BudgetUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

export interface BudgetCheckResult {
  readonly exceeded: boolean;
  readonly reason?: string;
  readonly usedTokens: number;
  readonly usedCostUsd: number;
}

// ---------------------------------------------------------------------------
// Model pricing table
//
// Prices are per-million-tokens (input, output) in USD.
// As of 2026-04-30 — these drift over time; verify against current pricing
// at https://www.anthropic.com/pricing and https://openai.com/api/pricing
// before relying on them for billing-accurate cost caps.
// ---------------------------------------------------------------------------

export const MODEL_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  // Anthropic (as of 2026-04-30)
  "claude-sonnet-4-6":  { inputPerMTok: 3.00,  outputPerMTok: 15.00 },
  "claude-opus-4-7":    { inputPerMTok: 15.00, outputPerMTok: 75.00 },
  "claude-haiku-4-5":   { inputPerMTok: 0.80,  outputPerMTok: 4.00  },

  // OpenAI (as of 2026-04-30)
  "gpt-4o-2024-11-20":  { inputPerMTok: 2.50,  outputPerMTok: 10.00 },
  "gpt-5-2025-08-07":   { inputPerMTok: 10.00, outputPerMTok: 40.00 },
  "gpt-5.5":            { inputPerMTok: 10.00, outputPerMTok: 40.00 }, // gpt-5 tier

  // Provider-specific ids the cross-provider swarm records verbatim in `byModel`
  // (the spec's model string). `ApiCostModel` keys on `normalizeModelId`, so
  // `azureoai/gpt-5.5` → `gpt-5.5` (above); the Bedrock inference-profile id has no
  // gateway prefix and must match as-is, else `team_usage.costUsd` reads $0 and
  // budget enforcement under-counts real spend (docs/53).
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMTok: 0.80, outputPerMTok: 4.00 },
};

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

/**
 * Check whether cumulative usage has exceeded the given limits.
 *
 * Token check: sums all token categories (input + output + cache read + cache write).
 * Cost check: looks up modelId in MODEL_PRICING; skips if unknown (returns usedCostUsd: 0
 * with no exceed so unknown models are never incorrectly blocked on cost).
 */
export function checkBudget(
  usage: BudgetUsage,
  limits: BudgetLimits,
  modelId: string,
): BudgetCheckResult {
  const usedTokens =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheWriteInputTokens ?? 0);

  // Cost calculation: skip if model is unknown.
  const pricing = MODEL_PRICING[modelId];
  const usedCostUsd =
    pricing !== undefined
      ? (usage.inputTokens * pricing.inputPerMTok +
         usage.outputTokens * pricing.outputPerMTok) /
        1_000_000
      : 0;

  // Token limit check.
  if (limits.maxTokens !== undefined && usedTokens > limits.maxTokens) {
    return {
      exceeded: true,
      reason: `token limit exceeded: used ${usedTokens} / max ${limits.maxTokens}`,
      usedTokens,
      usedCostUsd,
    };
  }

  // Cost limit check (only when model pricing is known).
  if (limits.maxCostUsd !== undefined && pricing !== undefined && usedCostUsd > limits.maxCostUsd) {
    return {
      exceeded: true,
      reason: `cost limit exceeded: used $${usedCostUsd.toFixed(6)} / max $${limits.maxCostUsd}`,
      usedTokens,
      usedCostUsd,
    };
  }

  return { exceeded: false, usedTokens, usedCostUsd };
}

// ---------------------------------------------------------------------------
// usageCostUsd
// ---------------------------------------------------------------------------

/**
 * Compute the USD cost of a single usage sample for a given model.
 *
 * Returns 0 when the model is unknown (undefined or absent from MODEL_PRICING)
 * so callers aggregating across a heterogeneous spawn tree never crash on a
 * member whose model has no pricing entry — the tokens still count, the cost
 * contribution is simply zero. Mirrors the cost branch of `checkBudget` so the
 * two never diverge; extracted so the swarm usage aggregator (issue #17) can
 * price per-member usage without re-implementing the pricing lookup.
 */
export function usageCostUsd(
  usage: BudgetUsage,
  modelId: string | undefined,
): number {
  if (modelId === undefined) return 0;
  const pricing = MODEL_PRICING[modelId];
  if (pricing === undefined) return 0;
  return (
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}
