import { describe, it, expect } from "vitest";
import { RoleIndex } from "./role-index.js";
import type { AgentId } from "../core/types.js";

describe("RoleIndex", () => {
  it("register + agentsInRole roundtrip", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    const b = "b" as AgentId;
    r.register(a, "reviewer");
    r.register(b, "reviewer");
    const members = r.agentsInRole("reviewer");
    expect(members).toHaveLength(2);
    expect(new Set(members)).toEqual(new Set([a, b]));
  });

  it("register overwrites prior role for the same agent (moves from old set)", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    r.register(a, "reviewer");
    expect(r.agentsInRole("reviewer")).toEqual([a]);
    r.register(a, "architect");
    expect(r.agentsInRole("reviewer")).toEqual([]);
    expect(r.agentsInRole("architect")).toEqual([a]);
    expect(r.roleOf(a)).toBe("architect");
  });

  it("evict removes from both maps", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    const b = "b" as AgentId;
    r.register(a, "reviewer");
    r.register(b, "reviewer");
    r.evict(a);
    expect(r.agentsInRole("reviewer")).toEqual([b]);
    expect(r.roleOf(a)).toBeUndefined();
  });

  it("roleOf returns the current role, undefined for unknown agent", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    expect(r.roleOf(a)).toBeUndefined();
    r.register(a, "architect");
    expect(r.roleOf(a)).toBe("architect");
  });

  it("agentsInRole for an unknown role returns []", () => {
    const r = new RoleIndex();
    expect(r.agentsInRole("ghost")).toEqual([]);
  });

  it("evict on an unregistered agent is a no-op", () => {
    const r = new RoleIndex();
    expect(() => r.evict("ghost" as AgentId)).not.toThrow();
    expect(r.size()).toBe(0);
  });

  it("when the last agent leaves a role, the role entry is cleaned up", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    r.register(a, "reviewer");
    r.evict(a);
    // Fresh register under same role should start from empty.
    const b = "b" as AgentId;
    r.register(b, "reviewer");
    expect(r.agentsInRole("reviewer")).toEqual([b]);
  });
});
