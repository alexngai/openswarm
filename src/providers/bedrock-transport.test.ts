/**
 * Tests for BedrockTransportProvider (AWS Bedrock open-weight, bearer-token auth).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

import { BedrockTransportProvider } from "./bedrock-transport.js";
import { OpenAICompatApiKeyAuth } from "../auth/openai-compat-api-key.js";
import { resolveProvider } from "./routing.js";
import type { ProviderRequest } from "./index.js";
import { streamText } from "ai";

const LLAMA = "us.meta.llama3-1-8b-instruct-v1:0";
const NOVA = "us.amazon.nova-lite-v1:0";

function makeBedrockAuth() {
  return new OpenAICompatApiKeyAuth("AWS_BEARER_TOKEN_BEDROCK", "bedrock");
}

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: LLAMA, ...overrides };
}

async function* asyncIterOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

const finishPart = {
  type: "finish",
  finishReason: "stop",
  rawFinishReason: "stop",
  totalUsage: { inputTokens: 5, outputTokens: 3, inputTokenDetails: {}, outputTokenDetails: {} },
};

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe("BedrockTransportProvider.create()", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("throws when AWS_BEARER_TOKEN_BEDROCK is missing", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const auth = makeBedrockAuth();
    await expect(BedrockTransportProvider.create(auth, LLAMA)).rejects.toThrow(
      "error: BedrockTransportProvider requires AWS_BEARER_TOKEN_BEDROCK env var. Set it and retry."
    );
  });

  it("returns provider when AWS_BEARER_TOKEN_BEDROCK is set", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-test-token");
    const auth = makeBedrockAuth();
    const provider = await BedrockTransportProvider.create(auth, LLAMA);
    expect(provider).toBeInstanceOf(BedrockTransportProvider);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("capabilities", () => {
  beforeEach(() => { vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-test"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("llama3.1 has parallelToolUse true and ~128K context", async () => {
    const p = await BedrockTransportProvider.create(makeBedrockAuth(), LLAMA);
    expect(p.capabilities.parallelToolUse).toBe(true);
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.vision).toBe(false);
    expect(p.capabilities.reasoning).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(128_000);
    expect(p.capabilities.maxOutputTokens).toBe(4_096);
  });

  it("nova has ~300K context", async () => {
    const p = await BedrockTransportProvider.create(makeBedrockAuth(), NOVA);
    expect(p.capabilities.parallelToolUse).toBe(true);
    expect(p.capabilities.maxContextTokens).toBe(300_000);
    expect(p.capabilities.maxOutputTokens).toBe(4_096);
  });

  it("id is bedrock and kind is transport", async () => {
    const p = await BedrockTransportProvider.create(makeBedrockAuth(), LLAMA);
    expect(p.id).toBe("bedrock");
    expect(p.kind).toBe("transport");
  });
});

// ---------------------------------------------------------------------------
// awsbedrock/ prefix stripping (defense-in-depth)
// ---------------------------------------------------------------------------

describe("modelId prefix stripping", () => {
  beforeEach(() => { vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-test"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("strips awsbedrock/ prefix from modelId before use", async () => {
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf([finishPart]) });

    const p = await BedrockTransportProvider.create(makeBedrockAuth(), `awsbedrock/${LLAMA}`);
    for await (const _ of p.stream(makeReq())) { /* consume */ }

    expect(p.id).toBe("bedrock");
    // Capability lookup still resolves the llama family after stripping.
    expect(p.capabilities.maxContextTokens).toBe(128_000);
    expect((streamText as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Routing resolution
// ---------------------------------------------------------------------------

describe("routing", () => {
  it(`resolves awsbedrock/${LLAMA} to a native bedrock provider (prefix stripped)`, async () => {
    const result = resolveProvider(`awsbedrock/${LLAMA}`);
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(typeof result.authFactory).toBe("function");
    expect(result.modelId).toBe(LLAMA);
    const auth = await result.authFactory!();
    expect(auth.providerId).toBe("bedrock");
  });

  it("does NOT collide with the litellm bedrock/ gateway prefix", () => {
    // bedrock/<id> must still route to the LiteLLM gateway (litellm authFactory),
    // while awsbedrock/<id> routes to the native transport.
    const gw = resolveProvider("bedrock/claude-sonnet-4-6");
    expect(gw.kind).toBe("native");
    expect(gw.modelId).toBe("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------
// stream() basic send
// ---------------------------------------------------------------------------

describe("stream() basic send", () => {
  beforeEach(() => { vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-test"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("yields text-delta and finish for llama3.1", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "Bedrock response" },
      finishPart,
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const p = await BedrockTransportProvider.create(makeBedrockAuth(), LLAMA);
    const events = [];
    for await (const e of p.stream(makeReq())) events.push(e);

    expect(events[0]).toEqual({ type: "text-delta", text: "Bedrock response" });
    expect(events[1]).toMatchObject({ type: "finish", stopReason: "end_turn" });
  });
});
