import { describe, it, expect, afterEach } from "vitest";
import { curatedMemoryFragment } from "./fragment.js";
import {
  executeCuratedAction,
  resetCuratedMemoryStore,
  resetCuratedMemoryLimits,
} from "./curated.js";
import type { ContextState } from "../context/index.js";

afterEach(() => {
  resetCuratedMemoryStore();
  resetCuratedMemoryLimits();
});

function baseState(overrides?: Partial<ContextState>): ContextState {
  return {
    cwd: "/home/user/project",
    permissionMode: "workspace-write",
    model: "test-model",
    ...overrides,
  };
}

describe("curatedMemoryFragment", () => {
  it("has correct id and priority", () => {
    expect(curatedMemoryFragment.id).toBe("curated-memory");
    expect(curatedMemoryFragment.priority).toBe(5);
  });

  it("returns null when no memory exists", () => {
    const result = curatedMemoryFragment.generate(baseState());
    expect(result).toBeNull();
  });

  it("returns null when no projectRoot or userId set", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/project",
      entry: "Test fact",
    });
    const result = curatedMemoryFragment.generate(baseState());
    expect(result).toBeNull();
  });

  it("includes project memory when projectRoot is set", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/my-project",
      entry: "Uses TypeScript",
    });
    const result = curatedMemoryFragment.generate(
      baseState({ projectRoot: "/my-project" }),
    );
    expect(result).toContain("## Project Memory");
    expect(result).toContain("1. Uses TypeScript");
  });

  it("includes user memory when userId is set", () => {
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "alice",
      entry: "Prefers dark mode",
    });
    const result = curatedMemoryFragment.generate(
      baseState({ userId: "alice" }),
    );
    expect(result).toContain("## User Memory");
    expect(result).toContain("1. Prefers dark mode");
  });

  it("includes both scopes when both are present", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/project",
      entry: "Project fact",
    });
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "bob",
      entry: "User pref",
    });
    const result = curatedMemoryFragment.generate(
      baseState({ projectRoot: "/project", userId: "bob" }),
    );
    expect(result).toContain("## User Memory");
    expect(result).toContain("## Project Memory");
    expect(result).toContain("User pref");
    expect(result).toContain("Project fact");
  });

  it("puts user memory before project memory", () => {
    executeCuratedAction({
      action: "add",
      scope: "project",
      scopeIdentifier: "/p",
      entry: "P",
    });
    executeCuratedAction({
      action: "add",
      scope: "user",
      scopeIdentifier: "u",
      entry: "U",
    });
    const result = curatedMemoryFragment.generate(
      baseState({ projectRoot: "/p", userId: "u" }),
    )!;
    expect(result.indexOf("User Memory")).toBeLessThan(
      result.indexOf("Project Memory"),
    );
  });
});
