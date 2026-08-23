import { describe, it, expect } from "vitest";
import { clearCommand } from "./clear.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/clear", () => {
  it("returns a clear reducer event", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await clearCommand.execute(ctx);
    expect(res).toEqual({
      kind: "reducer-event",
      event: { type: "clear" },
    });
  });
});
