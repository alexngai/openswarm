/**
 * Tests for the approval-broker adapter.
 *
 * The behaviour worth pinning is the scope mapping. The policy engine defaults
 * an unscoped approval to `session`, while the established UX is that a plain
 * "y" means once and "a" means for the session. If the adapter forgot to pass a
 * scope, every one-shot approval would silently become a session grant — an
 * expansion of consent the user never gave, and one nothing else would catch.
 */

import { describe, it, expect } from "vitest";
import { makeApprovalBroker } from "./policy-broker.js";
import type { PermissionBridge, BridgeDecision } from "./bridge.js";
import type { ApprovalRequest } from "../kernel/policy-engine.js";
import type { CanonicalPath } from "../kernel/contracts.js";

const canonical: CanonicalPath = {
  canonical: "/ws/a.txt",
  workspaceRoot: "/ws",
  relative: "a.txt",
};

function approvalRequest(): ApprovalRequest {
  return {
    operationClass: "file.write",
    resource: canonical.canonical,
    request: {
      kind: "file.write",
      operationId: "op-1",
      idempotency: "mutating",
      toolName: "write_file",
      path: canonical,
      expected: { path: canonical, contentHash: null, sizeBytes: null, mtimeMs: null },
    },
  };
}

function bridgeReturning(decision: BridgeDecision): {
  bridge: PermissionBridge;
  seen: () => Parameters<PermissionBridge["request"]>[0] | undefined;
} {
  let seen: Parameters<PermissionBridge["request"]>[0] | undefined;
  const bridge = {
    request: async (pending: Parameters<PermissionBridge["request"]>[0]) => {
      seen = pending;
      return decision;
    },
  } as unknown as PermissionBridge;
  return { bridge, seen: () => seen };
}

describe("approval scope mapping", () => {
  it("maps a plain approval to one-shot", async () => {
    const { bridge } = bridgeReturning({ allow: true });
    const broker = makeApprovalBroker({
      bridge,
      useHeadless: false,
      getCurrentMode: () => "read-only",
    });

    const response = await broker.request(approvalRequest());
    expect(response.approved).toBe(true);
    expect(response.scope).toBe("one-shot");
  });

  it("maps an always-allow approval to session", async () => {
    const { bridge } = bridgeReturning({ allow: true, alwaysAllow: true });
    const broker = makeApprovalBroker({
      bridge,
      useHeadless: false,
      getCurrentMode: () => "read-only",
    });

    const response = await broker.request(approvalRequest());
    expect(response.scope).toBe("session");
  });

  it("never returns an unscoped approval", async () => {
    // An omitted scope would inherit the engine's `session` default.
    for (const decision of [{ allow: true }, { allow: true, alwaysAllow: true }] as const) {
      const { bridge } = bridgeReturning(decision);
      const broker = makeApprovalBroker({
        bridge,
        useHeadless: false,
        getCurrentMode: () => "read-only",
      });
      expect((await broker.request(approvalRequest())).scope).toBeDefined();
    }
  });

  it("passes a denial through with its reason", async () => {
    const { bridge } = bridgeReturning({ allow: false, reason: "user said no" });
    const broker = makeApprovalBroker({
      bridge,
      useHeadless: false,
      getCurrentMode: () => "read-only",
    });

    const response = await broker.request(approvalRequest());
    expect(response.approved).toBe(false);
    expect(response.reason).toBe("user said no");
  });
});

describe("what the prompt shows", () => {
  it("names the resource rather than burying it in tool input", async () => {
    const { bridge, seen } = bridgeReturning({ allow: true });
    const broker = makeApprovalBroker({
      bridge,
      useHeadless: false,
      getCurrentMode: () => "read-only",
    });

    await broker.request(approvalRequest());

    const pending = seen();
    expect(pending?.toolName).toBe("write_file");
    expect(pending?.input).toEqual({
      operation: "file.write",
      resource: "/ws/a.txt",
    });
    expect(pending?.reason).toContain("/ws/a.txt");
  });

  it("reports the mode live rather than at construction", async () => {
    const { bridge, seen } = bridgeReturning({ allow: true });
    let mode: "read-only" | "workspace-write" = "read-only";
    const broker = makeApprovalBroker({
      bridge,
      useHeadless: false,
      getCurrentMode: () => mode,
    });

    await broker.request(approvalRequest());
    expect(seen()?.currentMode).toBe("read-only");

    mode = "workspace-write";
    await broker.request(approvalRequest());
    expect(seen()?.currentMode).toBe("workspace-write");
  });
});
