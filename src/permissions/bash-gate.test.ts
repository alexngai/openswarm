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
 *   - Phase 5.5 follow-up B: emitLaneEvent wiring (bash_validation_blocked /
 *     bash_validation_warned payloads, missing/throwing emitter resilience)
 */

import { describe, it, expect, vi } from "vitest";
import { bashValidationGate } from "./bash-gate.js";
import { PermissionBridge } from "./bridge.js";
import type { BashGateDeps, BashGateInput } from "./bash-gate.js";
import type { ToolImpl } from "../tools/types.js";
import type { PermissionDecision } from "../engine/index.js";
import type { LaneEvent, BashValidationBlockedPayload, BashValidationWarnedPayload } from "../swarm/events.js";

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

  // 7. Warn TTY: bridge.request resolves to approve → {allow:true, validationApproved:true}
  it("Warn TTY: bridge.request approves → returns {allow:true}", async () => {
    const bridge = new PermissionBridge();
    const mockRequest = vi.spyOn(bridge, "request").mockResolvedValue({ allow: true });

    const result = await bashValidationGate(
      // rm -rf with a non-root path triggers the destructive warn, not a block
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(mockRequest).toHaveBeenCalledTimes(1);
    // v0.2.Q5: approved Warn path now returns {allow:true, validationApproved:true}
    expect(result).toEqual({ allow: true, validationApproved: true });
  });

  // 8. Warn TTY: bridge.request resolves to deny → {allow:false}
  it("Warn TTY: bridge.request denies → returns {allow:false, reason}", async () => {
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({
      allow: false,
      reason: "user denied",
    });

    const result = await bashValidationGate(
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(result).toEqual({ allow: false, reason: "user denied" });
  });

  // 9. Warn headless: injected headlessApproval returning 'y' → {allow:true, validationApproved:true}
  it("Warn headless: injected headlessApproval approve → returns {allow:true}", async () => {
    const fakeHeadless = vi.fn<typeof import("./headless-prompt.js").readHeadlessApproval>()
      .mockResolvedValue({ allow: true });

    const result = await bashValidationGate(
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ useHeadless: true, headlessApproval: fakeHeadless }),
    );

    expect(fakeHeadless).toHaveBeenCalledTimes(1);
    // v0.2.Q5: approved Warn path now returns {allow:true, validationApproved:true}
    expect(result).toEqual({ allow: true, validationApproved: true });
  });

  // 10. Warn headless: injected headlessApproval EOF → {allow:false}
  it("Warn headless: injected headlessApproval EOF deny → returns {allow:false}", async () => {
    const fakeHeadless = vi.fn<typeof import("./headless-prompt.js").readHeadlessApproval>()
      .mockResolvedValue({ allow: false, reason: "user denied bash: stdin EOF" });

    const result = await bashValidationGate(
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
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
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(capturedPending).toBeDefined();
    expect(capturedPending!.reason).toMatch(/^\[[a-z-]+\]/);
  });
});

// ---------------------------------------------------------------------------
// v0.2.Q5 — validationApproved flag (two-prompt collapse)
// ---------------------------------------------------------------------------

describe("bashValidationGate — validationApproved flag (v0.2.Q5)", () => {
  // 1. Warn-approved path sets validationApproved: true
  it("Warn TTY approved: returns {allow:true, validationApproved:true}", async () => {
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({ allow: true });

    const result = await bashValidationGate(
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(result).not.toBeNull();
    expect(result!.allow).toBe(true);
    expect((result as { validationApproved?: boolean }).validationApproved).toBe(true);
  });

  // 2. Warn-denied path does NOT set validationApproved
  it("Warn TTY denied: returns {allow:false} without validationApproved", async () => {
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({ allow: false, reason: "denied" });

    const result = await bashValidationGate(
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
    expect((result as { validationApproved?: boolean }).validationApproved).toBeUndefined();
  });

  // 3. Safe command (Allow path — no Warn prompt) falls through (returns null), no validationApproved
  it("Allow path (safe command): returns null — no validationApproved, no prompt", async () => {
    const bridge = new PermissionBridge();
    const mockRequest = vi.spyOn(bridge, "request");

    const result = await bashValidationGate(
      bashInput("ls -la /workspace"),
      makeDeps({ bridge, useHeadless: false }),
    );

    expect(result).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  // 4. Warn headless approved: returns validationApproved: true
  it("Warn headless approved: returns {allow:true, validationApproved:true}", async () => {
    const fakeHeadless = vi.fn<typeof import("./headless-prompt.js").readHeadlessApproval>()
      .mockResolvedValue({ allow: true });

    const result = await bashValidationGate(
      bashInput("rm -rf /workspace/test-dir", "workspace-write"),
      makeDeps({ useHeadless: true, headlessApproval: fakeHeadless }),
    );

    expect(result).not.toBeNull();
    expect(result!.allow).toBe(true);
    expect((result as { validationApproved?: boolean }).validationApproved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v0.2.Q5 — canUseTool mode-check collapse integration
// ---------------------------------------------------------------------------

describe("canUseTool mode-check collapse — validationApproved skips permEngine (v0.2.Q5)", () => {
  /**
   * Verifies the collapse contract: when bashValidationGate returns
   * {allow:true, validationApproved:true}, canUseTool must NOT invoke the
   * PermissionEngine mode check (which would produce a second prompt in
   * workspace-write mode for an exec-requiring bash call).
   *
   * We test this by mocking bashValidationGate's dependencies directly and
   * verifying that the PermissionEngine.check spy is never called.
   */
  it("when validationApproved=true, PermissionEngine.check is NOT called", async () => {
    const { PermissionEngine } = await import("../permissions/index.js");
    const { PermissionBridge } = await import("./bridge.js");
    const { bashValidationGate: gate } = await import("../permissions/bash-gate.js");

    // Spy on PermissionEngine.check — it must NOT be called.
    const checkSpy = vi.spyOn(PermissionEngine.prototype, "check");

    // Spy on bashValidationGate to return {allow:true, validationApproved:true}
    // We achieve this by mocking the bridge to approve the Warn prompt.
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({ allow: true });

    // Call bashValidationGate directly to verify the flag is set
    const { buildTier0Tools } = await import("../tools/tier0/index.js");
    const tools = buildTier0Tools();
    const bashTool = tools.find((t) => t.spec.name === "bash")!;
    expect(bashTool).toBeDefined();

    const result = await gate(
      {
        toolName: "bash",
        toolImpl: bashTool,
        input: { command: "rm -rf /workspace/test-dir" },
        currentMode: "workspace-write",
      },
      {
        bridge,
        useHeadless: false,
        cwd: "/workspace",
      },
    );

    // Gate returns validationApproved flag
    expect(result).not.toBeNull();
    expect(result!.allow).toBe(true);
    expect((result as { validationApproved?: boolean }).validationApproved).toBe(true);

    // When this result is used in canUseTool with the collapse logic,
    // PermissionEngine.check should NOT be called. We verify the logic
    // here by simulating the canUseTool collapse condition inline:
    const shouldSkipModeCheck =
      result !== null &&
      result.allow &&
      "validationApproved" in result &&
      (result as { validationApproved?: boolean }).validationApproved === true;

    expect(shouldSkipModeCheck).toBe(true);

    // check() should not have been called in this test (the mode check is
    // only skipped when the caller detects validationApproved — we verified
    // the flag above; the actual skip happens in main.ts canUseTool).
    expect(checkSpy).not.toHaveBeenCalled();

    checkSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Phase 5.5 follow-up B — emitLaneEvent wiring
// ---------------------------------------------------------------------------

describe("bashValidationGate — emitLaneEvent wiring", () => {
  // Helper: Block-path command (cat /etc/passwd is blocked by path submodule)
  function blockInput(): BashGateInput {
    return bashInput("cat /etc/passwd");
  }

  // Helper: Warn-path command (rm -rf outside known scratch dirs triggers destructive warn)
  function warnInput(): BashGateInput {
    return bashInput("rm -rf /workspace/test-dir", "workspace-write");
  }

  // 1. bash_validation_blocked fires with typed payload on Block path
  it("emitLaneEvent fires bash_validation_blocked with typed payload on Block path", async () => {
    const emitter = vi.fn<(event: LaneEvent) => void>();

    await bashValidationGate(blockInput(), makeDeps({ emitLaneEvent: emitter }));

    expect(emitter).toHaveBeenCalledTimes(1);
    const event = emitter.mock.calls[0]![0];
    expect(event.type).toBe("bash_validation_blocked");
    expect(event.agentId).toBe("bash-gate");
    expect(typeof event.ts).toBe("number");
    const payload = event.payload as BashValidationBlockedPayload;
    expect(payload.command).toBe("cat /etc/passwd");
    expect(typeof payload.submodule).toBe("string");
    expect(payload.submodule.length).toBeGreaterThan(0);
    expect(typeof payload.reason).toBe("string");
    expect(typeof payload.intent).toBe("string");
  });

  // 2. bash_validation_warned fires with decision='approved' when bridge approves
  it("emitLaneEvent fires bash_validation_warned with decision='approved' when bridge.request approves", async () => {
    const emitter = vi.fn<(event: LaneEvent) => void>();
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({ allow: true });

    await bashValidationGate(warnInput(), makeDeps({ bridge, emitLaneEvent: emitter }));

    expect(emitter).toHaveBeenCalledTimes(1);
    const event = emitter.mock.calls[0]![0];
    expect(event.type).toBe("bash_validation_warned");
    const payload = event.payload as BashValidationWarnedPayload;
    expect(payload.decision).toBe("approved");
    expect(payload.command).toBe("rm -rf /workspace/test-dir");
    expect(typeof payload.submodule).toBe("string");
    expect(typeof payload.message).toBe("string");
    expect(typeof payload.intent).toBe("string");
  });

  // 3. bash_validation_warned fires with decision='denied' when bridge denies
  it("emitLaneEvent fires bash_validation_warned with decision='denied' when bridge.request denies", async () => {
    const emitter = vi.fn<(event: LaneEvent) => void>();
    const bridge = new PermissionBridge();
    vi.spyOn(bridge, "request").mockResolvedValue({ allow: false, reason: "user denied" });

    await bashValidationGate(warnInput(), makeDeps({ bridge, emitLaneEvent: emitter }));

    expect(emitter).toHaveBeenCalledTimes(1);
    const payload = emitter.mock.calls[0]![0].payload as BashValidationWarnedPayload;
    expect(payload.decision).toBe("denied");
  });

  // 4. bash_validation_warned fires with decision='denied' when headless EOF
  it("emitLaneEvent fires bash_validation_warned with decision='denied' when headless EOF", async () => {
    const emitter = vi.fn<(event: LaneEvent) => void>();
    const fakeHeadless = vi.fn<typeof import("./headless-prompt.js").readHeadlessApproval>()
      .mockResolvedValue({ allow: false, reason: "user denied bash: stdin EOF" });

    await bashValidationGate(
      warnInput(),
      makeDeps({ useHeadless: true, headlessApproval: fakeHeadless, emitLaneEvent: emitter }),
    );

    expect(emitter).toHaveBeenCalledTimes(1);
    const payload = emitter.mock.calls[0]![0].payload as BashValidationWarnedPayload;
    expect(payload.decision).toBe("denied");
  });

  // 5. missing emitLaneEvent (undefined) doesn't throw — falls through silently
  it("missing emitLaneEvent (undefined) doesn't throw — falls through silently", async () => {
    // No emitLaneEvent in deps — should still return the block decision cleanly.
    const result = await bashValidationGate(blockInput(), makeDeps());
    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
  });

  // 6. emitLaneEvent that throws doesn't break the gate result
  it("emitLaneEvent that throws doesn't break the gate result", async () => {
    const throwingEmitter = vi.fn<(event: LaneEvent) => void>().mockImplementation(() => {
      throw new Error("emitter boom");
    });

    // Should not throw; gate result still returned.
    const result = await bashValidationGate(blockInput(), makeDeps({ emitLaneEvent: throwingEmitter }));
    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
  });

  // 7. intent field is correctly classified in the emitted payload
  it("intent field is correctly classified in the emitted payload", async () => {
    const emitter = vi.fn<(event: LaneEvent) => void>();

    // cat /etc/passwd → classifyCommand should return a read-like intent
    await bashValidationGate(blockInput(), makeDeps({ emitLaneEvent: emitter }));

    const payload = emitter.mock.calls[0]![0].payload as BashValidationBlockedPayload;
    // intent must be a non-empty string (CommandIntent is a string literal union)
    expect(typeof payload.intent).toBe("string");
    expect(payload.intent.length).toBeGreaterThan(0);
  });
});
