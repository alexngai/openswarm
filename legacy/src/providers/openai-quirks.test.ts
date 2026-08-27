import { describe, expect, it } from "vitest";
import { isReasoningModel, isGpt5, normalizeProviderOptions } from "./openai-quirks.js";
import type { ProviderRequest } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    messages: [],
    model: "gpt-4o",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isReasoningModel
// ---------------------------------------------------------------------------

describe("isReasoningModel", () => {
  it("matches o1-preview", () => expect(isReasoningModel("o1-preview")).toBe(true));
  it("matches o3-mini", () => expect(isReasoningModel("o3-mini")).toBe(true));
  it("matches o4", () => expect(isReasoningModel("o4")).toBe(true));
  it("matches o4-mini", () => expect(isReasoningModel("o4-mini")).toBe(true));
  it("matches gpt-4-thinking-001 (contains -thinking-)", () =>
    expect(isReasoningModel("gpt-4-thinking-001")).toBe(true));
  it("matches UPPER-CASE O3-MINI (case-insensitive)", () =>
    expect(isReasoningModel("O3-MINI")).toBe(true));

  it("does not match gpt-4o", () => expect(isReasoningModel("gpt-4o")).toBe(false));
  it("does not match gpt-5", () => expect(isReasoningModel("gpt-5")).toBe(false));
  it("does not match gpt-3.5-turbo", () => expect(isReasoningModel("gpt-3.5-turbo")).toBe(false));
  it("does not match gpt-5-turbo", () => expect(isReasoningModel("gpt-5-turbo")).toBe(false));
});

// ---------------------------------------------------------------------------
// isGpt5
// ---------------------------------------------------------------------------

describe("isGpt5", () => {
  it("matches bare gpt-5", () => expect(isGpt5("gpt-5")).toBe(true));
  it("matches gpt-5-turbo", () => expect(isGpt5("gpt-5-turbo")).toBe(true));
  it("matches gpt-5-2026-02-01", () => expect(isGpt5("gpt-5-2026-02-01")).toBe(true));
  it("matches GPT-5-turbo (case-insensitive)", () => expect(isGpt5("GPT-5-turbo")).toBe(true));

  it("does not match gpt-4.5", () => expect(isGpt5("gpt-4.5")).toBe(false));
  it("does not match gpt-4o", () => expect(isGpt5("gpt-4o")).toBe(false));
  it("does not match gpt-5o (non-standard)", () => expect(isGpt5("gpt-5o")).toBe(false));
});

// ---------------------------------------------------------------------------
// normalizeProviderOptions
// ---------------------------------------------------------------------------

describe("normalizeProviderOptions", () => {
  describe("reasoning models", () => {
    it("keeps maxOutputTokens", () => {
      const opts = normalizeProviderOptions(
        makeReq({ maxOutputTokens: 2048, temperature: 0.7, topP: 0.9, topK: 40 }),
        "o3-mini"
      );
      expect(opts["maxOutputTokens"]).toBe(2048);
    });

    it("drops temperature", () => {
      const opts = normalizeProviderOptions(
        makeReq({ temperature: 0.7 }),
        "o1-preview"
      );
      expect("temperature" in opts).toBe(false);
    });

    it("drops topP", () => {
      const opts = normalizeProviderOptions(makeReq({ topP: 0.9 }), "o3-mini");
      expect("topP" in opts).toBe(false);
    });

    it("drops topK", () => {
      const opts = normalizeProviderOptions(makeReq({ topK: 40 }), "o4-mini");
      expect("topK" in opts).toBe(false);
    });

    it("does not emit undefined keys when maxOutputTokens not set", () => {
      const opts = normalizeProviderOptions(makeReq({}), "o3-mini");
      expect(Object.values(opts).every((v) => v !== undefined)).toBe(true);
    });
  });

  describe("gpt-5 models", () => {
    it("renames maxOutputTokens to maxCompletionTokens", () => {
      const opts = normalizeProviderOptions(
        makeReq({ maxOutputTokens: 4096 }),
        "gpt-5-turbo"
      );
      expect(opts["maxCompletionTokens"]).toBe(4096);
      expect("maxOutputTokens" in opts).toBe(false);
    });

    it("keeps temperature and topP", () => {
      const opts = normalizeProviderOptions(
        makeReq({ temperature: 0.5, topP: 0.8 }),
        "gpt-5-2026-02-01"
      );
      expect(opts["temperature"]).toBe(0.5);
      expect(opts["topP"]).toBe(0.8);
    });
  });

  describe("default models", () => {
    it("passes through maxOutputTokens, temperature, topP, topK", () => {
      const opts = normalizeProviderOptions(
        makeReq({ maxOutputTokens: 1000, temperature: 0.3, topP: 0.95, topK: 50 }),
        "gpt-4o"
      );
      expect(opts["maxOutputTokens"]).toBe(1000);
      expect(opts["temperature"]).toBe(0.3);
      expect(opts["topP"]).toBe(0.95);
      expect(opts["topK"]).toBe(50);
    });

    it("omits undefined fields", () => {
      const opts = normalizeProviderOptions(makeReq({}), "gpt-4o-mini");
      expect(Object.keys(opts)).toHaveLength(0);
    });
  });
});
