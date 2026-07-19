import { describe, it, expect } from "vitest";
import { costCommand } from "./cost.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/cost", () => {
  it("reports zeros when usage is empty", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await costCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("input: 0");
      expect(res.text).toContain("output: 0");
      expect(res.text).toContain("cache_read: 0");
      expect(res.text).toContain("cache_write: 0");
      expect(res.text).toContain("estimated cost: $0.0000");
    }
  });

  it("prices via MODEL_PRICING (canonical table, not a placeholder)", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {
        getUsage: () => ({
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
        getModel: () => "claude-sonnet-4-6",
      },
    );
    const res = await costCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      // Sonnet: 3 in + 15 out = $18.0000
      expect(res.text).toContain("estimated cost: $18.0000");
      expect(res.text).toContain("model: claude-sonnet-4-6");
    }
  });

  it("prices cache read/write traffic (TE-17 defaults: 0.1x / 1.25x input)", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {
        getUsage: () => ({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 1_000_000,
          cacheWriteInputTokens: 1_000_000,
        }),
        getModel: () => "claude-sonnet-4-6",
      },
    );
    const res = await costCommand.execute(ctx);
    if (res.kind === "message") {
      // Sonnet input $3/MTok: cache read 0.1x = $0.30, write 1.25x = $3.75
      expect(res.text).toContain("estimated cost: $4.0500");
      expect(res.text).toContain("cache hit ratio: 100%");
    }
  });

  it("reports n/a (not a guessed rate) for a model absent from MODEL_PRICING", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {
        getUsage: () => ({ inputTokens: 1_000_000, outputTokens: 0 }),
        getModel: () => "deepseek-chat",
      },
    );
    const res = await costCommand.execute(ctx);
    if (res.kind === "message") {
      expect(res.text).toContain("estimated cost: n/a");
      expect(res.text).toContain("MODEL_PRICING");
      expect(res.text).not.toMatch(/estimated cost: \$\d/);
    }
  });

  it("reports ctx/turn when the store carries a turn count", async () => {
    const state = {
      ...createInitialState(),
      usageStats: {
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadInputTokens: 90_000,
        cacheWriteInputTokens: 0,
        turns: 4,
      },
    };
    const ctx = buildSlashContext(buildDefaultRegistry(), state, [], {
      getUsage: () => ({
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadInputTokens: 90_000,
        cacheWriteInputTokens: 0,
      }),
      getModel: () => "claude-sonnet-4-6",
    });
    const res = await costCommand.execute(ctx);
    if (res.kind === "message") {
      // (10k input + 90k cacheRead + 0 write) / 4 turns = 25000 tokens/turn
      expect(res.text).toContain("ctx/turn: 25000 tokens (4 turns)");
      expect(res.text).toContain("cache hit ratio: 90%");
    }
  });
});
