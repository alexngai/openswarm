import { describe, it, expect } from "vitest";
import { doctorCommand } from "./doctor.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";

describe("/doctor", () => {
  it("returns a message with doctor-style output", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      {},
    );
    const res = await doctorCommand.execute(ctx);
    // Either message (parsed) or error (capture failed) — but never throw.
    expect(["message", "error"]).toContain(res.kind);
    if (res.kind === "message") {
      expect(res.text).toMatch(/doctor \((pass|fail)\)/);
      expect(res.text).toContain("auth");
      expect(res.text).toContain("workspace");
    }
  });
});
