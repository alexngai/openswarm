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
  toolCall?: { title?: string; kind?: string; _meta?: { swarm?: { member?: { id?: string; role?: string } } } };
  options?: Array<{ optionId: string }>;
}

function connReturning(outcome: unknown): {
  conn: {
    requestPermission: (r: Captured) => Promise<{ outcome: unknown }>;
    sessionUpdate: (n: unknown) => Promise<void>;
  };
  captured: () => Captured;
  narrations: () => unknown[];
} {
  let captured: Captured = {};
  const narrations: unknown[] = [];
  return {
    conn: {
      requestPermission: async (r) => {
        captured = r;
        return { outcome };
      },
      // Parking narrates the question via sessionUpdate.
      sessionUpdate: async (n) => {
        narrations.push(n);
      },
    },
    captured: () => captured,
    narrations: () => narrations,
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

  it("(B1.1) attaches _meta.swarm.member to toolCall; title still carries [role] (invariant §1)", async () => {
    const { r, captured } = router({ outcome: "selected", optionId: "allow" });
    await r.requestPermission(req);
    const tc = captured().toolCall;
    // _meta enrichment
    expect(tc?._meta?.swarm?.member?.id).toBe("m-wkr-1");
    expect(tc?._meta?.swarm?.member?.role).toBe("architect");
    // Standard field title still present (invariant §1)
    expect(tc?.title).toContain("[architect]");
  });

  it("(B1.1) no _meta on toolCall when agentId not in roster", async () => {
    const { conn, captured } = connReturning({ outcome: "selected", optionId: "allow" });
    const r = new AcpPermissionRouter();
    r.setConn(conn as never);
    r.setActiveSession("s1");
    r.setRoster(() => new Map()); // empty roster
    await r.requestPermission(req);
    expect(captured().toolCall?._meta).toBeUndefined();
  });

  it("denies when no active session is set", async () => {
    const r = new AcpPermissionRouter();
    r.setConn({ requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }) } as never);
    const res = await r.requestPermission(req);
    expect(res.outcome).toBe("deny");
    expect(res.reason).toContain("no active");
  });

  // A conn that records call count + peak concurrency, with controllable timing.
  function instrumentedConn(
    handler: (r: Captured) => Promise<{ outcome: unknown }>,
  ) {
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const conn = {
      requestPermission: async (r: Captured) => {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await handler(r);
        } finally {
          inFlight -= 1;
        }
      },
    };
    return { conn, stats: () => ({ calls, peak }) };
  }

  function mkRouter(conn: unknown) {
    const r = new AcpPermissionRouter();
    r.setConn(conn as never);
    r.setActiveSession("s1");
    r.setRoster(() => roster);
    return r;
  }

  it("persists allow_always team-wide: a later same-tool request skips the prompt (Q2)", async () => {
    const { conn, stats } = instrumentedConn(async () => ({
      outcome: { outcome: "selected", optionId: "allow_always" },
    }));
    const r = mkRouter(conn);
    expect((await r.requestPermission(req)).outcome).toBe("allow");
    expect((await r.requestPermission(req)).outcome).toBe("allow");
    // Only the first request prompted; the second was auto-allowed.
    expect(stats().calls).toBe(1);
  });

  it("allow_always is scoped per tool (bash being allowed doesn't allow write_file)", async () => {
    const { conn, stats } = instrumentedConn(async () => ({
      outcome: { outcome: "selected", optionId: "allow_always" },
    }));
    const r = mkRouter(conn);
    await r.requestPermission(req); // bash -> prompt (call 1), now always-allowed
    await r.requestPermission(req); // bash -> auto-allowed, no prompt
    const other = { ...req, toolName: "write_file" };
    await r.requestPermission(other); // write_file -> prompt (call 2)
    await r.requestPermission(other); // write_file -> auto-allowed
    expect(stats().calls).toBe(2); // each distinct tool prompted exactly once
  });

  it("serializes prompts so concurrent escalations never stack modals (Q2)", async () => {
    const { conn, stats } = instrumentedConn(async () => {
      await new Promise((res) => setTimeout(res, 10));
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    const r = mkRouter(conn);
    await Promise.all([
      r.requestPermission({ ...req, toolName: "bash" }),
      r.requestPermission({ ...req, toolName: "write_file" }),
      r.requestPermission({ ...req, toolName: "edit_file" }),
    ]);
    expect(stats().calls).toBe(3);
    expect(stats().peak).toBe(1); // never two outstanding at once
  });

  it("askUserQuestion maps options to a prompt and returns the selected answer", async () => {
    const { conn, captured } = connReturning({ outcome: "selected", optionId: "opt:1" });
    const r = mkRouter(conn);
    const res = await r.askUserQuestion("Pick one", ["alpha", "beta", "gamma"]);
    expect(res).toEqual({ status: "answered", answer: "beta" });
    const c = captured();
    expect(c.toolCall?.title).toBe("Pick one");
    expect(c.options?.map((o) => o.optionId)).toEqual([
      "opt:0",
      "opt:1",
      "opt:2",
      "__cancel",
    ]);
  });

  it("askUserQuestion returns cancelled on reject/cancel", async () => {
    const r1 = mkRouter(connReturning({ outcome: "selected", optionId: "__cancel" }).conn);
    expect((await r1.askUserQuestion("Q", ["a"])).status).toBe("cancelled");
    const r2 = mkRouter(connReturning({ outcome: "cancelled" }).conn);
    expect((await r2.askUserQuestion("Q", ["a"])).status).toBe("cancelled");
  });

  it("parks an open-ended question (no options); answer resolves it (Q1)", async () => {
    const { conn, narrations } = connReturning({});
    const r = mkRouter(conn);
    const p = r.askUserQuestion("What is your name?"); // parks (pending)
    await new Promise((res) => setImmediate(res));
    expect(r.hasParkedQuestion()).toBe(true);
    // The question was narrated to the client.
    expect(JSON.stringify(narrations())).toContain("What is your name?");
    // whenParked resolves now that one is parked.
    await r.whenParked();
    expect(r.answerParkedQuestion("Ada")).toBe(true);
    expect(await p).toEqual({ status: "answered", answer: "Ada" });
    expect(r.hasParkedQuestion()).toBe(false);
  });

  it("rejects a second open-ended question while one is parked", async () => {
    const { conn } = connReturning({});
    const r = mkRouter(conn);
    void r.askUserQuestion("first?");
    await new Promise((res) => setImmediate(res));
    const second = await r.askUserQuestion("second?");
    expect(second.status).toBe("error");
  });

  it("cancelParkedQuestion resolves a parked ask as cancelled", async () => {
    const { conn } = connReturning({});
    const r = mkRouter(conn);
    const p = r.askUserQuestion("hold on?");
    await new Promise((res) => setImmediate(res));
    r.cancelParkedQuestion();
    expect(await p).toEqual({ status: "cancelled" });
    expect(r.hasParkedQuestion()).toBe(false);
  });

  it("askUserQuestion errors when no active session is set", async () => {
    const r = new AcpPermissionRouter();
    r.setConn({ requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "opt:0" } }) } as never);
    const res = await r.askUserQuestion("Q", ["a"]);
    expect(res.status).toBe("error");
  });

  it("coalesces a same-tool burst: one allow_always answer auto-allows the rest", async () => {
    const { conn, stats } = instrumentedConn(async () => {
      await new Promise((res) => setTimeout(res, 10));
      return { outcome: { outcome: "selected", optionId: "allow_always" } };
    });
    const r = mkRouter(conn);
    const results = await Promise.all([
      r.requestPermission(req),
      r.requestPermission(req),
      r.requestPermission(req),
    ]);
    expect(results.every((x) => x.outcome === "allow")).toBe(true);
    // Only the first prompted; the queued two saw allow_always and skipped.
    expect(stats().calls).toBe(1);
  });
});
