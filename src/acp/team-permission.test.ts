import { describe, it, expect } from "vitest";
import { AcpPermissionRouter } from "./team-permission.js";
import type { MemberInfo } from "../swarm/team-session.js";
import type { AgentId } from "../core/types.js";
import type { PermissionRequest } from "../swarm/host.js";

function member(role: string, agentId: string): MemberInfo {
  return {
    memberId: `m-${agentId}`,
    role,
    agentId: agentId as AgentId,
    state: "running",
    handle: {} as MemberInfo["handle"],
  };
}

interface Captured {
  sessionId?: string;
  toolCall?: { title?: string; kind?: string };
  options?: Array<{ optionId: string }>;
}

function connReturning(outcome: unknown): {
  conn: { requestPermission: (r: Captured) => Promise<{ outcome: unknown }> };
  captured: () => Captured;
} {
  let captured: Captured = {};
  return {
    conn: {
      requestPermission: async (r) => {
        captured = r;
        return { outcome };
      },
    },
    captured: () => captured,
  };
}

const req: PermissionRequest = {
  toolName: "bash",
  input: { command: "rm x" },
  requiredPermission: "execute",
  currentMode: "read-only",
  agentId: "wkr-1",
};

const roster = new Map<AgentId, MemberInfo>([
  ["wkr-1" as AgentId, member("architect", "wkr-1")],
]);

describe("AcpPermissionRouter", () => {
  function router(outcome: unknown) {
    const { conn, captured } = connReturning(outcome);
    const r = new AcpPermissionRouter();
    r.setConn(conn as never);
    r.setActiveSession("s1");
    r.setRoster(() => roster);
    return { r, captured };
  }

  it("routes to the client with a [role]-attributed title; maps allow", async () => {
    const { r, captured } = router({ outcome: "selected", optionId: "allow" });
    const res = await r.requestPermission(req);
    expect(res).toEqual({ outcome: "allow" });
    const c = captured();
    expect(c.sessionId).toBe("s1");
    expect(c.toolCall?.title).toContain("[architect]");
    expect(c.toolCall?.kind).toBe("execute");
    expect(c.options?.map((o) => o.optionId)).toEqual([
      "allow_always",
      "allow",
      "reject",
    ]);
  });

  it("maps reject to deny", async () => {
    const { r } = router({ outcome: "selected", optionId: "reject" });
    expect((await r.requestPermission(req)).outcome).toBe("deny");
  });

  it("maps cancelled to deny", async () => {
    const { r } = router({ outcome: "cancelled" });
    expect((await r.requestPermission(req)).outcome).toBe("deny");
  });

  it("denies when no active session is set", async () => {
    const r = new AcpPermissionRouter();
    r.setConn({ requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }) } as never);
    const res = await r.requestPermission(req);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toContain("no active");
  });
});
