import { afterEach, describe, expect, it, vi } from "vitest";
import { XaiApiKeyAuth } from "./xai-api-key.js";

describe("XaiApiKeyAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isAuthenticated returns false when XAI_API_KEY is missing", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const auth = new XaiApiKeyAuth();
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated returns true when XAI_API_KEY is set", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    const auth = new XaiApiKeyAuth();
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("headers returns Authorization Bearer with the key", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-my-key");
    const auth = new XaiApiKeyAuth();
    const hdrs = await auth.headers();
    expect(hdrs["Authorization"]).toBe("Bearer xai-my-key");
  });

  it("has correct kind and providerId", () => {
    const auth = new XaiApiKeyAuth();
    expect(auth.kind).toBe("api-key");
    expect(auth.providerId).toBe("xai");
  });
});
