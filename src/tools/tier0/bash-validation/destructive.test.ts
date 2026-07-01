/**
 * Tests for the destructive command warning submodule.
 *
 * Ported from claw's bash_validation.rs tests + openswarm-specific cases.
 */

import { describe, it, expect } from "vitest";
import { validateDestructive } from "./destructive.js";

describe("validateDestructive", () => {
  // --- claw-ported cases ---

  it("warns on rm -rf /", () => {
    const result = validateDestructive("rm -rf /");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/root/i);
  });

  it("warns on rm -rf ~ (home directory)", () => {
    const result = validateDestructive("rm -rf ~");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/home directory/i);
  });

  it("warns on rm -rf * (all files in cwd)", () => {
    const result = validateDestructive("rm -rf *");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/all files/i);
  });

  it("warns on rm -rf . (current directory)", () => {
    const result = validateDestructive("rm -rf .");
    expect(result.kind).toBe("warn");
  });

  it("warns on mkfs (filesystem creation)", () => {
    const result = validateDestructive("mkfs.ext4 /dev/sda1");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/Filesystem creation/i);
  });

  it("warns on dd if= (direct disk write)", () => {
    const result = validateDestructive("dd if=/dev/zero of=/dev/sda");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/disk/i);
  });

  it("warns on fork bomb :(){ :|:& };:", () => {
    const result = validateDestructive(":(){ :|:& };:");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/Fork bomb/i);
  });

  it("warns on shred (always destructive)", () => {
    const result = validateDestructive("shred /dev/sda");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/destructive/i);
  });

  it("warns on wipefs (always destructive)", () => {
    const result = validateDestructive("wipefs -a /dev/sda");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/destructive/i);
  });

  it("warns on chmod -R 777 (world-writable permissions)", () => {
    const result = validateDestructive("chmod -R 777 /tmp/dir");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/world-writable/i);
  });

  it("warns on chmod -R 000 (removing all permissions)", () => {
    const result = validateDestructive("chmod -R 000 /tmp/dir");
    expect(result.kind).toBe("warn");
  });

  it("does not treat /tmp subpaths as root deletion", () => {
    const result = validateDestructive("rm -rf /tmp/mydir && git clone repo /tmp/mydir");
    expect(result.kind).toBe("allow");
  });

  // Generic rm -rf warning for non-specific targets
  it("warns on rm -rf with arbitrary non-temp target", () => {
    const result = validateDestructive("rm -rf /workspace/mydir");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/Recursive forced deletion/i);
  });

  it("warns on exact root deletion but not root-prefixed paths", () => {
    const root = validateDestructive("rm -rf /");
    expect(root.kind).toBe("warn");
    expect(root.kind === "warn" && root.message).toMatch(/root/i);

    const tmp = validateDestructive("rm -rf /tmp/sotopia");
    expect(tmp.kind).toBe("allow");
  });

  // --- safe commands ---

  it("allows ls -la", () => {
    expect(validateDestructive("ls -la").kind).toBe("allow");
  });

  it("allows echo hello", () => {
    expect(validateDestructive("echo hello").kind).toBe("allow");
  });

  it("allows cat file.txt", () => {
    expect(validateDestructive("cat file.txt").kind).toBe("allow");
  });

  it("allows git status", () => {
    expect(validateDestructive("git status").kind).toBe("allow");
  });

  // --- openswarm-specific ---

  it("warns on > /dev/sd (writing to raw disk device)", () => {
    const result = validateDestructive("echo data > /dev/sda");
    expect(result.kind).toBe("warn");
    expect(result.kind === "warn" && result.message).toMatch(/disk device/i);
  });
});
