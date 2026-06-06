/**
 * Retry policy for HardenedNativeEngine stream errors.
 *
 * Maps to Codex's `CodexErr` hierarchy + `is_retryable()` method
 * (responses_retry.rs:22-79).
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

export function isRetryableError(error: ProviderError): boolean {
  switch (error.code) {
    case "transport":
    case "rate_limit":
    case "provider_unavailable":
      return true;
    case "context_overflow":
    case "invalid_request":
    case "auth":
    case "structured_output_parse_failed":
    case "prompt_cache_unavailable":
      return false;
    case "unknown":
      return true;
    default:
      return false;
  }
}

export function classifyProviderError(err: unknown): ProviderError {
  if (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    "message" in err
  ) {
    const e = err as { code?: string; message?: string; retryable?: boolean };
    const code = e.code as ProviderError["code"] | undefined;
    return {
      code: code ?? "unknown",
      message: String(e.message ?? "unknown error"),
      retryable: e.retryable ?? false,
      cause: err,
    };
  }
  return {
    code: "transport",
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
    cause: err,
  };
}
