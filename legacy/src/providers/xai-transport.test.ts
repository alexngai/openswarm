/**
 * Tests for XaiTransportProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

import { XaiTransportProvider } from "./xai-transport.js";
import { XaiApiKeyAuth } from "../auth/xai-api-key.js";
import type { ProviderRequest } from "./index.js";
import { streamText } from "ai";

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: "grok-3", ...overrides };
}

async function* asyncIterOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

describe("XaiTransportProvider.create()", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("throws with exact message when XAI_API_KEY is missing", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    const auth = new XaiApiKeyAuth();
    await expect(XaiTransportProvider.create(auth, "grok-3")).rejects.toThrow(
      "error: XaiTransportProvider requires XAI_API_KEY env var. Set it and retry."
    );
  });

  it("returns provider when XAI_API_KEY is set", async () => {
    vi.stubEnv("XAI_API_KEY", "xai-test-key");
    const auth = new XaiApiKeyAuth();
    const provider = await XaiTransportProvider.create(auth, "grok-3");
    expect(provider).toBeInstanceOf(XaiTransportProvider);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("capabilities", () => {
  beforeEach(() => { vi.stubEnv("XAI_API_KEY", "xai-test"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("grok-3 has parallelToolUse true, no reasoning", async () => {
    const auth = new XaiApiKeyAuth();
    const p = await XaiTransportProvider.create(auth, "grok-3");
    expect(p.capabilities.parallelToolUse).toBe(true);
    expect(p.capabilities.reasoning).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(131_072);
    expect(p.capabilities.maxOutputTokens).toBe(64_000);
  });

  it("grok-3-mini has parallelToolUse false, reasoning true", async () => {
    const auth = new XaiApiKeyAuth();
    const p = await XaiTransportProvider.create(auth, "grok-3-mini");
    expect(p.capabilities.parallelToolUse).toBe(false);
    expect(p.capabilities.reasoning).toBe(true);
    expect(p.capabilities.maxContextTokens).toBe(131_072);
  });

  it("id is xai and kind is transport", async () => {
    const auth = new XaiApiKeyAuth();
    const p = await XaiTransportProvider.create(auth, "grok-3");
    expect(p.id).toBe("xai");
    expect(p.kind).toBe("transport");
  });
});

// ---------------------------------------------------------------------------
// Reasoning model quirk — grok-3-mini strips temperature/topP/topK
// ---------------------------------------------------------------------------

describe("reasoning model quirk (grok-3-mini)", () => {
  beforeEach(() => { vi.stubEnv("XAI_API_KEY", "xai-test"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("strips temperature/topP/topK for grok-3-mini", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "thinking..." },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 3, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const auth = new XaiApiKeyAuth();
    const provider = await XaiTransportProvider.create(auth, "grok-3-mini");
    const events = [];
    for await (const e of provider.stream(makeReq({ temperature: 0.7, topP: 0.9, topK: 40 }))) {
      events.push(e);
    }

    const callArgs = (streamText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect("temperature" in callArgs).toBe(false);
    expect("topP" in callArgs).toBe(false);
    expect("topK" in callArgs).toBe(false);
  });

  it("passes temperature/topP/topK for grok-3 (non-reasoning)", async () => {
    const parts = [
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 1, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const auth = new XaiApiKeyAuth();
    const provider = await XaiTransportProvider.create(auth, "grok-3");
    for await (const _ of provider.stream(makeReq({ temperature: 0.5, topP: 0.8, topK: 30 }))) { /* consume */ }

    const callArgs = (streamText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs["temperature"]).toBe(0.5);
    expect(callArgs["topP"]).toBe(0.8);
    expect(callArgs["topK"]).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// stream() — text-delta and finish
// ---------------------------------------------------------------------------

describe("stream()", () => {
  beforeEach(() => { vi.stubEnv("XAI_API_KEY", "xai-test"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it("yields text-delta and finish events", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "Hello" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const auth = new XaiApiKeyAuth();
    const provider = await XaiTransportProvider.create(auth, "grok-3");
    const events = [];
    for await (const e of provider.stream(makeReq())) events.push(e);

    expect(events[0]).toEqual({ type: "text-delta", text: "Hello" });
    expect(events[1]).toMatchObject({ type: "finish", stopReason: "end_turn" });
  });
});
