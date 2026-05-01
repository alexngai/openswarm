/**
 * bash-gate.test.ts — unit tests for the Phase 5 Stage A bash validation gate.
 *
 * Tests cover:
 *   - Non-bash tool falls through (returns null)
 *   - Bash with empty command falls through (returns null)
 *   - Bash with safe command falls through (returns null)
 *   - Block path: structured error returned with [submodule] prefix
 *   - Warn TTY: bridge.request resolves approve → {allow:true}
 *   - Warn TTY: bridge.request resolves deny → {allow:false}
 *   - Warn headless: injected headlessApproval 'y' → {allow:true}
 *   - Warn headless: injected headlessApproval EOF → {allow:false}
 *   - Block in read-only mode: rm -rf foo → {allow:false, reason starts with [read-only]}
 *   - Path block (/etc/passwd cat): {allow:false, reason starts with [path]}
 *   - Reason field always prefixed with [submodule]
 */

import { describe, it, expect, vi } from "vitest";
import { bashValidationGate } from "./bash-gate.js";
import { PermissionBridge } from "./bridge.js";
import type { BashGateDeps, BashGateInput } from "./bash-gate.js";
import type { ToolImpl } from "../tools/types.js";
import type { PermissionDecision } from "../engine/index.js";

// ---------------------------------------------------------------------------
// Helpers — minimal ToolImpl fixtures
// ---------------------------------------------------------------------------

function makeTool(name: string, requiredPermission: "exec" | "read" | "write" | "none" = "exec"): ToolImpl {
  return {
    spec: {
      name,
      description: `${name} tool`,
      inputSchema: { type: "object", properties: {} },
      requiredPermission,
      tier: 0,
    },
    execute: vi.fn(),
  };
}

const BASH_TOOL = makeTool("bash", "exec");
const READ_TOOL = makeTool("read_file", "read");

/** Build a BashGateDeps with a real PermissionBridge and default options. */
function makeDeps(overrides: Partial<BashGateDeps> = {}): BashGateDeps {
  return {
    bridge: new PermissionBridge(),
    useHeadless: false,
    cwd: "/workspace",
    ...overrides,
  };
}

/** Build a BashGateInput for the bash tool. */
function bashInput(command: string, mode: BashGateInput["currentMode"] = "workspace-write"): BashGateInput {
  return {
    toolName: "bash",
    toolImpl: BASH_TOOL,
    input: { command },
    currentMode: mode,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bashValidationGate", () => {
  // 1. Non-bash tool falls through
  it("returns null for a non-bash tool (read_file)", async () => {
    const result = await bashValidationGate(
      { toolName: "read_file", toolImpl: READ_TOOL, input: { path: "/foo/bar.ts" }, currentMode: "workspace-write" },
      makeDeps(),
    );
    expect(result).toBeNull();
  });

  // 2. Bash with empty command falls through
  it("returns null for bash tool with empty command string", async () => {
    const result = await bashValidationGate(
      bashInput(""),
      makeDeps(),
    );
    expect(result).toBeNull();
  });

  // 3. Bash with safe, read-like command falls through
  it("returns null for bash tool with a safe command (ls -la)", async () => {
    const result = await bashValidationGate(
      bashInput("ls -la /workspace"),
      makeDeps(),
    );
    expect(result).toBeNull();
  });

  // 4. Block path: read-only mode blocks rm
  it("Block — read-only mode: rm -rf foo returns {allow:false} with [read-only] prefix", async () => {
    const result = await bashValidationGate(
      bashInput("rm -rf foo", "read-only"),
      makeDeps(),
    );
    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
    if (!result!.allow) {
      expect(result!.reason).toMatch(/^\[read-only\]/);
    }
  });

  // 5. Block path: path submodule blocks /etc/passwd access
  it("Block — path submodule: cat /etc/passwd returns {allow:false} with [path] prefix", async () => {
    const result = await bashValidationGate(
      bashInput("cat /etc/passwd"),
      makeDeps(),
    );
    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
    if (!result!.allow) {
      expect(result!.reason).toMatch(/^\[path\]/);
    }
  });

  // 6. Reason field always prefixed with [submodule]
  it("Block reason is always prefixed with [<submodule>]", async () => {
    // read-only block
    const r1 = await bashValidationGate(
      bashInput("touch newfile", "read-only"),
      makeDeps(),
    );
    expect(r1).not.toBeNull();
    expect(r1!.allow).toBe(false);
    if (!r1!.allow) {
      expect(r1!.reason).toMatch(/^\[[a-z-]+\]/);
    }
  });

  // 7. Warn TTY: bridge.request resolves to approve → {allow:true}
  it("Warn TTY: bridge.request approves → returns {allow:true}", async () => {
    const bridge = new PermissionBridge();
    const mockRequest = vi.spyOn(bridge, "request").mockResolvedValue({ allow: true });

    const result = await bashValidationGate(
      // rm -rf with a non-root path triggers the destructive warn, not a block
      bashInput("rm -rf /tmp/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ allow: true });
  });

  // 8. Warn TTY: bridge.request resolves to deny → {allow:false}
  it("Warn TTY: bridge.request denies → returns {allow:false, reason}", async () => {
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({
      allow: false,
      reason: "user denied",
    });

    const result = await bashValidationGate(
      bashInput("rm -rf /tmp/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(result).toEqual({ allow: false, reason: "user denied" });
  });

  // 9. Warn headless: injected headlessApproval returning 'y' → {allow:true}
  it("Warn headless: injected headlessApproval approve → returns {allow:true}", async () => {
    const fakeHeadless = vi.fn<typeof import("./headless-prompt.js").readHeadlessApproval>()
      .mockResolvedValue({ allow: true });

    const result = await bashValidationGate(
      bashInput("rm -rf /tmp/test-dir", "workspace-write"),
      makeDeps({ useHeadless: true, headlessApproval: fakeHeadless }),
    );

    expect(fakeHeadless).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ allow: true });
  });

  // 10. Warn headless: injected headlessApproval EOF → {allow:false}
  it("Warn headless: injected headlessApproval EOF deny → returns {allow:false}", async () => {
    const fakeHeadless = vi.fn<typeof import("./headless-prompt.js").readHeadlessApproval>()
      .mockResolvedValue({ allow: false, reason: "user denied bash: stdin EOF" });

    const result = await bashValidationGate(
      bashInput("rm -rf /tmp/test-dir", "workspace-write"),
      makeDeps({ useHeadless: true, headlessApproval: fakeHeadless }),
    );

    expect(result).toEqual({ allow: false, reason: "user denied bash: stdin EOF" });
  });

  // 11. Warn path: bridge receives pending with [submodule] prefix in reason
  it("Warn — bridge pending reason is prefixed with [<submodule>]", async () => {
    const bridge = new PermissionBridge();
    let capturedPending: Parameters<PermissionBridge["request"]>[0] | undefined;
    vi.spyOn(bridge, "request").mockImplementation(async (pending) => {
      capturedPending = pending;
      return { allow: true };
    });

    await bashValidationGate(
      bashInput("rm -rf /tmp/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(capturedPending).toBeDefined();
    expect(capturedPending!.reason).toMatch(/^\[[a-z-]+\]/);
  });
});
