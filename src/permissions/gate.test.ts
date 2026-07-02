import { describe, it, expect } from "vitest";
import { makeCanUseTool } from "./gate.js";
import { PermissionEngine } from "./index.js";
import type { PermissionMode } from "../core/types.js";
import type { ToolImpl } from "../tools/types.js";
import type { ToolDispatcher } from "../tools/dispatcher.js";
import type { PermissionBridge } from "./bridge.js";
import type { BridgeDecision } from "./bridge.js";

function writeTool(): ToolImpl {
  return {
    spec: {
      name: "write_file",
      description: "writes a file",
      inputSchema: { type: "object" },
      requiredPermission: "write",
      tier: 0,
    },
    execute: async () => ({ status: "ok", output: "" }),
  } as unknown as ToolImpl;
}

function makeDeps(
  getCurrentMode: () => PermissionMode,
  bridgeDecision: BridgeDecision = { allow: false, reason: "denied by test bridge" },
): Parameters<typeof makeCanUseTool>[0] {
  const tool = writeTool();
  const dispatcher = {
    get: (n: string) => (n === tool.spec.name ? tool : undefined),
  } as unknown as ToolDispatcher;
  const bridge = {
    request: async () => bridgeDecision,
  } as unknown as PermissionBridge;
  return {
    dispatcher,
    // permEngine is deliberately built read-only; the gate must honor the
    // LIVE getCurrentMode() instead (Phase 4.1e).
    permEngine: new PermissionEngine("read-only"),
    bridge,
    useHeadless: false,
    getCurrentMode,
    cwd: process.cwd(),
  };
}

describe("makeCanUseTool — honors live mode over the frozen permEngine (Phase 4.1e)", () => {
  it("allows a write tool when the live mode is workspace-write (post-elevation)", async () => {
    const gate = makeCanUseTool(makeDeps(() => "workspace-write"));
    expect(await gate("write_file", {})).toEqual({ allow: true });
  });

  it("prompts (bridge) and denies when the live mode is still read-only", async () => {
    const gate = makeCanUseTool(makeDeps(() => "read-only"));
    const decision = await gate("write_file", {});
    expect(decision.allow).toBe(false);
  });

  it("reflects an elevation that happens between calls", async () => {
    let mode: PermissionMode = "read-only";
    const gate = makeCanUseTool(makeDeps(() => mode));
    expect((await gate("write_file", {})).allow).toBe(false);
    mode = "workspace-write"; // simulate request_permissions / /permissions
    expect(await gate("write_file", {})).toEqual({ allow: true });
  });
});
