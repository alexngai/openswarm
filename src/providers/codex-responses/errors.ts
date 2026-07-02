/**
 * Classify codex Responses HTTP errors into openswarm ProviderErrors.
 *
 * Handles both error body shapes seen live (docs/42):
 *   - model gating: `{ "detail": "The 'gpt-5.4' model is not supported ..." }` (400)
 *   - usage limits: `{ "error": { code, message, plan_type, resets_at } }` (429)
 */

import type { ProviderError } from "../../core/types.js";
import { httpStatusToProviderCode } from "../error-classifier.js";

export interface ClassifiedError {
  readonly error: ProviderError;
  /** Human-facing one-liner when we can produce a better message than `error.message`. */
  readonly friendlyMessage?: string;
}

interface CodexErrorBody {
  detail?: string;
  error?: {
    code?: string;
    type?: string;
    message?: string;
    plan_type?: string;
    resets_at?: number;
  };
}

export function classifyCodexHttpError(
  status: number,
  rawBody: string,
): ClassifiedError {
  let body: CodexErrorBody = {};
  try {
    body = JSON.parse(rawBody) as CodexErrorBody;
  } catch {
    // non-JSON body — fall back to raw text below
  }

  const err = body.error;
  const code = (err?.code ?? err?.type ?? "").toLowerCase();
  const baseMessage = err?.message ?? body.detail ?? (rawBody.slice(0, 300) || "request failed");

  // Usage / rate limits.
  if (status === 429 || /usage_limit_reached|usage_not_included|rate_limit/.test(code)) {
    const plan = err?.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
    const mins =
      err?.resets_at !== undefined
        ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
        : undefined;
    const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
    return {
      error: { code: "rate_limit", message: baseMessage, retryable: true },
      friendlyMessage: `You have hit your ChatGPT usage limit${plan}.${when}`.trim(),
    };
  }

  if (status === 401 || status === 403) {
    return {
      error: { code: "auth", message: baseMessage, retryable: false },
      friendlyMessage: "ChatGPT authentication failed — run `openswarm login --provider openai-codex`.",
    };
  }

  // Everything else maps through the shared status→code table (Phase 2.3):
  // 4xx → invalid_request (model gating and other client errors; the backend's
  // `detail` is the source of truth — plan-dependent allowlist, docs/42 §6.4),
  // 5xx → provider_unavailable, retryable. Kept below the codex-specific
  // usage-limit and auth branches so their friendlier messaging wins.
  const mappedCode = httpStatusToProviderCode(status);
  return {
    error: {
      code: mappedCode,
      message: baseMessage,
      retryable: mappedCode === "provider_unavailable" || mappedCode === "rate_limit",
    },
  };
}
