/**
 * Classifies an arbitrary error from a Vercel-AI-SDK-backed transport into a
 * structured `ProviderError`. Replaces the previous "stringify and call it
 * non-retryable" path used by every transport.
 *
 * Decision order:
 *   1. AbortError / TimeoutError    → transport, not retryable
 *   2. APICallError with a statusCode:
 *      - context-overflow patterns in message/body → context_overflow
 *      - 401 / 403                                  → auth
 *      - 429                                        → rate_limit, retryable
 *      - 408 / 425 / 5xx                            → provider_unavailable, retryable
 *      - other 4xx                                  → invalid_request
 *   3. APICallError without a status (network/transport)
 *      → transport, retryable unless SDK said otherwise
 *   4. Anything else with a network-looking message → transport, retryable
 *   5. Fallback                                     → unknown, not retryable
 *
 * Loosely inspired by kimi-code's kosong/src/errors.ts.
 */

import { APICallError } from "ai";
import type { ProviderError } from "../core/types.js";

// Substrings/regexes commonly returned by providers when the prompt blows the
// context window. The most common shapes from each major provider are
// represented here.
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /context[_ ]window/i,
  /context[_ ]limit/i,
  /max(?:imum)?[_ ]tokens?/i,
  /prompt is too long/i,
  /input[_ ]token[_ ]limit/i,
  /token[_ ]limit[_ ]exceeded/i,
  /string too long/i,
];

const NETWORK_ERROR_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNABORTED|fetch failed|socket hang up|network error|connection (?:reset|refused|closed)/i;

export function classifyProviderError(raw: unknown): ProviderError {
  if (isAbortLikeError(raw)) {
    return { code: "transport", message: errorMessage(raw), retryable: false, cause: raw };
  }

  if (APICallError.isInstance(raw)) {
    return classifyAPICallError(raw);
  }

  const message = errorMessage(raw);
  if (NETWORK_ERROR_PATTERN.test(message)) {
    return { code: "transport", message, retryable: true, cause: raw };
  }

  return { code: "unknown", message, retryable: false, cause: raw };
}

function classifyAPICallError(err: APICallError): ProviderError {
  const status = err.statusCode;
  const message = err.message;
  const haystack = `${message}\n${err.responseBody ?? ""}`;

  // Context overflow may surface as a 400 with a specific body; check before
  // the generic 4xx → invalid_request mapping.
  if (CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(haystack))) {
    return { code: "context_overflow", message, retryable: false, cause: err };
  }

  if (status === undefined) {
    // No HTTP status → transport-level. Retry only when the message looks
    // like a recoverable network failure or the SDK explicitly says so;
    // the SDK's default for no-status errors is `isRetryable=false`, but
    // it's a conservative default, not an assertion that retry is wrong.
    const retryable = err.isRetryable === true || NETWORK_ERROR_PATTERN.test(haystack);
    return { code: "transport", message, retryable, cause: err };
  }

  if (status === 401 || status === 403) {
    return { code: "auth", message, retryable: false, cause: err };
  }
  if (status === 429) {
    return { code: "rate_limit", message, retryable: true, cause: err };
  }
  if (status === 408 || status === 425 || (status >= 500 && status < 600)) {
    return { code: "provider_unavailable", message, retryable: true, cause: err };
  }
  if (status >= 400 && status < 500) {
    return { code: "invalid_request", message, retryable: false, cause: err };
  }

  return { code: "unknown", message, retryable: false, cause: err };
}

function isAbortLikeError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
