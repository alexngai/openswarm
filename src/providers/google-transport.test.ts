/**
 * Tests for GoogleTransportProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

import { GoogleTransportProvider } from "./google-transport.js";
import { GoogleApiKeyAuth } from "../auth/google-api-key.js";
import type { ProviderRequest } from "./index.js";
import { streamText } from "ai";

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: "gemini-2.0-flash", ...overrides };
}

async function* asyncIterOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe("GoogleTransportProvider.create()", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("throws with exact message when GOOGLE_GENERATIVE_AI_API_KEY is missing", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
    const auth = new GoogleApiKeyAuth();
    await expect(GoogleTransportProvider.create(auth, "gemini-2.0-flash")).rejects.toThrow(
      "error: GoogleTransportProvider requires GOOGLE_GENERATIVE_AI_API_KEY env var. Set it and retry."
    );
  });

  it("returns provider when GOOGLE_GENERATIVE_AI_API_KEY is set", async () => {
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "google-test-key");
    const auth = new GoogleApiKeyAuth();
    const provider = await GoogleTransportProvider.create(auth, "gemini-2.0-flash");
    expect(provider).toBeInstanceOf(GoogleTransportProvider);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("capabilities", () => {
  beforeEach(() => { vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "google-test"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("gemini-2.0-flash has correct capabilities shape", async () => {
    const auth = new GoogleApiKeyAuth();
    const p = await GoogleTransportProvider.create(auth, "gemini-2.0-flash");
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.vision).toBe(true);
    expect(p.capabilities.parallelToolUse).toBe(false); // conservative until live-verified
    expect(p.capabilities.reasoning).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(1_048_576);
    expect(p.capabilities.maxOutputTokens).toBe(8_192);
    expect(p.capabilities.promptCache).toBe(false);
  });

  it("id is google and kind is transport", async () => {
    const auth = new GoogleApiKeyAuth();
    const p = await GoogleTransportProvider.create(auth, "gemini-2.0-flash");
    expect(p.id).toBe("google");
    expect(p.kind).toBe("transport");
  });
});

// ---------------------------------------------------------------------------
// stream() — text-delta and finish
// ---------------------------------------------------------------------------

describe("stream()", () => {
  beforeEach(() => { vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "google-test"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("yields text-delta and finish for gemini-2.0-flash", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "Gemini response" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 8, outputTokens: 4, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const auth = new GoogleApiKeyAuth();
    const provider = await GoogleTransportProvider.create(auth, "gemini-2.0-flash");
    const events = [];
    for await (const e of provider.stream(makeReq())) events.push(e);

    expect(events[0]).toEqual({ type: "text-delta", text: "Gemini response" });
    expect(events[1]).toMatchObject({ type: "finish", stopReason: "end_turn" });
  });

  it("maps tool-calls finish reason", async () => {
    const parts = [
      {
        type: "tool-call",
        toolCallId: "tc-g1",
        toolName: "search",
        input: { query: "test" },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: "tool-calls",
        totalUsage: { inputTokens: 12, outputTokens: 6, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const auth = new GoogleApiKeyAuth();
    const provider = await GoogleTransportProvider.create(auth, "gemini-2.0-flash");
    const events = [];
    for await (const e of provider.stream(makeReq())) events.push(e);

    expect(events[0]).toEqual({ type: "tool-call", id: "tc-g1", name: "search", input: { query: "test" } });
    expect(events[1]).toMatchObject({ type: "finish", stopReason: "tool_use" });
  });
});
