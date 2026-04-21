import { describe, it, expect } from "vitest";
import { exitCommand } from "./exit.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/exit", () => {
  it("returns a shutdown reducer event", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await exitCommand.execute(ctx);
    expect(res).toEqual({
      kind: "reducer-event",
      event: { type: "shutdown" },
    });
  });
});
