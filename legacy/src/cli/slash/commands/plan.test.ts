import { describe, it, expect } from "vitest";
import { planCommand } from "./plan.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";
import type { PermissionMode } from "../../../core/types.js";
import { clampPermissionMode } from "../../../swarm/permission-order.js";

/** Mirror main.ts's plan wiring: plan on → read-only, off → parent ceiling. */
function wiring(initialPlan: boolean, parent: PermissionMode) {
  let plan = initialPlan;
  let mode: PermissionMode = initialPlan ? "read-only" : parent;
  return {
    getState: () => ({ plan, mode }),
    deps: {
      getPlanMode: () => plan,
      setPlanMode: (on: boolean) => {
        plan = on;
        mode = on ? clampPermissionMode("read-only", parent) : parent;
      },
      getPermissionMode: () => mode,
    },
  };
}

describe("/plan", () => {
  it("toggles on from off and forces read-only", async () => {
    const w = wiring(false, "workspace-write");
    const ctx = buildSlashContext(buildDefaultRegistry(), createInitialState(), [], w.deps);
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("message");
    expect(w.getState()).toEqual({ plan: true, mode: "read-only" });
  });

  it("toggles off and restores the parent ceiling", async () => {
    const w = wiring(true, "workspace-write");
    const ctx = buildSlashContext(buildDefaultRegistry(), createInitialState(), [], w.deps);
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("message");
    expect(w.getState()).toEqual({ plan: false, mode: "workspace-write" });
  });

  it("honors explicit on/off args", async () => {
    const w = wiring(false, "workspace-write");
    const reg = buildDefaultRegistry();
    await planCommand.execute(buildSlashContext(reg, createInitialState(), ["on"], w.deps));
    expect(w.getState().plan).toBe(true);
    await planCommand.execute(buildSlashContext(reg, createInitialState(), ["off"], w.deps));
    expect(w.getState().plan).toBe(false);
  });

  it("reports status without changing state", async () => {
    const w = wiring(true, "workspace-write");
    const ctx = buildSlashContext(buildDefaultRegistry(), createInitialState(), ["status"], w.deps);
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") expect(res.text).toContain("plan mode is on");
    expect(w.getState().plan).toBe(true);
  });

  it("no-ops when already in the requested state", async () => {
    const w = wiring(false, "workspace-write");
    const ctx = buildSlashContext(buildDefaultRegistry(), createInitialState(), ["off"], w.deps);
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") expect(res.text).toContain("already off");
  });

  it("rejects invalid args", async () => {
    const w = wiring(false, "workspace-write");
    const ctx = buildSlashContext(buildDefaultRegistry(), createInitialState(), ["bogus"], w.deps);
    const res = await planCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });
});
