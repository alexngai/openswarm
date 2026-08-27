import { describe, it, expect, vi } from "vitest";
import { fetchCodexUsage, formatCodexUsage } from "./openai-codex-usage.js";

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("fetchCodexUsage", () => {
  it("sends auth headers and parses primary + secondary windows + plan", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured = { url, init };
      return ok({
        rate_limit: {
          primary_window: { limit_window_seconds: 10800, used_percent: 42.4, reset_at: 1000 },
          secondary_window: { limit_window_seconds: 604800, used_percent: 12, reset_at: 2000 },
        },
        plan_type: "Plus",
      });
    }) as unknown as typeof fetch;

    const snap = await fetchCodexUsage("tok", "acc", { fetchImpl });
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["chatgpt-account-id"]).toBe("acc");
    expect(snap.plan).toBe("Plus");
    expect(snap.windows).toEqual([
      { label: "3h", usedPercent: 42, resetAt: 1_000_000 },
      { label: "Week", usedPercent: 12, resetAt: 2_000_000 },
    ]);
  });

  it("appends a credit balance to the plan", async () => {
    const fetchImpl = vi.fn(async () => ok({ plan_type: "Pro", credits: { balance: "5" }, rate_limit: {} })) as unknown as typeof fetch;
    expect((await fetchCodexUsage("t", "a", { fetchImpl })).plan).toBe("Pro ($5.00)");
  });

  it("labels a 24h secondary window as Week when the reset cadence is weekly", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        rate_limit: {
          primary_window: { limit_window_seconds: 10800, used_percent: 0, reset_at: 1000 },
          secondary_window: { limit_window_seconds: 86400, used_percent: 5, reset_at: 1000 + 4 * 24 * 3600 },
        },
      }),
    ) as unknown as typeof fetch;
    expect((await fetchCodexUsage("t", "a", { fetchImpl })).windows[1].label).toBe("Week");
  });

  it("labels a 24h secondary window as Day when the reset is near", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({
        rate_limit: {
          primary_window: { limit_window_seconds: 10800, used_percent: 0, reset_at: 1000 },
          secondary_window: { limit_window_seconds: 86400, used_percent: 5, reset_at: 1000 + 3600 },
        },
      }),
    ) as unknown as typeof fetch;
    expect((await fetchCodexUsage("t", "a", { fetchImpl })).windows[1].label).toBe("Day");
  });

  it("preserves a legitimate 0% (no || coercion)", async () => {
    const fetchImpl = vi.fn(async () =>
      ok({ rate_limit: { primary_window: { limit_window_seconds: 10800, used_percent: 0, reset_at: 1 } } }),
    ) as unknown as typeof fetch;
    expect((await fetchCodexUsage("t", "a", { fetchImpl })).windows[0].usedPercent).toBe(0);
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchCodexUsage("t", "a", { fetchImpl })).rejects.toThrow(/401/);
  });
});

describe("formatCodexUsage", () => {
  it("renders plan + windows", () => {
    expect(formatCodexUsage({ plan: "Plus", windows: [{ label: "3h", usedPercent: 42 }, { label: "Week", usedPercent: 12 }] }))
      .toBe("Plus — 3h 42%, Week 12%");
  });
  it("handles no windows", () => {
    expect(formatCodexUsage({ windows: [] })).toBe("no rate-limit windows reported");
  });
});
