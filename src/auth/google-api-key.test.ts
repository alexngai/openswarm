import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleApiKeyAuth } from "./google-api-key.js";

describe("GoogleApiKeyAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isAuthenticated returns false when GOOGLE_GENERATIVE_AI_API_KEY is missing", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const auth = new GoogleApiKeyAuth();
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated returns true when GOOGLE_GENERATIVE_AI_API_KEY is set", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "google-test-key");
    const auth = new GoogleApiKeyAuth();
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("has correct kind and providerId", () => {
    const auth = new GoogleApiKeyAuth();
    expect(auth.kind).toBe("api-key");
    expect(auth.providerId).toBe("google");
  });
});
