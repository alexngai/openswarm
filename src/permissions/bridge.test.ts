import { describe, it, expect, vi } from "vitest";
import { PermissionBridge } from "./bridge.js";
import type { PendingPermission, ReplEvent } from "../ui/repl/state.js";

const PENDING: PendingPermission = {
  toolName: "bash",
  input: { command: "ls" },
  currentMode: "read-only",
  requiredPermission: "write",
};

describe("PermissionBridge", () => {
  it("request resolves with the decision passed to respond (approve)", async () => {
    const bridge = new PermissionBridge();
    const p = bridge.request(PENDING);
    bridge.respond({ allow: true });
    await expect(p).resolves.toEqual({ allow: true });
  });

  it("request resolves with the decision passed to respond (deny with reason)", async () => {
    const bridge = new PermissionBridge();
    const p = bridge.request(PENDING);
    bridge.respond({ allow: false, reason: "user denied" });
    await expect(p).resolves.toEqual({ allow: false, reason: "user denied" });
  });

  it("dispatches permission-request on request, permission-response on respond", async () => {
    const bridge = new PermissionBridge();
    const dispatch = vi.fn<(ev: ReplEvent) => void>();
    bridge.attachDispatch(dispatch);

    const p = bridge.request(PENDING);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: "permission-request",
      request: PENDING,
    });

    bridge.respond({ allow: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "permission-response",
      decision: "approve",
    });
    await p;
  });

  it("respond dispatches decision:'deny' when decision.allow is false", async () => {
    const bridge = new PermissionBridge();
    const dispatch = vi.fn<(ev: ReplEvent) => void>();
    bridge.attachDispatch(dispatch);

    const p = bridge.request(PENDING);
    bridge.respond({ allow: false, reason: "no" });
    await p;

    expect(dispatch).toHaveBeenNthCalledWith(2, {
      type: "permission-response",
      decision: "deny",
    });
  });

  it("hasPending reflects state; peek returns current payload", async () => {
    const bridge = new PermissionBridge();
    expect(bridge.hasPending()).toBe(false);
    expect(bridge.peek()).toBeNull();

    const p = bridge.request(PENDING);
    expect(bridge.hasPending()).toBe(true);
    expect(bridge.peek()).toEqual(PENDING);

    bridge.respond({ allow: true });
    await p;
    expect(bridge.hasPending()).toBe(false);
    expect(bridge.peek()).toBeNull();
  });

  it("concurrent request (prior not yet resolved) denies immediately", async () => {
    const bridge = new PermissionBridge();
    const first = bridge.request(PENDING);
    const second = bridge.request({ ...PENDING, toolName: "other" });

    // Second resolves without waiting.
    await expect(second).resolves.toEqual({
      allow: false,
      reason: expect.stringContaining("prior request"),
    });

    // First is still pending; close it.
    bridge.respond({ allow: true });
    await expect(first).resolves.toEqual({ allow: true });
  });

  it("respond with no pending request is a no-op", () => {
    const bridge = new PermissionBridge();
    const dispatch = vi.fn<(ev: ReplEvent) => void>();
    bridge.attachDispatch(dispatch);

    bridge.respond({ allow: true }); // no pending
    expect(dispatch).not.toHaveBeenCalled();
    expect(bridge.hasPending()).toBe(false);
  });

  it("unattached bridge (no dispatch) still resolves via respond", async () => {
    const bridge = new PermissionBridge();
    // No attachDispatch — simulates headless caller.
    const p = bridge.request(PENDING);
    bridge.respond({ allow: true });
    await expect(p).resolves.toEqual({ allow: true });
  });
});
