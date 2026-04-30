import { describe, it, expect } from "vitest";
import { stopCommand } from "./stop.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState, reduce } from "../../../ui/repl/state.js";

describe("/stop", () => {
  it("fires the AbortController if provided", async () => {
    const abort = new AbortController();
    const s0 = reduce(createInitialState(), { type: "submit", text: "hi" });
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      s0,
      [],
      { abort },
    );
    const res = await stopCommand.execute(ctx);
    expect(abort.signal.aborted).toBe(true);
    expect(res).toEqual({
      kind: "reducer-event",
      event: { type: "stream-end" },
    });
  });

  it("works without an AbortController", async () => {
    const s0 = reduce(createInitialState(), { type: "submit", text: "hi" });
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      s0,
      [],
      {},
    );
    const res = await stopCommand.execute(ctx);
    expect(res.kind).toBe("reducer-event");
  });
});
