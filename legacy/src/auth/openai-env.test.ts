import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEnvAuth } from "./openai-env.js";

describe("OpenAIEnvAuth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kind is api-key and providerId is openai", () => {
    const auth = new OpenAIEnvAuth();
    expect(auth.kind).toBe("api-key");
    expect(auth.providerId).toBe("openai");
  });

  it("isAuthenticated() returns true when OPENAI_API_KEY is set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
    const auth = new OpenAIEnvAuth();
    expect(await auth.isAuthenticated()).toBe(true);
  });

  it("isAuthenticated() returns false when OPENAI_API_KEY is empty string", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const auth = new OpenAIEnvAuth();
    expect(await auth.isAuthenticated()).toBe(false);
  });

  it("isAuthenticated() returns false when OPENAI_API_KEY is not set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const auth = new OpenAIEnvAuth();
    expect(await auth.isAuthenticated()).toBe(false);
  });
});
