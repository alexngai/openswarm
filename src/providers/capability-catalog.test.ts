import { describe, it, expect } from "vitest";
import {
  UNKNOWN_MODEL_CAPABILITY,
  getOpenAIModelCapability,
  getGoogleModelCapability,
  getXaiModelCapability,
  getDashScopeModelCapability,
} from "./capability-catalog.js";

describe("capability catalog — OpenAI", () => {
  it("o-series models are thinking + high context", () => {
    const o1 = getOpenAIModelCapability("o1");
    expect(o1.thinking).toBe(true);
    expect(o1.imageIn).toBe(false);
    expect(o1.maxContextTokens).toBe(200_000);

    const o3mini = getOpenAIModelCapability("o3-mini");
    expect(o3mini.thinking).toBe(true);
    expect(o3mini.parallelToolUse).toBe(true);
  });

  it("gpt-5 is 400K context, image-in, prompt-cache", () => {
    const cap = getOpenAIModelCapability("gpt-5");
    expect(cap.maxContextTokens).toBe(400_000);
    expect(cap.imageIn).toBe(true);
    expect(cap.promptCache).toBe(true);
    expect(cap.thinking).toBe(false);
  });

  it("gpt-4o is multimodal (image + audio)", () => {
    const cap = getOpenAIModelCapability("gpt-4o");
    expect(cap.imageIn).toBe(true);
    expect(cap.audioIn).toBe(true);
    expect(cap.videoIn).toBe(false);
    expect(cap.maxContextTokens).toBe(128_000);
  });

  it("gpt-4o-mini matches gpt-4o family", () => {
    const cap = getOpenAIModelCapability("gpt-4o-mini");
    expect(cap.imageIn).toBe(true);
  });

  it("gpt-4-vision matches the vision row", () => {
    const cap = getOpenAIModelCapability("gpt-4-vision-preview");
    expect(cap.imageIn).toBe(true);
  });

  it("gpt-4 (non-vision) has no image input", () => {
    const cap = getOpenAIModelCapability("gpt-4-turbo");
    expect(cap.imageIn).toBe(false);
    expect(cap.thinking).toBe(false);
  });

  it("o-series matcher does NOT bleed into gpt-* models", () => {
    // Guard against an over-eager regex like /^o/.
    const gpt4o = getOpenAIModelCapability("gpt-4o");
    expect(gpt4o.thinking).toBe(false);
  });

  it("case-insensitive id matching", () => {
    const cap = getOpenAIModelCapability("GPT-4o");
    expect(cap.imageIn).toBe(true);
  });

  it("unknown model returns UNKNOWN_MODEL_CAPABILITY", () => {
    expect(getOpenAIModelCapability("not-a-real-model")).toBe(UNKNOWN_MODEL_CAPABILITY);
  });
});

describe("capability catalog — Google", () => {
  it("gemini-2.5-pro is multimodal, thinking, 2M context", () => {
    const cap = getGoogleModelCapability("gemini-2.5-pro");
    expect(cap.imageIn).toBe(true);
    expect(cap.videoIn).toBe(true);
    expect(cap.audioIn).toBe(true);
    expect(cap.thinking).toBe(true);
    expect(cap.maxContextTokens).toBe(2_097_152);
  });

  it("gemini-2.5-flash uses the generic 2.5 row (1M context)", () => {
    const cap = getGoogleModelCapability("gemini-2.5-flash");
    expect(cap.thinking).toBe(true);
    expect(cap.maxContextTokens).toBe(1_048_576);
  });

  it("gemini-1.5-pro has video in, no thinking, parallel-tools held conservatively off", () => {
    const cap = getGoogleModelCapability("gemini-1.5-pro");
    expect(cap.videoIn).toBe(true);
    expect(cap.thinking).toBe(false);
    expect(cap.parallelToolUse).toBe(false);
  });

  it("unknown gemini still matches the generic row", () => {
    const cap = getGoogleModelCapability("gemini-99.0-experimental");
    expect(cap.imageIn).toBe(true);
    expect(cap.maxContextTokens).toBe(1_048_576);
  });
});

describe("capability catalog — xAI", () => {
  it("grok-3-mini is the reasoning variant", () => {
    const cap = getXaiModelCapability("grok-3-mini");
    expect(cap.thinking).toBe(true);
    expect(cap.parallelToolUse).toBe(false);
  });

  it("grok-4 has bigger context, no thinking", () => {
    const cap = getXaiModelCapability("grok-4");
    expect(cap.thinking).toBe(false);
    expect(cap.parallelToolUse).toBe(true);
    expect(cap.maxContextTokens).toBe(256_000);
  });

  it("grok-2 falls back to the generic grok row", () => {
    const cap = getXaiModelCapability("grok-2");
    expect(cap.parallelToolUse).toBe(true);
    expect(cap.thinking).toBe(false);
  });

  it("unknown model returns UNKNOWN_MODEL_CAPABILITY", () => {
    expect(getXaiModelCapability("not-grok")).toBe(UNKNOWN_MODEL_CAPABILITY);
  });
});

describe("capability catalog — DashScope", () => {
  it("kimi has serial-tools, no prompt cache", () => {
    const cap = getDashScopeModelCapability("kimi-k2-instruct");
    expect(cap.parallelToolUse).toBe(false);
    expect(cap.promptCache).toBe(false);
  });

  it("qwen-plus has parallel tools", () => {
    const cap = getDashScopeModelCapability("qwen-plus");
    expect(cap.parallelToolUse).toBe(true);
  });

  it("qwen3 variants still match", () => {
    const cap = getDashScopeModelCapability("qwen3-235b-a22b-instruct-2507");
    expect(cap.parallelToolUse).toBe(true);
  });
});

describe("UNKNOWN_MODEL_CAPABILITY", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(UNKNOWN_MODEL_CAPABILITY)).toBe(true);
  });

  it("has conservative defaults across the board", () => {
    expect(UNKNOWN_MODEL_CAPABILITY.imageIn).toBe(false);
    expect(UNKNOWN_MODEL_CAPABILITY.thinking).toBe(false);
    expect(UNKNOWN_MODEL_CAPABILITY.parallelToolUse).toBe(false);
    expect(UNKNOWN_MODEL_CAPABILITY.promptCache).toBe(false);
    expect(UNKNOWN_MODEL_CAPABILITY.maxContextTokens).toBe(0);
    expect(UNKNOWN_MODEL_CAPABILITY.maxOutputTokens).toBe(0);
  });
});
