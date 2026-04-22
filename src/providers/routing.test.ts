import { describe, it, expect } from "vitest";
import { resolveProvider } from "./routing.js";

describe("resolveProvider", () => {
  it('claude-sonnet-4-6 → kind "sdk" with engineFactory and modelId preserved', () => {
    const result = resolveProvider("claude-sonnet-4-6");
    expect(result.kind).toBe("sdk");
    expect(typeof result.engineFactory).toBe("function");
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.providerFactory).toBeUndefined();
  });

  it('gpt-4o → kind "native" with providerFactory and modelId "gpt-4o"', () => {
    const result = resolveProvider("gpt-4o");
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(result.modelId).toBe("gpt-4o");
  });

  it('openai/gpt-4o-mini → kind "native" with modelId "gpt-4o-mini" (prefix stripped)', () => {
    const result = resolveProvider("openai/gpt-4o-mini");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("gpt-4o-mini");
    expect(typeof result.providerFactory).toBe("function");
  });

  it('o3-mini-2025-01-31 → kind "native"', () => {
    const result = resolveProvider("o3-mini-2025-01-31");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("o3-mini-2025-01-31");
  });

  it('o4-preview → kind "native"', () => {
    const result = resolveProvider("o4-preview");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("o4-preview");
  });

  it('grok-3 → kind "error" with message mentioning M4b', () => {
    const result = resolveProvider("grok-3");
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/M4b/);
  });

  it('gemini-2.0-pro → kind "error" with message mentioning M4b', () => {
    const result = resolveProvider("gemini-2.0-pro");
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/M4b/);
  });

  it('qwen-max → kind "error"', () => {
    const result = resolveProvider("qwen-max");
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/M4b/);
  });

  it('unknown-random-model → kind "error" listing M4a known prefixes', () => {
    const result = resolveProvider("unknown-random-model");
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/claude\*/);
    expect(result.message).toMatch(/M4a/);
  });
});
