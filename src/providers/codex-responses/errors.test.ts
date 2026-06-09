import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyCodexHttpError } from "./errors.js";

afterEach(() => vi.useRealTimers());

describe("classifyCodexHttpError", () => {
  it("classifies the model-gating 400 (detail shape) as invalid_request, non-retryable", () => {
    const c = classifyCodexHttpError(
      400,
      JSON.stringify({ detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account." }),
    );
    expect(c.error.code).toBe("invalid_request");
    expect(c.error.retryable).toBe(false);
    expect(c.error.message).toContain("not supported");
  });

  it("classifies a 429 usage limit as rate_limit with a friendly reset ETA", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T00:00:00Z"));
    const resetsAt = Math.floor(Date.parse("2026-06-07T00:30:00Z") / 1000);
    const c = classifyCodexHttpError(
      429,
      JSON.stringify({ error: { code: "usage_limit_reached", message: "limit", plan_type: "Plus", resets_at: resetsAt } }),
    );
    expect(c.error.code).toBe("rate_limit");
    expect(c.error.retryable).toBe(true);
    expect(c.friendlyMessage).toBe("You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.");
  });

  it("classifies 401/403 as auth with a login hint", () => {
    const c = classifyCodexHttpError(401, "");
    expect(c.error.code).toBe("auth");
    expect(c.error.retryable).toBe(false);
    expect(c.friendlyMessage).toContain("login --provider openai-codex");
  });

  it("classifies 5xx as provider_unavailable, retryable", () => {
    const c = classifyCodexHttpError(503, "upstream down");
    expect(c.error.code).toBe("provider_unavailable");
    expect(c.error.retryable).toBe(true);
  });

  it("tolerates a non-JSON body", () => {
    const c = classifyCodexHttpError(400, "<html>nope</html>");
    expect(c.error.code).toBe("invalid_request");
    expect(c.error.message).toContain("nope");
  });

  it("classifies a usage-limit code even without a 429 status", () => {
    const c = classifyCodexHttpError(403, JSON.stringify({ error: { code: "usage_limit_reached", message: "no" } }));
    expect(c.error.code).toBe("rate_limit");
    expect(c.error.retryable).toBe(true);
  });

  it("clamps a past resets_at to ~0 min (no negative ETA)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T00:00:00Z"));
    const pastReset = Math.floor(Date.parse("2026-06-06T23:00:00Z") / 1000);
    const c = classifyCodexHttpError(429, JSON.stringify({ error: { code: "rate_limit_exceeded", resets_at: pastReset } }));
    expect(c.friendlyMessage).toContain("~0 min");
    expect(c.friendlyMessage).not.toContain("-");
  });

  it("omits plan and ETA when absent", () => {
    const c = classifyCodexHttpError(429, JSON.stringify({ error: { code: "rate_limit_exceeded" } }));
    expect(c.friendlyMessage).toBe("You have hit your ChatGPT usage limit.");
  });
});
