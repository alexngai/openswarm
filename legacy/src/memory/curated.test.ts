import { describe, it, expect, afterEach } from "vitest";
import {
  executeCuratedAction,
  getCuratedMemory,
  parseEntries,
  formatEntries,
  scopeKey,
  resetCuratedMemoryStore,
  setCuratedMemoryLimits,
  resetCuratedMemoryLimits,
  getCuratedMemoryLimits,
} from "./curated.js";

afterEach(() => {
  resetCuratedMemoryStore();
  resetCuratedMemoryLimits();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("parseEntries", () => {
  it("parses non-empty lines", () => {
    expect(parseEntries("alpha\nbeta\ngamma")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("skips empty lines", () => {
    expect(parseEntries("alpha\n\nbeta\n")).toEqual(["alpha", "beta"]);
  });

  it("returns empty array for blank content", () => {
    expect(parseEntries("")).toEqual([]);
    expect(parseEntries("   ")).toEqual([]);
  });
});

describe("formatEntries", () => {
  it("numbers entries starting at 1", () => {
    expect(formatEntries(["a", "b", "c"])).toBe("1. a\n2. b\n3. c");
  });

  it("returns empty string for empty array", () => {
    expect(formatEntries([])).toBe("");
  });
});

describe("scopeKey", () => {
  it("builds project key", () => {
    expect(scopeKey("project", "/home/user/repo")).toBe("project:/home/user/repo");
  });

  it("builds user key", () => {
    expect(scopeKey("user", "alice")).toBe("user:alice");
  });
});

// ---------------------------------------------------------------------------
// CRUD actions
// ---------------------------------------------------------------------------

describe("executeCuratedAction — add", () => {
  it("adds an entry to empty memory", () => {
    const result = executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Project uses TypeScript",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual(["Project uses TypeScript"]);
      expect(result.formatted).toBe("1. Project uses TypeScript");
    }
  });

  it("appends to existing entries", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "First fact",
    });
    const result = executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Second fact",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toHaveLength(2);
      expect(result.entries[1]).toBe("Second fact");
    }
  });

  it("rejects empty entry", () => {
    const result = executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when exceeding size limit", () => {
    setCuratedMemoryLimits({ projectMaxChars: 50 });
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Short entry",
    });
    const result = executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "This is a very long entry that will definitely exceed the character limit",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exceed");
    }
  });

  it("trims whitespace", () => {
    const result = executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "  trimmed  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries[0]).toBe("trimmed");
    }
  });
});

describe("executeCuratedAction — replace", () => {
  it("replaces entry by index", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Original",
    });
    const result = executeCuratedAction({
      action: "replace",
      scope: "project",
      scopeIdentifier: "/test",
      index: 1,
      replacement: "Updated",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries[0]).toBe("Updated");
    }
  });

  it("rejects out-of-range index", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Only entry",
    });
    const result = executeCuratedAction({
      action: "replace",
      scope: "project",
      scopeIdentifier: "/test",
      index: 5,
      replacement: "Nope",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("out of range");
    }
  });

  it("rejects missing replacement text", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Entry",
    });
    const result = executeCuratedAction({
      action: "replace",
      scope: "project",
      scopeIdentifier: "/test",
      index: 1,
      replacement: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing index", () => {
    const result = executeCuratedAction({
      action: "replace",
      scope: "project",
      scopeIdentifier: "/test",
      replacement: "New",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("index");
    }
  });
});

describe("executeCuratedAction — remove", () => {
  it("removes entry by index", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "First",
    });
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Second",
    });
    const result = executeCuratedAction({
      action: "remove",
      scope: "project",
      scopeIdentifier: "/test",
      index: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entries).toEqual(["Second"]);
      expect(result.formatted).toBe("1. Second");
    }
  });

  it("rejects out-of-range index", () => {
    const result = executeCuratedAction({
      action: "remove",
      scope: "project",
      scopeIdentifier: "/test",
      index: 1,
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scope isolation
// ---------------------------------------------------------------------------

describe("scope isolation", () => {
  it("project and user scopes are independent", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo",
      entry: "Project fact",
    });
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "alice",
      entry: "User preference",
    });

    expect(getCuratedMemory(scopeKey("project", "/repo"))).toContain("Project fact");
    expect(getCuratedMemory(scopeKey("user", "alice"))).toContain("User preference");
    expect(getCuratedMemory(scopeKey("project", "/repo"))).not.toContain("User preference");
  });

  it("different project roots are independent", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo-a",
      entry: "Fact A",
    });
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/repo-b",
      entry: "Fact B",
    });

    expect(getCuratedMemory(scopeKey("project", "/repo-a"))).toContain("Fact A");
    expect(getCuratedMemory(scopeKey("project", "/repo-a"))).not.toContain("Fact B");
  });
});

// ---------------------------------------------------------------------------
// getCuratedMemory
// ---------------------------------------------------------------------------

describe("getCuratedMemory", () => {
  it("returns null for non-existent scope", () => {
    expect(getCuratedMemory(scopeKey("project", "/nope"))).toBeNull();
  });

  it("returns formatted entries", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Alpha",
    });
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Beta",
    });
    const result = getCuratedMemory(scopeKey("project", "/test"));
    expect(result).toBe("1. Alpha\n2. Beta");
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe("executeCuratedAction — replace exceeding size limit", () => {
  it("rolls back replacement when it would exceed limit", () => {
    setCuratedMemoryLimits({ projectMaxChars: 50 });
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/test",
      entry: "Short",
    });
    const result = executeCuratedAction({
      action: "replace",
      scope: "project",
      scopeIdentifier: "/test",
      index: 1,
      replacement: "This replacement is way too long and will definitely exceed the character limit set above",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exceed");
    }
    const memory = getCuratedMemory(scopeKey("project", "/test"));
    expect(memory).toContain("Short");
  });
});

describe("limits", () => {
  it("respects user scope limits separately", () => {
    setCuratedMemoryLimits({ userMaxChars: 30 });
    const result = executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "alice",
      entry: "This entry is way too long for the tiny user limit that we set",
    });
    expect(result.ok).toBe(false);
  });

  it("getCuratedMemoryLimits returns current values", () => {
    const defaults = getCuratedMemoryLimits();
    expect(defaults.projectMaxChars).toBe(2500);
    expect(defaults.userMaxChars).toBe(1500);

    setCuratedMemoryLimits({ projectMaxChars: 5000 });
    const updated = getCuratedMemoryLimits();
    expect(updated.projectMaxChars).toBe(5000);
    expect(updated.userMaxChars).toBe(1500);
  });
});
