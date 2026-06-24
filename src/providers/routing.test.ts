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

  // M4b: grok* → xAI (native)
  it('grok-3 → kind "native" with modelId "grok-3"', () => {
    const result = resolveProvider("grok-3");
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(result.modelId).toBe("grok-3");
  });

  it('grok-3-mini → kind "native"', () => {
    const result = resolveProvider("grok-3-mini");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("grok-3-mini");
  });

  // M4b: gemini-* → Google (native)
  it('gemini-2.0-flash → kind "native" with modelId "gemini-2.0-flash"', () => {
    const result = resolveProvider("gemini-2.0-flash");
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(result.modelId).toBe("gemini-2.0-flash");
  });

  it('gemini-2.0-pro → kind "native"', () => {
    const result = resolveProvider("gemini-2.0-pro");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("gemini-2.0-pro");
  });

  // M4b: qwen* / kimi* → DashScope (native)
  it('qwen-plus → kind "native" with modelId "qwen-plus"', () => {
    const result = resolveProvider("qwen-plus");
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(result.modelId).toBe("qwen-plus");
  });

  it('qwen/qwen-max → kind "native" with modelId "qwen-max" (prefix stripped)', () => {
    const result = resolveProvider("qwen/qwen-max");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("qwen-max");
  });

  it('kimi-k2 → kind "native"', () => {
    const result = resolveProvider("kimi-k2");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("kimi-k2");
  });

  it('kimi/k2-chat → kind "native" with modelId "k2-chat" (prefix stripped)', () => {
    const result = resolveProvider("kimi/k2-chat");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("k2-chat");
  });

  // LiteLLM gateway: litellm/ | gateway/ | bedrock/ | azure/ → native, routed through the gateway, with
  // a self-described authFactory (LITELLM_API_KEY) and the gateway model name (prefix stripped).
  it.each([
    ["litellm/claude-haiku", "claude-haiku"],
    ["gateway/gpt-4o", "gpt-4o"],
    ["bedrock/claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["azure/gpt-4o", "gpt-4o"],
    ["litellm/agentica-org/DeepSWE-Preview", "agentica-org/DeepSWE-Preview"], // open-weight, slash in the name
  ])('%s → native litellm transport, modelId "%s", authFactory present', (id, cleanId) => {
    const result = resolveProvider(id);
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(typeof result.authFactory).toBe("function");
    expect(result.modelId).toBe(cleanId);
  });

  // Azure OpenAI DIRECT: azureoai/<deployment> → native, distinct from the azure/ gateway prefix.
  // The deployment name is the prefix-stripped value; authFactory supplies AZURE_OPENAI_API_KEY.
  it.each([
    ["azureoai/gpt-4.1", "gpt-4.1"],
    ["azureoai/gpt-4o", "gpt-4o"],
  ])('%s → native azure transport, modelId "%s", authFactory present', (id, deployment) => {
    const result = resolveProvider(id);
    expect(result.kind).toBe("native");
    expect(typeof result.providerFactory).toBe("function");
    expect(typeof result.authFactory).toBe("function");
    expect(result.modelId).toBe(deployment);
  });

  // azure/ must STILL route to the LiteLLM gateway (not the direct Azure transport).
  it('azure/gpt-4o → native litellm gateway (unchanged), modelId "gpt-4o"', () => {
    const result = resolveProvider("azure/gpt-4o");
    expect(result.kind).toBe("native");
    expect(result.modelId).toBe("gpt-4o");
    expect(typeof result.authFactory).toBe("function");
  });

  it('unknown-random-model → kind "error" listing known prefixes', () => {
    const result = resolveProvider("unknown-random-model");
    expect(result.kind).toBe("error");
    expect(result.message).toMatch(/claude\*/);
    expect(result.message).toMatch(/grok\*/);
    expect(result.message).toMatch(/gemini-\*/);
    expect(result.message).toMatch(/qwen\*/);
  });
});
