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
