import { describe, it, expect } from "vitest";
import { compactCommand } from "./compact.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/compact", () => {
  it("returns an engine-hint result", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await compactCommand.execute(ctx);
    expect(res.kind).toBe("engine-hint");
    if (res.kind === "engine-hint") {
      expect(res.prompt).toMatch(/compact/i);
    }
  });
});
