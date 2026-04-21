import { describe, it, expect } from "vitest";
import { modelCommand } from "./model.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/model", () => {
  it("reports the current model when called with no args", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      { getModel: () => "claude-sonnet-4-6" },
    );
    const res = await modelCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toBe("current model: claude-sonnet-4-6");
    }
  });

  it("updates the model on a valid alias", async () => {
    let current = "sonnet";
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["opus"],
      {
        getModel: () => current,
        setModel: (m) => {
          current = m;
        },
      },
    );
    const res = await modelCommand.execute(ctx);
    expect(res.kind).toBe("message");
    expect(current).toBe("opus");
  });

  it("rejects unknown aliases", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["bogus"],
      {},
    );
    const res = await modelCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });

  it("rejects too many args", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["sonnet", "extra"],
      {},
    );
    const res = await modelCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });
});
