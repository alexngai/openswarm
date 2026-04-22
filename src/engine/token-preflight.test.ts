import { describe, it, expect } from "vitest";
import { localEstimate, countTokens } from "./token-preflight.js";

// ---------------------------------------------------------------------------
// localEstimate
// ---------------------------------------------------------------------------

describe("localEstimate", () => {
  it("returns a low positive integer for empty input", () => {
    const result = localEstimate({ messages: [] });
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.source).toBe("local-estimate");
  });

  it("scales roughly linearly: 100-char payload → ~40 tokens (±10%)", () => {
    // Build a message whose JSON serialisation is close to 100 chars.
    // We control the string length via the systemPrompt field.
    const target = 100;
    const input = { messages: [], systemPrompt: "x".repeat(target) };
    const result = localEstimate(input);
    const expected = target / 2.5;
    expect(result.inputTokens).toBeGreaterThanOrEqual(expected * 0.9);
    expect(result.inputTokens).toBeLessThanOrEqual(expected * 1.1 + 20); // JSON overhead is small
  });

  it("scales roughly linearly: 1000-char payload → more tokens than 100-char", () => {
    const small = localEstimate({ messages: [], systemPrompt: "x".repeat(100) });
    const large = localEstimate({ messages: [], systemPrompt: "x".repeat(1000) });
    // Large should be meaningfully more than small.
    expect(large.inputTokens).toBeGreaterThan(small.inputTokens * 5);
  });

  it("always returns source: local-estimate", () => {
    expect(localEstimate({ messages: [] }).source).toBe("local-estimate");
    expect(localEstimate({ messages: [{ role: "user", content: "hello" }], systemPrompt: "sys" }).source).toBe("local-estimate");
    expect(
      localEstimate({
        messages: [],
        tools: [{ name: "bash", description: "run bash", inputSchema: { type: "object" as const }, requiredPermission: "write" as const, tier: 1 as const }],
      }).source,
    ).toBe("local-estimate");
  });

  it("inputTokens >= 1 even for nearly-empty inputs (Math.ceil rounds up)", () => {
    // Even an empty messages array serialises to some JSON chars.
    const result = localEstimate({ messages: [] });
    expect(result.inputTokens).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

describe("countTokens", () => {
  it("returns the same value as localEstimate (server path not yet implemented)", async () => {
    const input = { messages: [{ role: "user", content: "test" }], systemPrompt: "hello" };
    const est = localEstimate(input);
    const counted = await countTokens(input);
    expect(counted).toEqual(est);
  });

  it("output has inputTokens >= 1 even for nearly-empty inputs", async () => {
    const result = await countTokens({ messages: [] });
    expect(result.inputTokens).toBeGreaterThanOrEqual(1);
    expect(result.source).toBe("local-estimate");
  });
});
