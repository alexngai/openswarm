/**
 * Tests for the command intent classifier.
 *
 * Test cases originally derived from a reference implementation, plus openswarm-specific cases.
 */

import { describe, it, expect } from "vitest";
import { classifyCommand } from "./intent.js";

describe("classifyCommand", () => {
  // --- read-only ---

  it("classifies ls as read-only", () => {
    expect(classifyCommand("ls -la")).toBe("read-only");
  });

  it("classifies cat as read-only", () => {
    expect(classifyCommand("cat file.txt")).toBe("read-only");
  });

  it("classifies grep as read-only", () => {
    expect(classifyCommand("grep -r pattern .")).toBe("read-only");
  });

  it("classifies find as read-only", () => {
    expect(classifyCommand("find . -name '*.ts'")).toBe("read-only");
  });

  it("classifies sed without -i as read-only", () => {
    expect(classifyCommand("sed 's/old/new/' file.txt")).toBe("read-only");
  });

  it("classifies git status as read-only", () => {
    expect(classifyCommand("git status")).toBe("read-only");
  });

  it("classifies git log as read-only", () => {
    expect(classifyCommand("git log --oneline")).toBe("read-only");
  });

  it("classifies git diff as read-only", () => {
    expect(classifyCommand("git diff HEAD")).toBe("read-only");
  });

  // --- write ---

  it("classifies cp as write", () => {
    expect(classifyCommand("cp a.txt b.txt")).toBe("write");
  });

  it("classifies mv as write", () => {
    expect(classifyCommand("mv old.txt new.txt")).toBe("write");
  });

  it("classifies mkdir as write", () => {
    expect(classifyCommand("mkdir -p /tmp/dir")).toBe("write");
  });

  it("classifies touch as write", () => {
    expect(classifyCommand("touch file.txt")).toBe("write");
  });

  it("classifies sed -i as write", () => {
    expect(classifyCommand("sed -i 's/old/new/' file.txt")).toBe("write");
  });

  it("classifies git push as write", () => {
    expect(classifyCommand("git push origin main")).toBe("write");
  });

  it("classifies git commit as write", () => {
    expect(classifyCommand("git commit -m 'msg'")).toBe("write");
  });

  // --- destructive ---

  it("classifies rm as destructive", () => {
    expect(classifyCommand("rm -rf /tmp/x")).toBe("destructive");
  });

  it("classifies shred as destructive", () => {
    expect(classifyCommand("shred /dev/sda")).toBe("destructive");
  });

  it("classifies wipefs as destructive", () => {
    expect(classifyCommand("wipefs -a /dev/sda")).toBe("destructive");
  });

  // --- network ---

  it("classifies curl as network", () => {
    expect(classifyCommand("curl https://example.com")).toBe("network");
  });

  it("classifies wget as network", () => {
    expect(classifyCommand("wget file.zip")).toBe("network");
  });

  it("classifies ssh as network", () => {
    expect(classifyCommand("ssh user@host")).toBe("network");
  });

  // --- process-management ---

  it("classifies kill as process-management", () => {
    expect(classifyCommand("kill -9 1234")).toBe("process-management");
  });

  it("classifies ps as process-management", () => {
    expect(classifyCommand("ps aux")).toBe("process-management");
  });

  // --- package-management ---

  it("classifies npm as package-management", () => {
    expect(classifyCommand("npm install express")).toBe("package-management");
  });

  it("classifies brew as package-management", () => {
    expect(classifyCommand("brew install ripgrep")).toBe("package-management");
  });

  // --- system-admin ---

  it("classifies sudo as system-admin", () => {
    expect(classifyCommand("sudo apt install vim")).toBe("system-admin");
  });

  it("classifies systemctl as system-admin", () => {
    expect(classifyCommand("systemctl restart nginx")).toBe("system-admin");
  });

  // --- unknown ---

  it("classifies an unknown command as unknown", () => {
    expect(classifyCommand("xyzzy --frob")).toBe("unknown");
  });

  // --- env-var prefix stripping ---

  it("strips env-var prefix before classifying", () => {
    expect(classifyCommand("FOO=bar ls -la")).toBe("read-only");
  });

  it("strips multiple env-var prefixes before classifying", () => {
    expect(classifyCommand("A=1 B=2 rm -rf /tmp")).toBe("destructive");
  });
});
