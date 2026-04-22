/**
 * OpenAI model-family quirks.
 *
 * Centralises detection and parameter normalisation logic so that
 * OpenAITransportProvider stays free of ad-hoc branching.
 */

import type { ProviderRequest } from "./index.js";

// ---------------------------------------------------------------------------
// Model-family detection
// ---------------------------------------------------------------------------

/**
 * Returns true for reasoning models: o1*, o3*, o4*, *-thinking* (case-insensitive).
 * Does NOT match gpt-4o, gpt-5, gpt-3.5.
 */
export function isReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return /^o[134]/.test(id) || id.includes("-thinking");
}

/**
 * Returns true for GPT-5 family: gpt-5-* (case-insensitive).
 * Does NOT match gpt-4.5, gpt-4o, gpt-5o (non-standard).
 */
export function isGpt5(modelId: string): boolean {
  return /^gpt-5-/i.test(modelId);
}

// ---------------------------------------------------------------------------
// Parameter normalisation
// ---------------------------------------------------------------------------

/**
 * Returns the kwargs to spread into streamText() based on the model family.
 *
 * - Reasoning models: drop temperature, topP, topK, presencePenalty, frequencyPenalty.
 *   Keep maxOutputTokens (as-is).
 * - gpt-5*: rename maxOutputTokens → maxCompletionTokens. Keep temperature, topP.
 * - Default: pass through maxOutputTokens, temperature, topP, topK as-is.
 *
 * Only defined fields are included (no undefined keys emitted).
 */
export function normalizeProviderOptions(
  req: ProviderRequest,
  modelId: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (isReasoningModel(modelId)) {
    // Reasoning models: keep only maxOutputTokens
    if (req.maxOutputTokens !== undefined) {
      result["maxOutputTokens"] = req.maxOutputTokens;
    }
  } else if (isGpt5(modelId)) {
    // gpt-5*: rename maxOutputTokens → maxCompletionTokens
    if (req.maxOutputTokens !== undefined) {
      result["maxCompletionTokens"] = req.maxOutputTokens;
    }
    if (req.temperature !== undefined) result["temperature"] = req.temperature;
    if (req.topP !== undefined) result["topP"] = req.topP;
  } else {
    // Default: pass through as-is
    if (req.maxOutputTokens !== undefined) result["maxOutputTokens"] = req.maxOutputTokens;
    if (req.temperature !== undefined) result["temperature"] = req.temperature;
    if (req.topP !== undefined) result["topP"] = req.topP;
    if (req.topK !== undefined) result["topK"] = req.topK;
  }

  return result;
}
