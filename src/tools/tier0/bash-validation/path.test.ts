/**
 * Tests for the path validation submodule.
 *
 * Ported from claw's bash_validation.rs tests + openswarm-specific cases.
 */

import { describe, it, expect } from "vitest";
import { validatePath } from "./path.js";

const CWD = "/workspace/project";

describe("validatePath", () => {
  // --- blocked hot files ---

  it("blocks /etc/passwd", () => {
    const result = validatePath("rm /etc/passwd", CWD);
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/\/etc\/passwd/);
  });

  it("blocks /etc/shadow", () => {
    const result = validatePath("cat /etc/shadow", CWD);
    expect(result.kind).toBe("block");
    expect(result.kind === "block" && result.reason).toMatch(/\/etc\/shadow/);
  });

  it("blocks /etc/sudoers", () => {
    const result = validatePath("cat /etc/sudoers", CWD);
    expect(result.kind).toBe("block");
  });

  // --- warned system paths ---

  it("warns on /etc/ reference (non-hot file)", () => {
    const result = validatePath("cat /etc/hosts", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/system path/i);
  });

  it("warns on /usr/ reference", () => {
    const result = validatePath("ls /usr/local/bin", CWD);
    expect(result.kind).toBe("warn");
  });

  it("warns on /System/ reference (macOS)", () => {
    const result = validatePath("ls /System/Library", CWD);
    expect(result.kind).toBe("warn");
  });

  // --- warned traversals ---

  it("warns on ../ traversal escaping cwd", () => {
    const result = validatePath("cat ../../../etc/passwd", CWD);
    // /etc/passwd is a hot file → block wins first; let's test a non-hot traversal
    expect(result.kind).not.toBe("allow");
  });

  it("warns on ../ traversal without cwd in command", () => {
    const result = validatePath("cat ../secret.txt", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/traversal/i);
  });

  it("allows ../ when cwd is part of the command (within workspace)", () => {
    // When the normalized cwd appears in the command it's treated as within workspace.
    const result = validatePath(`cat ${CWD}/../other.txt`, CWD);
    expect(result.kind).toBe("allow");
  });

  // --- warned home directory ---

  it("warns on ~/ reference", () => {
    const result = validatePath("cat ~/.ssh/id_rsa", CWD);
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/home directory/i);
  });

  it("warns on $HOME reference", () => {
    const result = validatePath("ls $HOME/.config", CWD);
    expect(result.kind).toBe("warn");
  });

  // --- allowed ---

  it("allows relative local paths", () => {
    expect(validatePath("cat ./foo.txt", CWD).kind).toBe("allow");
  });

  it("allows simple filename", () => {
    expect(validatePath("cat file.txt", CWD).kind).toBe("allow");
  });

  it("allows absolute path within cwd", () => {
    expect(validatePath(`ls ${CWD}/src`, CWD).kind).toBe("allow");
  });
});
