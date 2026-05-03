import { describe, it, expect } from "vitest";
import { RoleIndex } from "./role-index.js";
import type { AgentId } from "../core/types.js";

describe("RoleIndex", () => {
  it("register + agentsInRole roundtrip", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    const b = "b" as AgentId;
    r.register("swarm:default", a, "reviewer");
    r.register("swarm:default", b, "reviewer");
    const members = r.agentsInRole("swarm:default", "reviewer");
    expect(members).toHaveLength(2);
    expect(new Set(members)).toEqual(new Set([a, b]));
  });

  it("register overwrites prior role for the same agent (moves from old set)", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    r.register("swarm:default", a, "reviewer");
    expect(r.agentsInRole("swarm:default", "reviewer")).toEqual([a]);
    r.register("swarm:default", a, "architect");
    expect(r.agentsInRole("swarm:default", "reviewer")).toEqual([]);
    expect(r.agentsInRole("swarm:default", "architect")).toEqual([a]);
    expect(r.roleOf(a)).toEqual({ scope: "swarm:default", role: "architect" });
  });

  it("evict removes from both maps", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    const b = "b" as AgentId;
    r.register("swarm:default", a, "reviewer");
    r.register("swarm:default", b, "reviewer");
    r.evict(a);
    expect(r.agentsInRole("swarm:default", "reviewer")).toEqual([b]);
    expect(r.roleOf(a)).toBeUndefined();
  });

  it("roleOf returns the current role, undefined for unknown agent", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    expect(r.roleOf(a)).toBeUndefined();
    r.register("swarm:default", a, "architect");
    expect(r.roleOf(a)).toEqual({ scope: "swarm:default", role: "architect" });
  });

  it("agentsInRole for an unknown role returns []", () => {
    const r = new RoleIndex();
    expect(r.agentsInRole("swarm:default", "ghost")).toEqual([]);
  });

  it("evict on an unregistered agent is a no-op", () => {
    const r = new RoleIndex();
    expect(() => r.evict("ghost" as AgentId)).not.toThrow();
    expect(r.size()).toBe(0);
  });

  it("when the last agent leaves a role, the role entry is cleaned up", () => {
    const r = new RoleIndex();
    const a = "a" as AgentId;
    r.register("swarm:default", a, "reviewer");
    r.evict(a);
    // Fresh register under same role should start from empty.
    const b = "b" as AgentId;
    r.register("swarm:default", b, "reviewer");
    expect(r.agentsInRole("swarm:default", "reviewer")).toEqual([b]);
  });

  it("isolates members across scopes — same role name in two scopes does not cross-broadcast", () => {
    const r = new RoleIndex();
    const a = "agent-a" as AgentId;
    const b = "agent-b" as AgentId;
    r.register("swarm:team-a", a, "reviewer");
    r.register("swarm:team-b", b, "reviewer");
    expect(r.agentsInRole("swarm:team-a", "reviewer")).toEqual([a]);
    expect(r.agentsInRole("swarm:team-b", "reviewer")).toEqual([b]);
  });

  it("re-registering an agent in a different scope evicts its prior scope/role", () => {
    const r = new RoleIndex();
    const a = "agent-a" as AgentId;
    r.register("swarm:team-a", a, "reviewer");
    r.register("swarm:team-b", a, "reviewer");
    expect(r.agentsInRole("swarm:team-a", "reviewer")).toEqual([]);
    expect(r.agentsInRole("swarm:team-b", "reviewer")).toEqual([a]);
    expect(r.roleOf(a)).toEqual({ scope: "swarm:team-b", role: "reviewer" });
  });
});
