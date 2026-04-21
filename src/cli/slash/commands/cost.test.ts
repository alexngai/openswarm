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

  it("computes Sonnet pricing by default", async () => {
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

  it("picks Opus pricing when model name contains 'opus'", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {
        getUsage: () => ({ inputTokens: 1_000_000, outputTokens: 0 }),
        getModel: () => "claude-opus-4-6",
      },
    );
    const res = await costCommand.execute(ctx);
    if (res.kind === "message") {
      expect(res.text).toContain("estimated cost: $15.0000");
    }
  });
});
