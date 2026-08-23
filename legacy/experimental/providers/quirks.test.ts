import { describe, expect, it } from "vitest";
import { resolveQuirks, applyQuirks } from "./quirks.js";
import type { QuirkRequestBody } from "./quirks.js";

// ---------------------------------------------------------------------------
// resolveQuirks — strip-reasoning-params
// ---------------------------------------------------------------------------

describe("resolveQuirks — strip-reasoning-params", () => {
  it("matches o1-preview", () =>
    expect(resolveQuirks("o1-preview")).toContain("strip-reasoning-params"));

  it("matches o3-mini-2025-01-31", () =>
    expect(resolveQuirks("o3-mini-2025-01-31")).toContain("strip-reasoning-params"));

  it("matches bare o4", () =>
    expect(resolveQuirks("o4")).toContain("strip-reasoning-params"));

  it("matches gpt-4-thinking (contains -thinking)", () =>
    expect(resolveQuirks("gpt-4-thinking")).toContain("strip-reasoning-params"));

  it("matches qwq-7b", () =>
    expect(resolveQuirks("qwq-7b")).toContain("strip-reasoning-params"));

  it("matches grok-3-mini exactly", () =>
    expect(resolveQuirks("grok-3-mini")).toContain("strip-reasoning-params"));
});

// ---------------------------------------------------------------------------
// resolveQuirks — max-completion-tokens
// ---------------------------------------------------------------------------

describe("resolveQuirks — max-completion-tokens", () => {
  it("matches bare gpt-5", () =>
    expect(resolveQuirks("gpt-5")).toContain("max-completion-tokens"));

  it("matches gpt-5-turbo", () =>
    expect(resolveQuirks("gpt-5-turbo")).toContain("max-completion-tokens"));

  it("matches gpt-5-2026-02-01", () =>
    expect(resolveQuirks("gpt-5-2026-02-01")).toContain("max-completion-tokens"));
});

// ---------------------------------------------------------------------------
// resolveQuirks — strip-is-error
// ---------------------------------------------------------------------------

describe("resolveQuirks — strip-is-error", () => {
  it("matches kimi-latest", () =>
    expect(resolveQuirks("kimi-latest")).toContain("strip-is-error"));

  it("matches kimi-k2", () =>
    expect(resolveQuirks("kimi-k2")).toContain("strip-is-error"));
});

// ---------------------------------------------------------------------------
// resolveQuirks — false negatives (no tags)
// ---------------------------------------------------------------------------

describe("resolveQuirks — false negatives", () => {
  it("gpt-4o → empty", () => expect(resolveQuirks("gpt-4o")).toHaveLength(0));

  it("gpt-5o → empty (non-standard suffix)", () =>
    expect(resolveQuirks("gpt-5o")).toHaveLength(0));

  it("grok-3 → empty (not grok-3-mini)", () =>
    expect(resolveQuirks("grok-3")).toHaveLength(0));

  it("claude-sonnet-4-6 → empty", () =>
    expect(resolveQuirks("claude-sonnet-4-6")).toHaveLength(0));
});

// ---------------------------------------------------------------------------
// resolveQuirks — tag stacking
// ---------------------------------------------------------------------------

describe("resolveQuirks — stacking", () => {
  it("kimi-thinking-v1 gets both strip-is-error and strip-reasoning-params", () => {
    const tags = resolveQuirks("kimi-thinking-v1");
    expect(tags).toContain("strip-is-error");
    expect(tags).toContain("strip-reasoning-params");
  });
});

// ---------------------------------------------------------------------------
// applyQuirks — strip-reasoning-params
// ---------------------------------------------------------------------------

describe("applyQuirks — strip-reasoning-params", () => {
  it("removes temperature, topP, topK, presencePenalty, frequencyPenalty", () => {
    const body: QuirkRequestBody = {
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      maxOutputTokens: 1000,
    };
    const result = applyQuirks(body, ["strip-reasoning-params"]);
    expect(result).not.toHaveProperty("temperature");
    expect(result).not.toHaveProperty("topP");
    expect(result).not.toHaveProperty("topK");
    expect(result).not.toHaveProperty("presencePenalty");
    expect(result).not.toHaveProperty("frequencyPenalty");
    expect(result.maxOutputTokens).toBe(1000);
  });

  it("does not mutate the input body", () => {
    const body: QuirkRequestBody = { temperature: 0.5, maxOutputTokens: 1000 };
    applyQuirks(body, ["strip-reasoning-params"]);
    expect(body.temperature).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// applyQuirks — max-completion-tokens
// ---------------------------------------------------------------------------

describe("applyQuirks — max-completion-tokens", () => {
  it("renames maxOutputTokens → maxCompletionTokens", () => {
    const body: QuirkRequestBody = { maxOutputTokens: 1000, temperature: 0.5 };
    const result = applyQuirks(body, ["max-completion-tokens"]);
    expect(result.maxCompletionTokens).toBe(1000);
    expect(result.temperature).toBe(0.5);
    expect(result).not.toHaveProperty("maxOutputTokens");
  });

  it("leaves maxCompletionTokens untouched if already set", () => {
    const body: QuirkRequestBody = { maxOutputTokens: 500, maxCompletionTokens: 2000 };
    const result = applyQuirks(body, ["max-completion-tokens"]);
    expect(result.maxCompletionTokens).toBe(2000);
    expect(result).not.toHaveProperty("maxOutputTokens");
  });

  it("does not mutate the input body", () => {
    const body: QuirkRequestBody = { maxOutputTokens: 1000 };
    applyQuirks(body, ["max-completion-tokens"]);
    expect(body.maxOutputTokens).toBe(1000);
    expect(body).not.toHaveProperty("maxCompletionTokens");
  });
});

// ---------------------------------------------------------------------------
// applyQuirks — strip-is-error
// ---------------------------------------------------------------------------

describe("applyQuirks — strip-is-error", () => {
  it("removes is_error from tool_result blocks in user messages", () => {
    const body: QuirkRequestBody = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "1",
              content: "r",
              is_error: true,
            },
          ],
        },
      ],
    };
    const result = applyQuirks(body, ["strip-is-error"]);
    const msg = (result.messages as unknown[])[0] as Record<string, unknown>;
    const block = (msg["content"] as unknown[])[0] as Record<string, unknown>;
    expect(block).not.toHaveProperty("is_error");
    expect(block["type"]).toBe("tool_result");
    expect(block["tool_use_id"]).toBe("1");
  });

  it("does not mutate the input body", () => {
    const block = { type: "tool_result", tool_use_id: "1", content: "r", is_error: true };
    const body: QuirkRequestBody = {
      messages: [{ role: "user", content: [block] }],
    };
    applyQuirks(body, ["strip-is-error"]);
    expect(block).toHaveProperty("is_error");
  });

  it("leaves non-tool_result blocks untouched", () => {
    const body: QuirkRequestBody = {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };
    const result = applyQuirks(body, ["strip-is-error"]);
    const msg = (result.messages as unknown[])[0] as Record<string, unknown>;
    const block = (msg["content"] as unknown[])[0] as Record<string, unknown>;
    expect(block["type"]).toBe("text");
  });
});

// ---------------------------------------------------------------------------
// applyQuirks — idempotency
// ---------------------------------------------------------------------------

describe("applyQuirks — idempotency", () => {
  it("strip-reasoning-params twice yields same result", () => {
    const body: QuirkRequestBody = {
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 1000,
    };
    const once = applyQuirks(body, ["strip-reasoning-params"]);
    const twice = applyQuirks(once, ["strip-reasoning-params"]);
    expect(twice).toEqual(once);
  });

  it("max-completion-tokens twice yields same result", () => {
    const body: QuirkRequestBody = { maxOutputTokens: 1000 };
    const once = applyQuirks(body, ["max-completion-tokens"]);
    const twice = applyQuirks(once, ["max-completion-tokens"]);
    expect(twice).toEqual(once);
  });

  it("strip-is-error twice yields same result", () => {
    const body: QuirkRequestBody = {
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "1", content: "r", is_error: true }],
        },
      ],
    };
    const once = applyQuirks(body, ["strip-is-error"]);
    const twice = applyQuirks(once, ["strip-is-error"]);
    expect(twice).toEqual(once);
  });
});
