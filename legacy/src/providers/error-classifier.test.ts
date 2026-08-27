import { describe, it, expect } from "vitest";
import { APICallError } from "ai";
import {
  classifyProviderError,
  httpStatusToProviderCode,
  isRetryableError,
} from "./error-classifier.js";

function makeAPICallError(opts: {
  message?: string;
  statusCode?: number;
  responseBody?: string;
  isRetryable?: boolean;
}): APICallError {
  return new APICallError({
    message: opts.message ?? "",
    url: "https://example.test/v1/x",
    requestBodyValues: {},
    ...(opts.statusCode !== undefined && { statusCode: opts.statusCode }),
    ...(opts.responseBody !== undefined && { responseBody: opts.responseBody }),
    ...(opts.isRetryable !== undefined && { isRetryable: opts.isRetryable }),
  });
}

describe("classifyProviderError — APICallError status codes", () => {
  it("401 → auth, not retryable", () => {
    const r = classifyProviderError(makeAPICallError({ statusCode: 401, message: "invalid api key" }));
    expect(r.code).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  it("403 → auth, not retryable", () => {
    const r = classifyProviderError(makeAPICallError({ statusCode: 403, message: "forbidden" }));
    expect(r.code).toBe("auth");
    expect(r.retryable).toBe(false);
  });

  it("429 → rate_limit, retryable", () => {
    const r = classifyProviderError(makeAPICallError({ statusCode: 429, message: "rate limited" }));
    expect(r.code).toBe("rate_limit");
    expect(r.retryable).toBe(true);
  });

  it("500 → provider_unavailable, retryable", () => {
    const r = classifyProviderError(makeAPICallError({ statusCode: 500, message: "internal" }));
    expect(r.code).toBe("provider_unavailable");
    expect(r.retryable).toBe(true);
  });

  it("502/503/504 → provider_unavailable, retryable", () => {
    for (const status of [502, 503, 504] as const) {
      const r = classifyProviderError(makeAPICallError({ statusCode: status }));
      expect(r.code).toBe("provider_unavailable");
      expect(r.retryable).toBe(true);
    }
  });

  it("408 → provider_unavailable, retryable (request timeout)", () => {
    const r = classifyProviderError(makeAPICallError({ statusCode: 408 }));
    expect(r.code).toBe("provider_unavailable");
    expect(r.retryable).toBe(true);
  });

  it("404 → invalid_request, not retryable", () => {
    const r = classifyProviderError(makeAPICallError({ statusCode: 404, message: "model not found" }));
    expect(r.code).toBe("invalid_request");
    expect(r.retryable).toBe(false);
  });

  it("400 without context-overflow pattern → invalid_request, not retryable", () => {
    const r = classifyProviderError(
      makeAPICallError({ statusCode: 400, message: "missing required parameter: messages" }),
    );
    expect(r.code).toBe("invalid_request");
    expect(r.retryable).toBe(false);
  });
});

describe("classifyProviderError — context-overflow detection", () => {
  it("400 with 'context length' in body → context_overflow (not invalid_request)", () => {
    const r = classifyProviderError(
      makeAPICallError({
        statusCode: 400,
        message: "Bad Request",
        responseBody:
          '{"error":{"message":"This model\'s maximum context length is 200000 tokens..."}}',
      }),
    );
    expect(r.code).toBe("context_overflow");
    expect(r.retryable).toBe(false);
  });

  it("400 with 'prompt is too long' → context_overflow", () => {
    const r = classifyProviderError(
      makeAPICallError({ statusCode: 400, message: "prompt is too long: 250000 tokens" }),
    );
    expect(r.code).toBe("context_overflow");
  });

  it("400 with 'context_window' in body → context_overflow", () => {
    const r = classifyProviderError(
      makeAPICallError({
        statusCode: 400,
        message: "Bad Request",
        responseBody: '{"error":{"message":"exceeds the context_window of this model"}}',
      }),
    );
    expect(r.code).toBe("context_overflow");
  });

  it("context-overflow detected even on a non-4xx status (some providers return 413)", () => {
    const r = classifyProviderError(
      makeAPICallError({
        statusCode: 413,
        message: "input_token_limit exceeded",
      }),
    );
    expect(r.code).toBe("context_overflow");
  });
});

describe("classifyProviderError — non-API errors", () => {
  it("AbortError → transport, not retryable", () => {
    const err = new Error("Aborted");
    err.name = "AbortError";
    const r = classifyProviderError(err);
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(false);
  });

  it("TimeoutError → transport, not retryable", () => {
    const err = new Error("timeout");
    err.name = "TimeoutError";
    const r = classifyProviderError(err);
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(false);
  });

  it("network-looking message (ECONNRESET) → transport, retryable", () => {
    const err = new Error("read ECONNRESET");
    const r = classifyProviderError(err);
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(true);
  });

  it("network-looking message (fetch failed) → transport, retryable", () => {
    const err = new Error("fetch failed");
    const r = classifyProviderError(err);
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(true);
  });

  it("APICallError without statusCode but network-looking message → transport, retryable", () => {
    const r = classifyProviderError(makeAPICallError({ message: "fetch failed" }));
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(true);
  });

  it("APICallError without statusCode and non-network message → transport, not retryable", () => {
    const r = classifyProviderError(makeAPICallError({ message: "bad json" }));
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(false);
  });

  it("APICallError without statusCode but isRetryable=true → transport, retryable (trust SDK)", () => {
    const r = classifyProviderError(
      makeAPICallError({ message: "transient parse blip", isRetryable: true }),
    );
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(true);
  });

  it("plain object / unknown shape → unknown, not retryable", () => {
    const r = classifyProviderError({ what: "is this" });
    expect(r.code).toBe("unknown");
    expect(r.retryable).toBe(false);
  });

  it("plain string → unknown, not retryable", () => {
    const r = classifyProviderError("something went wrong");
    expect(r.code).toBe("unknown");
    expect(r.retryable).toBe(false);
    expect(r.message).toBe("something went wrong");
  });
});

describe("classifyProviderError — cause propagation", () => {
  it("preserves the original error as cause for downstream debugging", () => {
    const err = makeAPICallError({ statusCode: 429 });
    const r = classifyProviderError(err);
    expect(r.cause).toBe(err);
  });
});

describe("shared core (Phase 2.3)", () => {
  it("httpStatusToProviderCode maps the canonical table", () => {
    expect(httpStatusToProviderCode(401)).toBe("auth");
    expect(httpStatusToProviderCode(403)).toBe("auth");
    expect(httpStatusToProviderCode(429)).toBe("rate_limit");
    expect(httpStatusToProviderCode(408)).toBe("provider_unavailable");
    expect(httpStatusToProviderCode(425)).toBe("provider_unavailable");
    expect(httpStatusToProviderCode(503)).toBe("provider_unavailable");
    expect(httpStatusToProviderCode(404)).toBe("invalid_request");
    expect(httpStatusToProviderCode(302)).toBe("unknown");
  });

  it("isRetryableError retries transport/rate_limit/provider_unavailable only", () => {
    for (const code of ["transport", "rate_limit", "provider_unavailable"] as const) {
      expect(isRetryableError({ code, message: "", retryable: false })).toBe(true);
    }
    // `unknown` is non-retryable — reconciled with the classifier's field so
    // the two never disagree (Phase 2.3 follow-up).
    for (const code of ["unknown", "auth", "invalid_request", "context_overflow"] as const) {
      expect(isRetryableError({ code, message: "", retryable: false })).toBe(false);
    }
  });

  it("passes an already-classified ProviderError through (folds retry-policy passthrough)", () => {
    const r = classifyProviderError({ code: "rate_limit", message: "slow down", retryable: true });
    expect(r.code).toBe("rate_limit");
    expect(r.message).toBe("slow down");
    expect(r.retryable).toBe(true);
  });

  it("fallbackCode: 'transport' makes an unrecognized bare error a retryable transport failure", () => {
    const r = classifyProviderError(new Error("conn refused"), { fallbackCode: "transport" });
    expect(r.code).toBe("transport");
    expect(r.retryable).toBe(true);
    expect(r.message).toBe("conn refused");
  });

  it("default fallback keeps an unrecognized bare error as unknown/non-retryable", () => {
    const r = classifyProviderError(new Error("weird"));
    expect(r.code).toBe("unknown");
    expect(r.retryable).toBe(false);
  });
});
