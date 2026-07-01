/**
 * Tests for the mode validation submodule.
 *
 * Ported from claw's bash_validation.rs tests + openswarm-specific cases.
 */

import { describe, it, expect } from "vitest";
import { validateMode } from "./mode.js";

describe("validateMode", () => {
  // --- workspace-write ---

  it("warns on sudo command in workspace-write mode", () => {
    const result = validateMode("sudo apt install vim", "workspace-write");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/system-administrator/i);
  });

  it("warns on systemctl in workspace-write mode", () => {
    const result = validateMode("systemctl restart nginx", "workspace-write");
    expect(result.kind).toBe("warn");
  });

  it("warns on cp targeting /etc/ in workspace-write mode", () => {
    const result = validateMode("cp file.txt /etc/config", "workspace-write");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/outside the workspace/i);
  });

  it("warns on rm targeting /usr/ in workspace-write mode", () => {
    const result = validateMode("rm /usr/local/bin/mytool", "workspace-write");
    expect(result.kind).toBe("warn");
  });

  it("allows local writes in workspace-write mode", () => {
    expect(validateMode("cp file.txt ./backup/", "workspace-write").kind).toBe("allow");
  });

  it("allows cat in workspace-write mode", () => {
    expect(validateMode("cat file.txt", "workspace-write").kind).toBe("allow");
  });

  it("allows npm install in workspace-write mode", () => {
    // npm is package-management intent, not system-admin
    expect(validateMode("npm install express", "workspace-write").kind).toBe("allow");
  });

  // --- read-only (deferred to read-only submodule) ---

  it("allows in read-only mode (deferred to read-only submodule)", () => {
    // mode.ts returns allow for read-only — the read-only submodule handles blocking.
    expect(validateMode("rm -rf /tmp", "read-only").kind).toBe("allow");
  });

  // --- danger-full-access ---

  it("allows sudo apt install in danger-full-access mode", () => {
    expect(validateMode("sudo apt install vim", "danger-full-access").kind).toBe("allow");
  });

  it("allows systemctl in danger-full-access mode", () => {
    expect(validateMode("systemctl restart nginx", "danger-full-access").kind).toBe("allow");
  });

  it("allows cp to /etc/ in danger-full-access mode", () => {
    expect(validateMode("cp file.txt /etc/config", "danger-full-access").kind).toBe("allow");
  });
});
