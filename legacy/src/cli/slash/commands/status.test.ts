import { describe, it, expect } from "vitest";
import { statusCommand } from "./status.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/status", () => {
  it("renders state, model, permission, session, and tokens", async () => {
    const registry = buildDefaultRegistry();
    const state = createInitialState({ sessionId: "s-abc" });
    const ctx = buildSlashContext(registry, state, [], {
      getModel: () => "opus",
      getUsage: () => ({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheWriteInputTokens: 5,
      }),
      getPermissionMode: () => "read-only",
    });
    const res = await statusCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("state: idle");
      expect(res.text).toContain("model: opus");
      expect(res.text).toContain("permission: read-only");
      expect(res.text).toContain("session: s-abc");
      expect(res.text).toContain("tokens: 165");
      expect(res.text).toContain("token preflight: local-estimate");
    }
  });

  it("reports cache share and ctx/turn once usage has flowed (TE-19)", async () => {
    const state = {
      ...createInitialState(),
      usageStats: {
        inputTokens: 2_000,
        outputTokens: 300,
        cacheReadInputTokens: 8_000,
        cacheWriteInputTokens: 0,
        turns: 2,
      },
    };
    const ctx = buildSlashContext(buildDefaultRegistry(), state, [], {
      getUsage: () => ({
        inputTokens: 2_000,
        outputTokens: 300,
        cacheReadInputTokens: 8_000,
        cacheWriteInputTokens: 0,
      }),
    });
    const res = await statusCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      // 8000 / (8000 + 2000) = 80% cache-read share of the input side.
      expect(res.text).toContain("cache: 80% of input read from cache");
      // (2000 + 8000 + 0) / 2 turns = 5000 tokens per turn.
      expect(res.text).toContain("ctx/turn: 5000 tokens (2 turns)");
    }
  });

  it("omits cache and ctx/turn lines before any usage", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await statusCommand.execute(ctx);
    if (res.kind === "message") {
      expect(res.text).not.toContain("cache:");
      expect(res.text).not.toContain("ctx/turn:");
    }
  });

  it("falls back to `—` when sessionId is undefined", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await statusCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toContain("session: —");
    }
  });
});
