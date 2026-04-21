import { describe, it, expect } from "vitest";
import { approveCommand } from "./approve.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState, reduce } from "../../../ui/repl/state.js";

describe("/approve", () => {
  it("returns a permission-response approve event when pending", async () => {
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    const s2 = reduce(s1, {
      type: "permission-request",
      request: { toolName: "bash", toolUseId: "t-1", input: {} },
    });
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      s2,
      [],
      {},
    );
    const res = await approveCommand.execute(ctx);
    expect(res).toEqual({
      kind: "reducer-event",
      event: { type: "permission-response", decision: "approve" },
    });
  });

  it("errors if there is no pending permission", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await approveCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });
});
