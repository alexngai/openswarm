/**
 * Tests for the read-only mode validation submodule.
 *
 * Test cases originally derived from a reference implementation, plus openswarm-specific cases.
 */

import { describe, it, expect } from "vitest";
import { validateReadOnly } from "./read-only.js";

describe("validateReadOnly", () => {
  // --- blocked in read-only ---

  it("blocks cp in read-only mode", () => {
    const result = validateReadOnly("cp foo bar", "read-only");
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/cp/);
  });

  it("blocks mv in read-only mode", () => {
    const result = validateReadOnly("mv old new", "read-only");
    expect(result.kind).toBe("block");
  });

  it("blocks rm in read-only mode", () => {
    const result = validateReadOnly("rm -rf /tmp/x", "read-only");
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/rm/);
  });

  it("blocks touch in read-only mode", () => {
    const result = validateReadOnly("touch foo", "read-only");
    expect(result.kind).toBe("block");
  });

  it("blocks npm install in read-only mode", () => {
    const result = validateReadOnly("npm install express", "read-only");
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/npm/);
  });

  it("blocks brew install in read-only mode", () => {
    const result = validateReadOnly("brew install ripgrep", "read-only");
    expect(result.kind).toBe("block");
  });

  it("blocks docker in read-only mode", () => {
    const result = validateReadOnly("docker run ubuntu", "read-only");
    expect(result.kind).toBe("block");
  });

  it("blocks write redirection > in read-only mode", () => {
    const result = validateReadOnly("echo hi > foo", "read-only");
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/redirection/i);
  });

  it("blocks write redirection >> in read-only mode", () => {
    const result = validateReadOnly("echo hi >> foo", "read-only");
    expect(result.kind).toBe("block");
  });

  it("blocks sudo rm in read-only mode", () => {
    const result = validateReadOnly("sudo rm -rf /tmp/x", "read-only");
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/rm/);
  });

  it("blocks git push in read-only mode", () => {
    const result = validateReadOnly("git push origin main", "read-only");
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/push/);
  });

  it("blocks git commit in read-only mode", () => {
    const result = validateReadOnly("git commit -m 'msg'", "read-only");
    expect(result.kind).toBe("block");
  });

  // --- allowed in read-only ---

  it("allows cat in read-only mode", () => {
    expect(validateReadOnly("cat /etc/hosts", "read-only").kind).toBe("allow");
  });

  it("allows ls in read-only mode", () => {
    expect(validateReadOnly("ls -la", "read-only").kind).toBe("allow");
  });

  it("allows grep in read-only mode", () => {
    expect(validateReadOnly("grep -r pattern .", "read-only").kind).toBe("allow");
  });

  it("allows git status in read-only mode", () => {
    expect(validateReadOnly("git status", "read-only").kind).toBe("allow");
  });

  it("allows git log in read-only mode", () => {
    expect(validateReadOnly("git log --oneline", "read-only").kind).toBe("allow");
  });

  it("allows git diff in read-only mode", () => {
    expect(validateReadOnly("git diff HEAD", "read-only").kind).toBe("allow");
  });

  it("allows git fetch in read-only mode", () => {
    expect(validateReadOnly("git fetch origin", "read-only").kind).toBe("allow");
  });

  // --- non-read-only modes pass through ---

  it("allows rm in workspace-write mode", () => {
    expect(validateReadOnly("rm -rf /tmp/x", "workspace-write").kind).toBe("allow");
  });

  it("allows npm install in workspace-write mode", () => {
    expect(validateReadOnly("npm install express", "workspace-write").kind).toBe("allow");
  });

  it("allows rm in danger-full-access mode", () => {
    expect(validateReadOnly("rm -rf /", "danger-full-access").kind).toBe("allow");
  });
});
