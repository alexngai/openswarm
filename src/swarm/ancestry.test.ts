import { describe, it, expect } from "vitest";
import { isAncestorOf } from "./ancestry.js";
import type { AgentId } from "../core/types.js";

function id(s: string): AgentId {
  return s as AgentId;
}

describe("isAncestorOf", () => {
  it("self is always its own ancestor", () => {
    const parents = new Map<AgentId, AgentId>();
    expect(isAncestorOf(id("X"), id("X"), parents)).toBe(true);
  });

  it("3-deep chain: root → A → B → C", () => {
    const parents = new Map<AgentId, AgentId>([
      [id("A"), id("root")],
      [id("B"), id("A")],
      [id("C"), id("B")],
    ]);
    expect(isAncestorOf(id("root"), id("C"), parents)).toBe(true);
    expect(isAncestorOf(id("A"), id("C"), parents)).toBe(true);
    expect(isAncestorOf(id("B"), id("C"), parents)).toBe(true);
  });

  it("sibling: A and D share root as parent but neither is ancestor of the other", () => {
    const parents = new Map<AgentId, AgentId>([
      [id("A"), id("root")],
      [id("D"), id("root")],
    ]);
    expect(isAncestorOf(id("A"), id("D"), parents)).toBe(false);
    expect(isAncestorOf(id("D"), id("A"), parents)).toBe(false);
  });

  it("unrelated nodes with no shared ancestor return false", () => {
    const parents = new Map<AgentId, AgentId>([
      [id("B"), id("A")],
    ]);
    // C has no parent at all
    expect(isAncestorOf(id("A"), id("C"), parents)).toBe(false);
  });

  it("maxDepth sentinel stops infinite loops on corrupt data", () => {
    // Create a cycle: X → Y → X
    const parents = new Map<AgentId, AgentId>([
      [id("X"), id("Y")],
      [id("Y"), id("X")],
    ]);
    // With maxDepth=4, this should terminate and return false
    expect(isAncestorOf(id("Z"), id("X"), parents, 4)).toBe(false);
  });

  it("direct parent is an ancestor", () => {
    const parents = new Map<AgentId, AgentId>([
      [id("child"), id("parent")],
    ]);
    expect(isAncestorOf(id("parent"), id("child"), parents)).toBe(true);
    expect(isAncestorOf(id("child"), id("parent"), parents)).toBe(false);
  });
});
