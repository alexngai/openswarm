import { describe, it, expect } from "vitest";
import {
  checkBannedPrefix,
  checkBannedPrefixes,
  getBannedPrefixList,
} from "./banned-prefixes.js";

describe("checkBannedPrefix", () => {
  it("bans bare shell commands", () => {
    expect(checkBannedPrefix("bash")).toBe("bash");
    expect(checkBannedPrefix("sh")).toBe("sh");
    expect(checkBannedPrefix("zsh")).toBe("zsh");
  });

  it("bans bare interpreter commands", () => {
    expect(checkBannedPrefix("python")).toBe("python");
    expect(checkBannedPrefix("python3")).toBe("python3");
    expect(checkBannedPrefix("node")).toBe("node");
    expect(checkBannedPrefix("ruby")).toBe("ruby");
    expect(checkBannedPrefix("perl")).toBe("perl");
  });

  it("bans privilege escalation commands", () => {
    expect(checkBannedPrefix("sudo")).toBe("sudo");
    expect(checkBannedPrefix("su")).toBe("su");
  });

  it("bans remote execution commands", () => {
    expect(checkBannedPrefix("ssh")).toBe("ssh");
    expect(checkBannedPrefix("curl")).toBe("curl");
  });

  it("bans container commands", () => {
    expect(checkBannedPrefix("docker")).toBe("docker");
    expect(checkBannedPrefix("kubectl")).toBe("kubectl");
  });

  it("bans git (can execute hooks)", () => {
    expect(checkBannedPrefix("git")).toBe("git");
  });

  it("bans shell -c (can run anything)", () => {
    expect(checkBannedPrefix("bash -c")).toBe("bash");
    expect(checkBannedPrefix("sh -c 'rm -rf /'")).toBe("sh");
  });

  it("bans interpreter -c/-e", () => {
    expect(checkBannedPrefix("python -c")).toBe("python");
    expect(checkBannedPrefix("node -e")).toBe("node");
    expect(checkBannedPrefix("ruby -e 'puts 1'")).toBe("ruby");
  });

  it("allows narrowed commands with specific arguments", () => {
    expect(checkBannedPrefix("python -m pytest")).toBeNull();
    expect(checkBannedPrefix("npm test")).toBeNull();
    expect(checkBannedPrefix("git status")).toBeNull();
    expect(checkBannedPrefix("docker ps")).toBeNull();
    expect(checkBannedPrefix("curl https://example.com")).toBeNull();
  });

  it("handles full path to binary", () => {
    expect(checkBannedPrefix("/usr/bin/bash")).toBe("bash");
    expect(checkBannedPrefix("/usr/local/bin/python3")).toBe("python3");
  });

  it("is case-insensitive for command matching", () => {
    expect(checkBannedPrefix("BASH")).toBe("bash");
    expect(checkBannedPrefix("Python3")).toBe("python3");
  });

  it("allows unknown commands", () => {
    expect(checkBannedPrefix("myapp")).toBeNull();
    expect(checkBannedPrefix("eslint")).toBeNull();
    expect(checkBannedPrefix("prettier")).toBeNull();
    expect(checkBannedPrefix("vitest")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(checkBannedPrefix("")).toBeNull();
  });

  it("handles whitespace", () => {
    expect(checkBannedPrefix("  bash  ")).toBe("bash");
    expect(checkBannedPrefix("  python3  -m pytest  ")).toBeNull();
  });
});

describe("checkBannedPrefixes", () => {
  it("checks multiple prefixes at once", () => {
    const results = checkBannedPrefixes(["bash", "python", "eslint", "node"]);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.bannedCommand).sort()).toEqual(["bash", "node", "python"]);
  });

  it("returns empty for all safe prefixes", () => {
    const results = checkBannedPrefixes(["eslint .", "prettier --write", "vitest run"]);
    expect(results).toHaveLength(0);
  });
});

describe("getBannedPrefixList", () => {
  it("returns a non-empty list", () => {
    const list = getBannedPrefixList();
    expect(list.length).toBeGreaterThan(40);
  });

  it("includes key entries", () => {
    const list = getBannedPrefixList();
    expect(list).toContain("bash");
    expect(list).toContain("python");
    expect(list).toContain("sudo");
    expect(list).toContain("docker");
    expect(list).toContain("git");
  });
});
