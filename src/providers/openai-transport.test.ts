/**
 * Tests for OpenAITransportProvider, openai-quirks helpers, and message-replay
 * integrated together.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock streamText before importing the provider
// ---------------------------------------------------------------------------

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { OpenAITransportProvider } from "./openai-transport.js";
import { OpenAIEnvAuth } from "../auth/openai-env.js";
import { isReasoningModel, isGpt5, normalizeProviderOptions } from "./openai-quirks.js";
import { providerMessagesToVercel } from "./message-replay.js";
import type { ProviderRequest, ProviderMessage } from "./index.js";
import { streamText } from "ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: "gpt-4o", ...overrides };
}

/** Create an async iterable from an array of parts. */
async function* asyncIterOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// isReasoningModel
// ---------------------------------------------------------------------------

describe("isReasoningModel", () => {
  it("matches o1-preview", () => expect(isReasoningModel("o1-preview")).toBe(true));
  it("matches o3-mini", () => expect(isReasoningModel("o3-mini")).toBe(true));
  it("matches o4", () => expect(isReasoningModel("o4")).toBe(true));
  it("matches gpt-4-thinking-001", () => expect(isReasoningModel("gpt-4-thinking-001")).toBe(true));

  it("does not match gpt-4o", () => expect(isReasoningModel("gpt-4o")).toBe(false));
  it("does not match gpt-5", () => expect(isReasoningModel("gpt-5")).toBe(false));
  it("does not match gpt-3.5-turbo", () => expect(isReasoningModel("gpt-3.5-turbo")).toBe(false));
});

// ---------------------------------------------------------------------------
// isGpt5
// ---------------------------------------------------------------------------

describe("isGpt5", () => {
  it("matches gpt-5-turbo", () => expect(isGpt5("gpt-5-turbo")).toBe(true));
  it("matches gpt-5-2026-02-01", () => expect(isGpt5("gpt-5-2026-02-01")).toBe(true));

  it("does not match gpt-4.5", () => expect(isGpt5("gpt-4.5")).toBe(false));
  it("does not match gpt-4o", () => expect(isGpt5("gpt-4o")).toBe(false));
  it("does not match gpt-5o (non-standard)", () => expect(isGpt5("gpt-5o")).toBe(false));
});

// ---------------------------------------------------------------------------
// normalizeProviderOptions
// ---------------------------------------------------------------------------

describe("normalizeProviderOptions", () => {
  it("drops temperature/topP/topK for reasoning models", () => {
    const opts = normalizeProviderOptions(
      makeReq({ temperature: 0.7, topP: 0.9, topK: 40, maxOutputTokens: 2048 }),
      "o3-mini"
    );
    expect("temperature" in opts).toBe(false);
    expect("topP" in opts).toBe(false);
    expect("topK" in opts).toBe(false);
    expect(opts["maxOutputTokens"]).toBe(2048);
  });

  it("renames maxOutputTokens to maxCompletionTokens for gpt-5", () => {
    const opts = normalizeProviderOptions(
      makeReq({ maxOutputTokens: 4096, temperature: 0.5 }),
      "gpt-5-turbo"
    );
    expect(opts["maxCompletionTokens"]).toBe(4096);
    expect("maxOutputTokens" in opts).toBe(false);
    expect(opts["temperature"]).toBe(0.5);
  });

  it("passes through all fields for default models", () => {
    const opts = normalizeProviderOptions(
      makeReq({ maxOutputTokens: 1000, temperature: 0.3, topP: 0.95, topK: 50 }),
      "gpt-4o"
    );
    expect(opts["maxOutputTokens"]).toBe(1000);
    expect(opts["temperature"]).toBe(0.3);
    expect(opts["topP"]).toBe(0.95);
    expect(opts["topK"]).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Message replay integration
// ---------------------------------------------------------------------------

describe("providerMessagesToVercel (integration)", () => {
  it("round-trips user message", () => {
    const msgs: ProviderMessage[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("round-trips assistant message", () => {
    const msgs: ProviderMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "I can help." }] },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result[0]).toEqual({ role: "assistant", content: "I can help." });
  });

  it("round-trips tool_use in assistant", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tc-1", name: "bash", input: { command: "ls" } },
        ],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    const msg = result[0] as { role: string; content: unknown[] };
    expect(msg.role).toBe("assistant");
    const call = (msg.content as Array<Record<string, unknown>>).find(
      (c) => c["type"] === "tool-call"
    )!;
    expect(call["toolCallId"]).toBe("tc-1");
    expect(call["toolName"]).toBe("bash");
  });

  it("round-trips tool_result in user after tool_use", () => {
    const msgs: ProviderMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tc-2", name: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tc-2", content: "contents" }],
      },
    ];
    const result = providerMessagesToVercel(msgs);
    expect(result[1]!.role).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// OpenAITransportProvider.create()
// ---------------------------------------------------------------------------

describe("OpenAITransportProvider.create()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws with exact AC-23a message when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const auth = new OpenAIEnvAuth();
    await expect(OpenAITransportProvider.create(auth, "gpt-4o")).rejects.toThrow(
      "error: OpenAITransportProvider requires OPENAI_API_KEY env var. Set it and retry."
    );
  });

  it("returns provider when OPENAI_API_KEY is set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-key");
    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    expect(provider).toBeInstanceOf(OpenAITransportProvider);
  });
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe("capabilities", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gpt-4o has streaming, vision, parallelToolUse, no reasoning", async () => {
    const auth = new OpenAIEnvAuth();
    const p = await OpenAITransportProvider.create(auth, "gpt-4o");
    expect(p.capabilities.streaming).toBe(true);
    expect(p.capabilities.vision).toBe(true);
    expect(p.capabilities.parallelToolUse).toBe(true);
    expect(p.capabilities.reasoning).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(128_000);
  });

  it("o3-mini has reasoning, no vision", async () => {
    const auth = new OpenAIEnvAuth();
    const p = await OpenAITransportProvider.create(auth, "o3-mini");
    expect(p.capabilities.reasoning).toBe(true);
    expect(p.capabilities.vision).toBe(false);
    expect(p.capabilities.maxContextTokens).toBe(200_000);
  });

  it("gpt-5-turbo has larger context, vision", async () => {
    const auth = new OpenAIEnvAuth();
    const p = await OpenAITransportProvider.create(auth, "gpt-5-turbo");
    expect(p.capabilities.maxContextTokens).toBe(400_000);
    expect(p.capabilities.vision).toBe(true);
  });

  it("capabilities.promptCache reports the model's underlying support", async () => {
    // OpenAI Chat Completions auto-caches prompt prefixes for messages
    // >1024 tokens on supported models; the capability flag advertises
    // model support, independent of whether downstream code opts in.
    const auth = new OpenAIEnvAuth();
    const p = await OpenAITransportProvider.create(auth, "gpt-4o");
    expect(p.capabilities.promptCache).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stream() — mocked streamText
// ---------------------------------------------------------------------------

describe("stream()", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("maps text-delta parts to ProviderEvent text-delta", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "Hello " },
      { type: "text-delta", id: "t1", text: "world" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];

    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(parts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    const events = [];
    for await (const event of provider.stream(makeReq())) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "text-delta", text: "Hello " });
    expect(events[1]).toEqual({ type: "text-delta", text: "world" });
    expect(events[2]).toMatchObject({ type: "finish", stopReason: "end_turn" });
  });

  it("maps reasoning-delta parts", async () => {
    const parts = [
      { type: "reasoning-delta", id: "r1", text: "Let me think..." },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 5, outputTokens: 3, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];

    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(parts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "o3-mini");
    const events = [];
    for await (const event of provider.stream(makeReq())) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "reasoning-delta", text: "Let me think..." });
  });

  it("maps tool-call parts", async () => {
    const parts = [
      {
        type: "tool-call",
        toolCallId: "tc-5",
        toolName: "bash",
        input: { command: "pwd" },
      },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: "tool-calls",
        totalUsage: { inputTokens: 20, outputTokens: 8, inputTokenDetails: {}, outputTokenDetails: {} },
      },
    ];

    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(parts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    const events = [];
    for await (const event of provider.stream(makeReq())) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "tool-call",
      id: "tc-5",
      name: "bash",
      input: { command: "pwd" },
    });
    expect(events[1]).toMatchObject({ type: "finish", stopReason: "tool_use" });
  });

  it("classifies a network-like error as transport / retryable", async () => {
    const parts = [
      { type: "error", error: new Error("fetch failed: ECONNRESET") },
    ];

    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(parts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    const events = [];
    for await (const event of provider.stream(makeReq())) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: "error",
      code: "transport",
      retryable: true,
    });
    expect((events[0] as { message: string }).message).toContain("ECONNRESET");
  });

  it("finish event includes usage with inputTokens and outputTokens", async () => {
    const parts = [
      {
        type: "finish",
        finishReason: "length",
        rawFinishReason: "length",
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          inputTokenDetails: { cacheReadTokens: 30 },
          outputTokenDetails: {},
        },
      },
    ];

    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(parts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    const events = [];
    for await (const event of provider.stream(makeReq())) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "finish",
      stopReason: "max_tokens",
      usage: {
        // OpenAI reports cached tokens as a SUBSET of prompt tokens; OpenSwarm's
        // Usage convention is DISJOINT categories (docs/53), so 100 total with
        // 30 cached normalizes to 70 fresh + 30 cache-read.
        inputTokens: 70,
        outputTokens: 50,
        cacheReadInputTokens: 30,
      },
    });
  });

  it("ignores lifecycle parts (start, start-step, finish-step, abort)", async () => {
    const parts = [
      { type: "start" },
      { type: "start-step", request: {}, warnings: [] },
      { type: "text-delta", id: "t1", text: "hi" },
      { type: "finish-step", response: {}, usage: {}, finishReason: "stop", rawFinishReason: "stop", providerMetadata: undefined },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 2, outputTokens: 1, inputTokenDetails: {}, outputTokenDetails: {} },
      },
      { type: "abort" },
    ];

    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(parts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    const events = [];
    for await (const event of provider.stream(makeReq())) {
      events.push(event);
    }

    // Only text-delta and finish should be yielded
    expect(events.map((e) => e.type)).toEqual(["text-delta", "finish"]);
  });
});

// ---------------------------------------------------------------------------
// prompt_cache_key plumbing
// ---------------------------------------------------------------------------

describe("stream() — prompt_cache_key plumbing", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const finishOnlyParts = [
    {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 0, inputTokenDetails: {}, outputTokenDetails: {} },
    },
  ];

  it("forwards req.sessionId as providerOptions.openai.promptCacheKey when capability supports caching", async () => {
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(finishOnlyParts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    for await (const _ of provider.stream(makeReq({ sessionId: "abc-123" }))) {
      void _;
    }

    const call = (streamText as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.providerOptions).toEqual({
      openai: { promptCacheKey: "abc-123" },
    });
  });

  it("omits providerOptions entirely when sessionId is not set", async () => {
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(finishOnlyParts),
    });

    const auth = new OpenAIEnvAuth();
    const provider = await OpenAITransportProvider.create(auth, "gpt-4o");
    for await (const _ of provider.stream(makeReq())) {
      void _;
    }

    const call = (streamText as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.providerOptions).toBeUndefined();
  });

  it("does NOT forward promptCacheKey for a model whose capability disables prompt caching", async () => {
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf(finishOnlyParts),
    });

    const auth = new OpenAIEnvAuth();
    // "not-a-real-model" falls through to UNKNOWN_MODEL_CAPABILITY,
    // which has promptCache=false.
    const provider = await OpenAITransportProvider.create(auth, "not-a-real-model");
    for await (const _ of provider.stream(makeReq({ sessionId: "abc-123" }))) {
      void _;
    }

    const call = (streamText as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.providerOptions).toBeUndefined();
  });
});
