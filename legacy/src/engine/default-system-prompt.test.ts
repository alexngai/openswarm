import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  applyPlanMode,
  BASE_SYSTEM_PROMPT,
  PLAN_MODE_SUFFIX,
} from "./default-system-prompt.js";

describe("plan mode composition", () => {
  it("appends the plan persona last when planMode is set", () => {
    const result = buildSystemPrompt({ planMode: true, roleSuffix: "ROLE" });
    expect(result).toContain(PLAN_MODE_SUFFIX);
    // Plan suffix must be the last segment (highest priority).
    expect(result.endsWith(PLAN_MODE_SUFFIX)).toBe(true);
    expect(result.indexOf("ROLE")).toBeLessThan(result.indexOf(PLAN_MODE_SUFFIX));
  });

  it("omits the plan persona when planMode is false/absent", () => {
    expect(buildSystemPrompt({ planMode: false })).not.toContain(PLAN_MODE_SUFFIX);
    expect(buildSystemPrompt({})).not.toContain(PLAN_MODE_SUFFIX);
  });

  it("applyPlanMode appends to a non-empty system prompt (native path)", () => {
    const out = applyPlanMode("SYS", "do the thing", true);
    expect(out.systemPrompt).toBe(`SYS\n\n${PLAN_MODE_SUFFIX}`);
    expect(out.prompt).toBe("do the thing");
  });

  it("applyPlanMode prepends to the prompt when system prompt is empty (SDK path)", () => {
    const out = applyPlanMode("", "do the thing", true);
    expect(out.systemPrompt).toBe("");
    expect(out.prompt.startsWith(PLAN_MODE_SUFFIX)).toBe(true);
    expect(out.prompt).toContain("do the thing");
  });

  it("applyPlanMode is a no-op when disabled", () => {
    expect(applyPlanMode("SYS", "P", false)).toEqual({ systemPrompt: "SYS", prompt: "P" });
  });
});

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

  it("base prompt contains Codex-parity behavioral sections", () => {
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

  it("base prompt contains openswarm tool references", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("edit_file");
    expect(BASE_SYSTEM_PROMPT).toContain("multi_edit");
    expect(BASE_SYSTEM_PROMPT).toContain("apply_patch");
    expect(BASE_SYSTEM_PROMPT).toContain("write_file");
    expect(BASE_SYSTEM_PROMPT).toContain("read_file");
    expect(BASE_SYSTEM_PROMPT).toContain("todo_write");
    expect(BASE_SYSTEM_PROMPT).toContain("glob");
    expect(BASE_SYSTEM_PROMPT).toContain("grep");
    expect(BASE_SYSTEM_PROMPT).toContain("bash");
    expect(BASE_SYSTEM_PROMPT).toContain("shell_exec");
    expect(BASE_SYSTEM_PROMPT).toContain("shell_write");
    expect(BASE_SYSTEM_PROMPT).toContain("shell_list");
  });

  it("base prompt contains planning guidance", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("#### Planning");
    expect(BASE_SYSTEM_PROMPT).toContain("todo_write");
    expect(BASE_SYSTEM_PROMPT).toContain("in_progress");
    expect(BASE_SYSTEM_PROMPT).toContain("completed");
  });

  it("does not contain Codex-specific product references", () => {
    const lower = BASE_SYSTEM_PROMPT.toLowerCase();
    expect(lower).not.toContain("codex cli");
    expect(lower).not.toContain("codex is");
    expect(lower).not.toContain("update_plan");
    // apply_patch is now a first-class openswarm tool, but the verbose Codex
    // patch-format instructions should still stay out of the base prompt.
    expect(lower).not.toContain("your patch language");
  });
});
