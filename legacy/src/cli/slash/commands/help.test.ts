import { describe, it, expect } from "vitest";
import { helpCommand } from "./help.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/help", () => {
  it("returns a message listing all registered commands", async () => {
    const registry = buildDefaultRegistry();
    const ctx = buildSlashContext(registry, createInitialState(), [], {});
    const res = await helpCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      for (const cmd of registry.list()) {
        expect(res.text).toContain(`/${cmd.name}`);
      }
    }
  });
});
