/**
 * AI SDK usage → OpenSwarm Usage normalization, shared by every Vercel-AI-SDK
 * transport (openai, azure, litellm, dashscope, xai, google).
 *
 * OpenSwarm's Usage convention (set by the Anthropic/Claude-SDK path) is
 * DISJOINT categories: `inputTokens` counts only non-cached prompt tokens;
 * cache reads/writes ride in their own fields. OpenAI-style APIs instead
 * report `cached_tokens` as a SUBSET of `prompt_tokens` — mapping that total
 * straight into `inputTokens` double-counts cache reads in every
 * `totalTokens` roll-up and overprices cached prompts (docs/53). The AI SDK
 * exposes the non-cached remainder as `inputTokenDetails.noCacheTokens`;
 * fall back to subtracting when only the cached count is present.
 */

import type { Usage } from "../core/types.js";

interface VercelUsageLike {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly inputTokenDetails?:
    | {
        readonly noCacheTokens?: number | undefined;
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
      }
    | undefined;
}

export function mapVercelUsage(usage: VercelUsageLike | undefined): Usage {
  const total = usage?.inputTokens ?? 0;
  const details = usage?.inputTokenDetails;
  const cacheRead = details?.cacheReadTokens;
  const cacheWrite = details?.cacheWriteTokens;
  const nonCached =
    details?.noCacheTokens ??
    (cacheRead !== undefined ? Math.max(0, total - cacheRead) : total);
  return {
    inputTokens: nonCached,
    outputTokens: usage?.outputTokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteInputTokens: cacheWrite } : {}),
  };
}
