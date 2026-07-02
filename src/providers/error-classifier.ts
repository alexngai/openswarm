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
// represented here. Exported as the single source of truth (Phase 2.3) so the
// codex Responses classifier and any other transport reuse them.
export const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /context[_ ]length/i,
  /context[_ ]window/i,
  /context[_ ]limit/i,
  /max(?:imum)?[_ ]tokens?/i,
  /prompt is too long/i,
  /input[_ ]token[_ ]limit/i,
  /token[_ ]limit[_ ]exceeded/i,
  /string too long/i,
];

export const NETWORK_ERROR_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNABORTED|fetch failed|socket hang up|network error|connection (?:reset|refused|closed)/i;

const PROVIDER_ERROR_CODES: ReadonlySet<ProviderError["code"]> = new Set([
  "transport",
  "rate_limit",
  "provider_unavailable",
  "context_overflow",
  "invalid_request",
  "auth",
  "structured_output_parse_failed",
  "prompt_cache_unavailable",
  "unknown",
]);

/**
 * Canonical HTTP status → ProviderError.code mapping (Phase 2.3). The single
 * table every caller uses so the AI-SDK transports and the codex Responses
 * path can't drift on what a 429 or a 5xx means.
 */
export function httpStatusToProviderCode(status: number): ProviderError["code"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 408 || status === 425 || (status >= 500 && status < 600)) {
    return "provider_unavailable";
  }
  if (status >= 400 && status < 500) return "invalid_request";
  return "unknown";
}

/**
 * Whether an error of this classification is worth retrying. Moved here from
 * `engine/retry-policy.ts` (Phase 2.3) so classification and retryability live
 * together, and reconciled with `classifyProviderError`'s `retryable` field so
 * the two never disagree: `transport`/`rate_limit`/`provider_unavailable`
 * retry; everything else — including the catch-all `unknown` — does not.
 *
 * `unknown` is deliberately non-retryable (matching the field the classifier
 * stamps on it): a completely unrecognized error is not evidence that retrying
 * helps. Callers that WANT unrecognized errors treated as retryable
 * (HardenedNativeEngine at the stream boundary) opt in via
 * `classifyProviderError(err, { fallbackCode: "transport" })`, which yields a
 * `transport` code rather than `unknown`.
 */
export function isRetryableError(error: ProviderError): boolean {
  switch (error.code) {
    case "transport":
    case "rate_limit":
    case "provider_unavailable":
      return true;
    case "unknown":
    case "context_overflow":
    case "invalid_request":
    case "auth":
    case "structured_output_parse_failed":
    case "prompt_cache_unavailable":
      return false;
    default:
      return false;
  }
}

function isProviderErrorShaped(
  raw: unknown,
): raw is { code: ProviderError["code"]; message?: unknown; retryable?: unknown; cause?: unknown } {
  return (
    raw !== null &&
    typeof raw === "object" &&
    "code" in raw &&
    PROVIDER_ERROR_CODES.has((raw as { code: ProviderError["code"] }).code)
  );
}

export interface ClassifyOptions {
  /**
   * Code to assign when the error matches none of the recognized shapes
   * (not abort, not an APICallError, not an already-classified ProviderError,
   * no network-looking message). Defaults to `"unknown"` (non-retryable) for
   * transport callers. HardenedNativeEngine passes `"transport"` so a bare
   * thrown exception at the stream boundary stays a retryable transport
   * failure — the semantics the former engine/retry-policy.ts owned (2.3).
   */
  readonly fallbackCode?: "unknown" | "transport";
}

export function classifyProviderError(raw: unknown, opts?: ClassifyOptions): ProviderError {
  if (isAbortLikeError(raw)) {
    return { code: "transport", message: errorMessage(raw), retryable: false, cause: raw };
  }

  if (APICallError.isInstance(raw)) {
    return classifyAPICallError(raw);
  }

  // Already-classified ProviderError (e.g. a stream error surfaced by a
  // transport and re-thrown into HardenedNativeEngine's catch). Normalize and
  // pass it through — folds in the former engine/retry-policy.ts passthrough
  // (Phase 2.3).
  if (isProviderErrorShaped(raw)) {
    const code = raw.code;
    return {
      code,
      message: typeof raw.message === "string" ? raw.message : errorMessage(raw),
      retryable:
        typeof raw.retryable === "boolean"
          ? raw.retryable
          : isRetryableError({ code, message: "", retryable: false }),
      cause: raw.cause ?? raw,
    };
  }

  const message = errorMessage(raw);
  if (NETWORK_ERROR_PATTERN.test(message)) {
    return { code: "transport", message, retryable: true, cause: raw };
  }

  if (opts?.fallbackCode === "transport") {
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

  const code = httpStatusToProviderCode(status);
  return {
    code,
    message,
    retryable: code === "rate_limit" || code === "provider_unavailable",
    cause: err,
  };
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
