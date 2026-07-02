import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, streamText: vi.fn() };
});

import {
  LiteLLMTransportProvider,
  liteLLMExtraBodyFromEnv,
  mergeLiteLLMExtraBody,
} from "./litellm-transport";
import type { AuthSource } from "../auth/index.js";
import type { ProviderRequest } from "./index.js";
import { streamText } from "ai";

const authOk: AuthSource = { isAuthenticated: async () => true };
const authNo: AuthSource = { isAuthenticated: async () => false };

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { messages: [], model: "gpt-4.1", ...overrides };
}

async function* asyncIterOf<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

const finishPart = {
  type: "finish",
  finishReason: "tool-calls",
  totalUsage: { inputTokens: 2, outputTokens: 1, inputTokenDetails: {}, outputTokenDetails: {} },
};

describe("LiteLLMTransportProvider.create()", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("throws when LITELLM_BASE_URL is missing", async () => {
    vi.stubEnv("LITELLM_BASE_URL", "");
    await expect(LiteLLMTransportProvider.create(authOk, "gpt-4.1")).rejects.toThrow(
      /requires LITELLM_BASE_URL/,
    );
  });

  it("throws when unauthenticated (no api key)", async () => {
    vi.stubEnv("LITELLM_BASE_URL", "http://127.0.0.1:4000/v1");
    await expect(LiteLLMTransportProvider.create(authNo, "gpt-4.1")).rejects.toThrow(
      /requires LITELLM_API_KEY/,
    );
  });

  it("returns a provider with litellm id + transport kind when configured", async () => {
    vi.stubEnv("LITELLM_BASE_URL", "http://127.0.0.1:4000/v1");
    vi.stubEnv("LITELLM_API_KEY", "sk-litellm");
    const p = await LiteLLMTransportProvider.create(authOk, "gpt-4.1");
    expect(p.id).toBe("litellm");
    expect(p.kind).toBe("transport");
    expect(p.capabilities.streaming).toBe(true);
  });
});

describe("LiteLLMTransportProvider.stream()", () => {
  beforeEach(() => {
    vi.stubEnv("LITELLM_BASE_URL", "http://127.0.0.1:4000/v1");
    vi.stubEnv("LITELLM_API_KEY", "sk-litellm");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("maps text-delta + finish (tool-calls → tool_use) parts", async () => {
    const parts = [
      { type: "text-delta", id: "t1", text: "via gateway" },
      finishPart,
    ];
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({ fullStream: asyncIterOf(parts) });

    const p = await LiteLLMTransportProvider.create(authOk, "gpt-4.1");
    const events = [];
    for await (const e of p.stream(makeReq())) events.push(e);

    expect(events[0]).toEqual({ type: "text-delta", text: "via gateway" });
    expect(events[1]).toMatchObject({ type: "finish", stopReason: "tool_use" });
  });

  it("forwards maxOutputTokens/temperature/topP to streamText", async () => {
    (streamText as ReturnType<typeof vi.fn>).mockReturnValue({
      fullStream: asyncIterOf([finishPart]),
    });
    const p = await LiteLLMTransportProvider.create(authOk, "gpt-4.1");
    for await (const _ of p.stream(makeReq({ maxOutputTokens: 128, temperature: 0.5, topP: 0.9 }))) {
      /* consume */
    }
    const args = (streamText as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(args.maxOutputTokens).toBe(128);
    expect(args.temperature).toBe(0.5);
    expect(args.topP).toBe(0.9);
  });
});

describe("LiteLLMTransportProvider request body extras", () => {
  it("omits extra body when LITELLM_EXTRA_BODY is empty", () => {
    expect(liteLLMExtraBodyFromEnv({})).toBeUndefined();
    expect(liteLLMExtraBodyFromEnv({ LITELLM_EXTRA_BODY: "   " })).toBeUndefined();
  });

  it("parses LITELLM_EXTRA_BODY as a JSON object", () => {
    expect(
      liteLLMExtraBodyFromEnv({
        LITELLM_EXTRA_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
      }),
    ).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("rejects non-object LITELLM_EXTRA_BODY values", () => {
    expect(() => liteLLMExtraBodyFromEnv({ LITELLM_EXTRA_BODY: "[]" })).toThrow(
      "LITELLM_EXTRA_BODY must be a JSON object",
    );
  });

  it("merges extra fields into JSON request bodies", () => {
    const merged = mergeLiteLLMExtraBody(
      '{"model":"qwen","temperature":0}',
      { chat_template_kwargs: { enable_thinking: false } },
    );

    expect(JSON.parse(String(merged))).toEqual({
      model: "qwen",
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});
