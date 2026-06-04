import { describe, it, expect, vi } from "vitest";
import { buildWorkerCanUseTool } from "./worker-entry.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { PermissionEngine } from "../permissions/index.js";
import type { PermissionDecision } from "../engine/index.js";

function dispatcherWith(name: string, requiredPermission: string): ToolDispatcher {
  return {
    get: (n: string) =>
      n === name ? { spec: { name, requiredPermission } } : undefined,
  } as unknown as ToolDispatcher;
}

function engine(decision: PermissionDecision): PermissionEngine {
  return { check: () => decision } as unknown as PermissionEngine;
}

describe("buildWorkerCanUseTool", () => {
  it("returns the mode decision when allowed (no escalation)", async () => {
    const gate = buildWorkerCanUseTool({
      dispatcher: dispatcherWith("read_file", "read"),
      permissionEngine: engine({ allow: true }),
      permissionMode: "read-only",
    });
    expect(await gate("read_file", {})).toEqual({ allow: true });
  });

  it("denies directly on mode-deny when escalation is off", async () => {
    const gate = buildWorkerCanUseTool({
      dispatcher: dispatcherWith("write_file", "write"),
      permissionEngine: engine({ allow: false, reason: "mode read-only" }),
      permissionMode: "read-only",
    });
    expect(await gate("write_file", {})).toEqual({ allow: false, reason: "mode read-only" });
  });

  it("escalates a mode-denied call and honors allow", async () => {
    const escalate = vi.fn(async () => ({ outcome: "allow" as const }));
    const gate = buildWorkerCanUseTool({
      dispatcher: dispatcherWith("write_file", "write"),
      permissionEngine: engine({ allow: false, reason: "mode" }),
      permissionMode: "read-only",
      escalate,
    });
    expect(await gate("write_file", { path: "x" })).toEqual({ allow: true });
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "write_file",
        requiredPermission: "write",
        currentMode: "read-only",
      }),
    );
  });

  it("escalates and honors deny (with reason)", async () => {
    const escalate = vi.fn(async () => ({ outcome: "deny" as const, reason: "nope" }));
    const gate = buildWorkerCanUseTool({
      dispatcher: dispatcherWith("write_file", "write"),
      permissionEngine: engine({ allow: false, reason: "mode" }),
      permissionMode: "read-only",
      escalate,
    });
    expect(await gate("write_file", {})).toEqual({ allow: false, reason: "nope" });
  });

  it("denies unknown tools without escalating", async () => {
    const escalate = vi.fn();
    const gate = buildWorkerCanUseTool({
      dispatcher: dispatcherWith("x", "read"),
      permissionEngine: engine({ allow: true }),
      permissionMode: "workspace-write",
      escalate,
    });
    const d = await gate("nonexistent", {});
    expect(d.allow).toBe(false);
    expect(escalate).not.toHaveBeenCalled();
  });
});
