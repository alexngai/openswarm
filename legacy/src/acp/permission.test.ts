import { describe, it, expect } from "vitest";
import { AcpPermissionBridge } from "./permission.js";
import type { PendingPermission } from "../ui/repl/state.js";

function pending(): PendingPermission {
  return {
    toolName: "edit_file",
    input: { path: "a.ts", old_string: "x", new_string: "y" },
    currentMode: "workspace-write",
    requiredPermission: "write",
    reason: "needs approval",
  } as unknown as PendingPermission;
}

function connWith(outcome: unknown) {
  return {
    requestPermission: async () => ({ outcome }),
  } as never;
}

describe("AcpPermissionBridge", () => {
  it("maps a selected allow to allow", async () => {
    const b = new AcpPermissionBridge(
      connWith({ outcome: "selected", optionId: "allow" }),
      "s1",
    );
    expect(await b.request(pending())).toEqual({ allow: true });
  });

  it("maps allow_always to allow + session-rule marker (Phase 3 B4)", async () => {
    const b = new AcpPermissionBridge(
      connWith({ outcome: "selected", optionId: "allow_always" }),
      "s1",
    );
    expect(await b.request(pending())).toEqual({ allow: true, alwaysAllow: true });
  });

  it("maps reject to deny", async () => {
    const b = new AcpPermissionBridge(
      connWith({ outcome: "selected", optionId: "reject" }),
      "s1",
    );
    const d = await b.request(pending());
    expect(d.allow).toBe(false);
  });

  it("maps cancelled to deny", async () => {
    const b = new AcpPermissionBridge(connWith({ outcome: "cancelled" }), "s1");
    const d = await b.request(pending());
    expect(d.allow).toBe(false);
  });

  it("sends a titled request with the three standard options", async () => {
    let captured: { sessionId?: string; toolCall?: { title?: string }; options?: Array<{ optionId: string }> } = {};
    const conn = {
      requestPermission: async (r: typeof captured) => {
        captured = r;
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    } as never;
    const b = new AcpPermissionBridge(conn, "s1");
    await b.request(pending());
    expect(captured.sessionId).toBe("s1");
    expect(captured.toolCall?.title).toContain("a.ts");
    expect(captured.options?.map((o) => o.optionId)).toEqual([
      "allow_always",
      "allow",
      "reject",
    ]);
  });
});
