import { describe, it, expect } from "vitest";
import {
  createOrchestratorRunner,
  resolveSteerTarget,
  steerRecipients,
} from "./team-runner.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";

describe("createOrchestratorRunner", () => {
  it("constructs the runner surface; subscribe/unsubscribe resolve the lane bus", () => {
    // Guards the duck-typed StandaloneHost.events access (team-daemon's pattern).
    const runner = createOrchestratorRunner({ permissionMode: "read-only" });
    expect(typeof runner.runTeam).toBe("function");

    let calls = 0;
    const unsubscribe = runner.subscribeEvents(() => {
      calls += 1;
    });
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();

    expect(runner.getActiveTeam()).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("steer is a no-op (delivered:false) when there is no live team", async () => {
    const runner = createOrchestratorRunner({ permissionMode: "read-only" });
    const res = await runner.steer("go", "architect");
    expect(res).toEqual({ delivered: false, to: "role:architect" });
  });
});

describe("resolveSteerTarget", () => {
  it("defaults to the lead; maps bare names to roles; passes selectors through", () => {
    expect(resolveSteerTarget()).toBe("role:lead");
    expect(resolveSteerTarget("")).toBe("role:lead");
    expect(resolveSteerTarget("lead")).toBe("role:lead");
    expect(resolveSteerTarget("architect")).toBe("role:architect");
    expect(resolveSteerTarget("role:reviewer")).toBe("role:reviewer");
    expect(resolveSteerTarget("*")).toBe("*");
  });
});

describe("steerRecipients", () => {
  function m(role: string, id: string): [AgentId, MemberInfo] {
    return [
      id as AgentId,
      { memberId: `m-${id}`, role, agentId: id as AgentId, state: "running", handle: {} as MemberInfo["handle"] },
    ];
  }
  const roster = new Map<AgentId, MemberInfo>([m("lead", "L"), m("architect", "A1"), m("architect", "A2")]);

  it("defaults to the lead; resolves roles; '*' is everyone; falls back to a direct id", () => {
    expect(steerRecipients(roster)).toEqual(["L"]);
    expect(steerRecipients(roster, "lead")).toEqual(["L"]);
    expect(steerRecipients(roster, "architect").sort()).toEqual(["A1", "A2"]);
    expect(steerRecipients(roster, "role:architect").sort()).toEqual(["A1", "A2"]);
    expect(steerRecipients(roster, "*").sort()).toEqual(["A1", "A2", "L"]);
    expect(steerRecipients(roster, "A2")).toEqual(["A2"]); // direct id fallback
    expect(steerRecipients(roster, "ghost")).toEqual([]); // unknown -> none
  });
});
