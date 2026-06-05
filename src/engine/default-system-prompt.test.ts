import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  BASE_SYSTEM_PROMPT,
} from "./default-system-prompt.js";

describe("default-system-prompt", () => {
  it("returns base prompt when called with no options", () => {
    const result = buildSystemPrompt();
    expect(result).toBe(BASE_SYSTEM_PROMPT);
  });

  it("returns base prompt when called with empty options", () => {
    const result = buildSystemPrompt({});
    expect(result).toBe(BASE_SYSTEM_PROMPT);
  });

  it("appends cwd after base prompt", () => {
    const result = buildSystemPrompt({ cwd: "/home/user/project" });
    expect(result).toContain(BASE_SYSTEM_PROMPT);
    expect(result).toContain("Current working directory: /home/user/project");
    const cwdIndex = result.indexOf("Current working directory:");
    const baseIndex = result.indexOf(BASE_SYSTEM_PROMPT);
    expect(cwdIndex).toBeGreaterThan(baseIndex);
  });

  it("appends extensions after base prompt", () => {
    const ext = "Always use TypeScript strict mode.";
    const result = buildSystemPrompt({ extensions: ext });
    expect(result).toContain(BASE_SYSTEM_PROMPT);
    expect(result).toContain(ext);
  });

  it("appends role suffix last", () => {
    const ext = "Team rule: use spaces not tabs.";
    const role = "You are the executor.";
    const result = buildSystemPrompt({ extensions: ext, roleSuffix: role });
    const extIndex = result.indexOf(ext);
    const roleIndex = result.indexOf(role);
    expect(roleIndex).toBeGreaterThan(extIndex);
  });

  it("orders segments: base, cwd, extensions, role", () => {
    const result = buildSystemPrompt({
      cwd: "/tmp",
      extensions: "EXT",
      roleSuffix: "ROLE",
    });
    const baseIdx = result.indexOf("You are a coding agent");
    const cwdIdx = result.indexOf("Current working directory: /tmp");
    const extIdx = result.indexOf("EXT");
    const roleIdx = result.indexOf("ROLE");
    expect(baseIdx).toBeLessThan(cwdIdx);
    expect(cwdIdx).toBeLessThan(extIdx);
    expect(extIdx).toBeLessThan(roleIdx);
  });

  it("skips empty extensions", () => {
    const result = buildSystemPrompt({ extensions: "" });
    expect(result).toBe(BASE_SYSTEM_PROMPT);
  });

  it("skips empty role suffix", () => {
    const result = buildSystemPrompt({ roleSuffix: "" });
    expect(result).toBe(BASE_SYSTEM_PROMPT);
  });

  it("joins segments with double newlines", () => {
    const result = buildSystemPrompt({
      extensions: "EXT",
      roleSuffix: "ROLE",
    });
    expect(result).toContain(BASE_SYSTEM_PROMPT + "\n\nEXT\n\nROLE");
  });

  it("base prompt contains key Codex-parity sections", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("## How you work");
    expect(BASE_SYSTEM_PROMPT).toContain("### Personality");
    expect(BASE_SYSTEM_PROMPT).toContain("### AGENTS.md spec");
    expect(BASE_SYSTEM_PROMPT).toContain("### Responsiveness");
    expect(BASE_SYSTEM_PROMPT).toContain("#### Task execution");
    expect(BASE_SYSTEM_PROMPT).toContain("### Validating your work");
    expect(BASE_SYSTEM_PROMPT).toContain("### Ambition vs. precision");
    expect(BASE_SYSTEM_PROMPT).toContain("### Sharing progress updates");
    expect(BASE_SYSTEM_PROMPT).toContain("### Presenting your work and final message");
    expect(BASE_SYSTEM_PROMPT).toContain("#### Final answer structure and style guidelines");
    expect(BASE_SYSTEM_PROMPT).toContain("## Tool guidelines");
    expect(BASE_SYSTEM_PROMPT).toContain("## Safety");
  });

  it("does not contain Codex product references", () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).not.toContain("codex cli");
    expect(lower).not.toContain("codex is");
    expect(lower).not.toContain("apply_patch");
    expect(lower).not.toContain("update_plan");
  });
});
