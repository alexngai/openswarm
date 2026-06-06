import { describe, it, expect, afterEach } from "vitest";
import {
  requestPermissionsTool,
  setPermissionRequestHandler,
  clearPermissionRequestHandler,
} from "./request_permissions.js";
import type { ToolExecutionContext, ToolResult } from "../types.js";
import type { PermissionMode } from "../../core/types.js";

afterEach(() => {
  clearPermissionRequestHandler();
});

const ctx: ToolExecutionContext = {
  cwd: "/tmp",
};

function installHandler(
  currentMode: PermissionMode,
  grantResult: { granted: boolean; newMode: PermissionMode } = {
    granted: true,
    newMode: "danger-full-access",
  },
) {
  setPermissionRequestHandler({
    getCurrentMode: () => currentMode,
    requestElevation: async () => grantResult,
  });
}

function expectOk(result: ToolResult): asserts result is { status: "ok"; output: string } {
  expect(result.status).toBe("ok");
}

function expectError(result: ToolResult): asserts result is { status: "error"; message: string } {
  expect(result.status).toBe("error");
}

describe("request_permissions tool", () => {
  it("has correct spec fields", () => {
    expect(requestPermissionsTool.spec.name).toBe("request_permissions");
    expect(requestPermissionsTool.spec.tier).toBe(0);
    expect(requestPermissionsTool.spec.requiredPermission).toBe("none");
  });

  it("rejects invalid input", async () => {
    installHandler("read-only");
    const result = await requestPermissionsTool.execute({}, ctx);
    expectError(result);
  });

  it("rejects invalid mode enum", async () => {
    installHandler("read-only");
    const result = await requestPermissionsTool.execute(
      { mode: "super-admin", reason: "please" },
      ctx,
    );
    expectError(result);
  });

  it("returns error when no handler is installed", async () => {
    const result = await requestPermissionsTool.execute(
      { mode: "workspace-write", reason: "need to edit" },
      ctx,
    );
    expectError(result);
    expect(result.message).toMatch(/not available/);
  });

  it("short-circuits when already at requested mode", async () => {
    installHandler("workspace-write");
    const result = await requestPermissionsTool.execute(
      { mode: "workspace-write", reason: "need write" },
      ctx,
    );
    expectOk(result);
    const out = JSON.parse(result.output);
    expect(out.granted).toBe(true);
    expect(out.message).toMatch(/Already at/);
  });

  it("short-circuits when current mode is higher", async () => {
    installHandler("danger-full-access");
    const result = await requestPermissionsTool.execute(
      { mode: "workspace-write", reason: "need write" },
      ctx,
    );
    expectOk(result);
    const out = JSON.parse(result.output);
    expect(out.granted).toBe(true);
  });

  it("requests elevation and returns granted", async () => {
    installHandler("read-only", {
      granted: true,
      newMode: "workspace-write",
    });
    const result = await requestPermissionsTool.execute(
      { mode: "workspace-write", reason: "need to create files" },
      ctx,
    );
    expectOk(result);
    const out = JSON.parse(result.output);
    expect(out.granted).toBe(true);
    expect(out.newMode).toBe("workspace-write");
    expect(out.message).toMatch(/elevated/i);
  });

  it("requests elevation and returns denied", async () => {
    installHandler("read-only", {
      granted: false,
      newMode: "read-only",
    });
    const result = await requestPermissionsTool.execute(
      { mode: "danger-full-access", reason: "need root" },
      ctx,
    );
    expectOk(result);
    const out = JSON.parse(result.output);
    expect(out.granted).toBe(false);
    expect(out.newMode).toBe("read-only");
    expect(out.message).toMatch(/denied/i);
  });

  it("handles handler error gracefully", async () => {
    setPermissionRequestHandler({
      getCurrentMode: () => "read-only",
      requestElevation: async () => {
        throw new Error("approval service down");
      },
    });
    const result = await requestPermissionsTool.execute(
      { mode: "workspace-write", reason: "test" },
      ctx,
    );
    expectError(result);
    expect(result.message).toMatch(/approval service down/);
  });
});
