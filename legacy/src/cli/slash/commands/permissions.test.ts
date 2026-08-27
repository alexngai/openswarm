import { describe, it, expect } from "vitest";
import { permissionsCommand } from "./permissions.js";
import { buildDefaultRegistry, buildSlashContext } from "../index.js";
import { createInitialState } from "../../../ui/repl/state.js";
import type { PermissionMode } from "../../../core/types.js";
import { clampPermissionMode } from "../../../swarm/permission-order.js";

describe("/permissions", () => {
  it("reports the current mode when called with no args", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      [],
      { getPermissionMode: () => "read-only" },
    );
    const res = await permissionsCommand.execute(ctx);
    expect(res.kind).toBe("message");
    if (res.kind === "message") {
      expect(res.text).toBe("current permission mode: read-only");
    }
  });

  it("updates the mode on a valid arg", async () => {
    let current: PermissionMode = "read-only";
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["workspace-write"],
      {
        getPermissionMode: () => current,
        setPermissionMode: (m) => {
          current = m;
        },
      },
    );
    const res = await permissionsCommand.execute(ctx);
    expect(res.kind).toBe("message");
    expect(current).toBe("workspace-write");
  });

  it("rejects unknown modes", async () => {
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["bogus"],
      {},
    );
    const res = await permissionsCommand.execute(ctx);
    expect(res.kind).toBe("error");
  });

  it("reports clamping when parent narrows the requested mode", async () => {
    const parent: PermissionMode = "workspace-write";
    let current: PermissionMode = "workspace-write";
    const ctx = buildSlashContext(
      buildDefaultRegistry(),
      createInitialState(),
      ["danger-full-access"],
      {
        getPermissionMode: () => current,
        setPermissionMode: (m) => {
          current = clampPermissionMode(m, parent);
        },
      },
    );
    const res = await permissionsCommand.execute(ctx);
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.message).toContain("clamped");
      expect(res.message).toContain("workspace-write");
    }
    expect(current).toBe("workspace-write");
  });
});
