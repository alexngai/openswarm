/**
 * Retry policy for HardenedNativeEngine stream errors.
 *
 * Maps to Codex's `CodexErr` hierarchy + `is_retryable()` method
 * (responses_retry.rs:22-79).
 *
 * Error *classification* (`classifyProviderError`, `isRetryableError`) now lives
 * in `../providers/error-classifier.ts` — the single classifier for the whole
 * codebase (Phase 2.3). This module only owns the retry *policy* knobs.
 */

import type { ProviderError } from "../core/types.js";

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly backoffBaseMs: number;
  readonly isRetryable?: (error: ProviderError) => boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffBaseMs: 100,
};
