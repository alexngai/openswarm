/**
 * Integration tests for the validateBashCommand top-level dispatcher.
 *
 * Tests the pipeline ordering and first-non-allow wins semantics.
 */

import { describe, it, expect } from "vitest";
import { validateBashCommand } from "./index.js";

const CWD = "/workspace/project";

describe("validateBashCommand (pipeline)", () => {
  // --- read-only blocks ---

  it("blocks rm in read-only mode (read-only submodule fires)", () => {
    const result = validateBashCommand("rm -rf /tmp/x", "read-only", CWD);
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.submodule).toBe("read-only");
  });

  it("blocks npm install in read-only mode", () => {
    const result = validateBashCommand("npm install express", "read-only", CWD);
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.submodule).toBe("read-only");
  });

  it("blocks echo hi > foo in read-only mode", () => {
    const result = validateBashCommand("echo hi > foo", "read-only", CWD);
    expect(result.kind).toBe("block");
  });

  it("allows ls -la in read-only mode", () => {
    expect(validateBashCommand("ls -la", "read-only", CWD).kind).toBe("allow");
  });

  it("allows cat in read-only mode", () => {
    expect(validateBashCommand("cat file.txt", "read-only", CWD).kind).toBe("allow");
  });

  it("allows git log in read-only mode", () => {
    expect(validateBashCommand("git log --oneline", "read-only", CWD).kind).toBe("allow");
  });

  // --- destructive warns (any mode) ---

  it("warns on rm -rf / in workspace-write mode (destructive submodule)", () => {
    const result = validateBashCommand("rm -rf /", "workspace-write", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.submodule).toBe("destructive");
  });

  it("warns on rm -rf / even in danger-full-access mode", () => {
    const result = validateBashCommand("rm -rf /", "danger-full-access", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.submodule).toBe("destructive");
  });

  it("warns on shred in workspace-write mode", () => {
    const result = validateBashCommand("shred /dev/sda", "workspace-write", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.submodule).toBe("destructive");
  });

  // --- sed warns ---

  it("warns on sed -i in workspace-write mode (sed submodule)", () => {
    const result = validateBashCommand("sed -i 's/a/b/' foo", "workspace-write", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.submodule).toBe("sed");
  });

  it("allows sed -i.bak in workspace-write mode", () => {
    expect(validateBashCommand("sed -i.bak 's/a/b/' foo", "workspace-write", CWD).kind).toBe("allow");
  });

  // --- path blocks ---

  it("blocks /etc/passwd reference (path submodule)", () => {
    const result = validateBashCommand("cat /etc/passwd", "workspace-write", CWD);
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.submodule).toBe("path");
  });

  // --- mode warns ---

  it("warns on sudo apt install in workspace-write mode (mode submodule)", () => {
    const result = validateBashCommand("sudo apt install vim", "workspace-write", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.submodule).toBe("mode");
  });

  it("allows sudo apt install in danger-full-access mode", () => {
    expect(validateBashCommand("sudo apt install vim", "danger-full-access", CWD).kind).toBe("allow");
  });

  // --- safe commands ---

  it("allows git status in workspace-write mode", () => {
    expect(validateBashCommand("git status", "workspace-write", CWD).kind).toBe("allow");
  });

  it("allows grep in workspace-write mode", () => {
    expect(validateBashCommand("grep -r foo .", "workspace-write", CWD).kind).toBe("allow");
  });

  // --- read-only blocks before destructive warns ---
  // rm -rf / in read-only mode: the read-only submodule fires first (blocks rm),
  // so we never reach the destructive submodule.
  it("blocks rm in read-only mode (not warn) — read-only fires before destructive", () => {
    const result = validateBashCommand("rm -rf /", "read-only", CWD);
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.submodule).toBe("read-only");
  });
});
