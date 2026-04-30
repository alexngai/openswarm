import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatApiKeyAuth } from "./openai-compat-api-key.js";

describe("OpenAICompatApiKeyAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("isAuthenticated returns false when env var is missing", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "");
    const auth = new OpenAICompatApiKeyAuth("DASHSCOPE_API_KEY", "openai-compat");
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated returns true when env var is set", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "ds-test-key");
    const auth = new OpenAICompatApiKeyAuth("DASHSCOPE_API_KEY", "openai-compat");
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("headers returns Authorization Bearer with the key", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "ds-my-key");
    const auth = new OpenAICompatApiKeyAuth("DASHSCOPE_API_KEY", "openai-compat");
    const hdrs = await auth.headers();
    expect(hdrs["Authorization"]).toBe("Bearer ds-my-key");
  });

  it("has correct kind and supplied providerId", () => {
    const auth = new OpenAICompatApiKeyAuth("DASHSCOPE_API_KEY", "openai-compat");
    expect(auth.kind).toBe("api-key");
    expect(auth.providerId).toBe("openai-compat");
  });

  it("works with a custom env var name and provider id", async () => {
    vi.stubEnv("CUSTOM_API_KEY", "custom-val");
    const auth = new OpenAICompatApiKeyAuth("CUSTOM_API_KEY", "custom-provider");
    expect(await auth.isAuthenticated()).toBe(true);
    const hdrs = await auth.headers();
    expect(hdrs["Authorization"]).toBe("Bearer custom-val");
    expect(auth.providerId).toBe("custom-provider");
  });
});
