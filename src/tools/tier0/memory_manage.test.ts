import { describe, it, expect, afterEach } from "vitest";
import { memoryManageTool } from "./memory_manage.js";
import { resetCuratedMemoryStore, resetCuratedMemoryLimits } from "../../memory/curated.js";
import type { ToolExecutionContext } from "../types.js";

afterEach(() => {
  resetCuratedMemoryStore();
  resetCuratedMemoryLimits();
});

function ctx(cwd = "/home/user/project"): ToolExecutionContext {
  return { cwd };
}

describe("memoryManageTool", () => {
  it("has correct spec", () => {
    expect(memoryManageTool.spec.name).toBe("memory_manage");
    expect(memoryManageTool.spec.tier).toBe(0);
    expect(memoryManageTool.spec.requiredPermission).toBe("none");
    expect(memoryManageTool.spec.concurrencySafe).toBe(false);
  });

  it("adds a project memory entry", async () => {
    const result = await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Uses Vitest for testing" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("1. Uses Vitest for testing");
      expect(result.output).toContain("project memory");
      expect(result.output).toContain("1 entries");
    }
  });

  it("adds a user memory entry", async () => {
    const result = await memoryManageTool.execute(
      { action: "add", scope: "user", entry: "Prefers dark theme" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("1. Prefers dark theme");
      expect(result.output).toContain("user memory");
    }
  });

  it("replaces an entry by index", async () => {
    await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Original" },
      ctx(),
    );
    const result = await memoryManageTool.execute(
      { action: "replace", scope: "project", index: 1, replacement: "Updated" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("1. Updated");
      expect(result.output).not.toContain("Original");
    }
  });

  it("removes an entry by index", async () => {
    await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "First" },
      ctx(),
    );
    await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Second" },
      ctx(),
    );
    const result = await memoryManageTool.execute(
      { action: "remove", scope: "project", index: 1 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("1. Second");
      expect(result.output).not.toContain("First");
    }
  });

  it("shows empty state after removing all entries", async () => {
    await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Only" },
      ctx(),
    );
    const result = await memoryManageTool.execute(
      { action: "remove", scope: "project", index: 1 },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("empty");
    }
  });

  it("returns error for invalid input", async () => {
    const result = await memoryManageTool.execute(
      { action: "add" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("returns error for out-of-range index", async () => {
    const result = await memoryManageTool.execute(
      { action: "remove", scope: "project", index: 99 },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("uses cwd as project scope identifier", async () => {
    await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Fact A" },
      ctx("/repo-a"),
    );
    await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Fact B" },
      ctx("/repo-b"),
    );

    const resultA = await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Fact C" },
      ctx("/repo-a"),
    );
    expect(resultA.status).toBe("ok");
    if (resultA.status === "ok") {
      expect(resultA.output).toContain("Fact A");
      expect(resultA.output).toContain("Fact C");
      expect(resultA.output).not.toContain("Fact B");
    }
  });

  it("returns error when add exceeds character limit", async () => {
    const { setCuratedMemoryLimits } = await import("../../memory/curated.js");
    setCuratedMemoryLimits({ projectMaxChars: 30 });

    const result = await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "This entry is way too long for the tiny limit we set" },
      ctx(),
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("exceed");
    }
  });

  it("shows character usage in output", async () => {
    const result = await memoryManageTool.execute(
      { action: "add", scope: "project", entry: "Test" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toMatch(/\d+\/\d+ chars/);
    }
  });
});
