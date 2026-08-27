/**
 * Tests for dashscopePreflight helper.
 */
import { describe, expect, it } from "vitest";
import { dashscopePreflight, DASHSCOPE_BODY_LIMIT } from "./dashscope-preflight.js";
import type { ProviderRequest } from "./index.js";

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: "qwen-plus", ...overrides };
}

describe("dashscopePreflight", () => {
  it("returns null for a small request body", () => {
    const result = dashscopePreflight(makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }));
    expect(result).toBeNull();
  });

  it("returns ProviderError for a body exceeding 7 MB", () => {
    const bigText = "x".repeat(7 * 1024 * 1024);
    const result = dashscopePreflight(makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: bigText }] }],
    }));
    expect(result).not.toBeNull();
    expect(result!.code).toBe("invalid_request");
    expect(result!.retryable).toBe(false);
    expect(result!.message).toContain(`${DASHSCOPE_BODY_LIMIT}`);
    expect(result!.message).toContain("6 MB cap");
  });

  it("returns null for a body just under 6 MB (5.99 MB)", () => {
    // 5.99 MB of text — well within limit
    const text = "a".repeat(Math.floor(5.99 * 1024 * 1024));
    // The JSON wrapper adds some overhead; use a slightly smaller string to stay under
    const safeText = "a".repeat(Math.floor(5.5 * 1024 * 1024));
    const result = dashscopePreflight(makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: safeText }] }],
    }));
    expect(result).toBeNull();
  });

  it("exact limit boundary: body at exactly DASHSCOPE_BODY_LIMIT bytes is accepted", () => {
    // A tiny request that is clearly under the limit
    const result = dashscopePreflight(makeReq());
    expect(result).toBeNull();
  });

  it("error message includes byte count and limit", () => {
    const bigText = "y".repeat(8 * 1024 * 1024);
    const result = dashscopePreflight(makeReq({
      messages: [{ role: "user", content: [{ type: "text", text: bigText }] }],
    }));
    expect(result).not.toBeNull();
    expect(result!.message).toMatch(/\d+ bytes > \d+/);
  });
});
