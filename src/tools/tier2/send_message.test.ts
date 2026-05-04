/**
 * Integration tests for send_message + check_inbox tools.
 *
 * Rather than mock ctx.host, these wire up a real StandaloneHost with
 * recipient agents registered directly in the `depths` map. That keeps the
 * tests focused on the host.send routing semantics (direct / "*" / role /
 * unknown / depth-1 scope) without dragging in the subprocess pipeline.
 */

import { describe, it, expect } from "vitest";
import { StandaloneHost } from "../../swarm/standalone-host.js";
import type { SwarmHost, AgentMessage } from "../../swarm/host.js";
import type { AgentId } from "../../core/types.js";
import { sendMessageTool } from "./send_message.js";
import { checkInboxTool } from "./check_inbox.js";
import { RoleIndex } from "../../swarm/role-index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register a peer on the host at the given depth without spawning a real
 * subprocess. Writes directly into `depths` and optionally the role index
 * so `send()` can resolve it.
 */
function registerPeer(
  host: StandaloneHost,
  agentId: AgentId,
  depth: number,
  role?: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const depths: Map<AgentId, number> = (host as any).depths;
  depths.set(agentId, depth);
  if (role !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ri: RoleIndex = (host as any).roles;
    ri.register("swarm:default", agentId, role);
  }
}

/**
 * Build a SwarmHost façade that pretends to be a given agent, delegating to
 * the underlying StandaloneHost for routing. This lets us invoke the tool as
 * if it were running inside a worker at depth N.
 */
function hostAs(root: StandaloneHost, agentId: AgentId, depth: number): SwarmHost {
  return {
    mode: "standalone",
    kind: "standalone",
    agentId,
    depth,
    permissionMode: "workspace-write",
    emit: () => undefined,
    spawn: () => {
      throw new Error("spawn not used in this test");
    },
    isAncestorOf: (ancestor, descendant) => root.isAncestorOf(ancestor, descendant),
    send: (to, message) => root.send(to, message),
    inbox: async function* () {
      return;
    },
    drainInbox: async (max: number) =>
      // v0.6 stage 6A.1: messageInbox.drain is now (scope, agent, max) → Promise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((root as any).messageInbox as {
        drain: (scope: string, id: AgentId, n: number) => Promise<AgentMessage[]>;
      }).drain("swarm:default", agentId, max),
    askUser: (): never => {
      throw new Error("M3b Phase 6 — not yet implemented");
    },
    task: root.task,
  };
}

const CTX_CWD = process.cwd();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("send_message + check_inbox", () => {
  it("direct send → recipient's check_inbox returns the message", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1);

    const hostA = hostAs(root, A, 1);
    const sendResult = await sendMessageTool.execute(
      { to: B, content: "hello" },
      { cwd: CTX_CWD, host: hostA },
    );
    expect(sendResult.status).toBe("ok");
    const parsed = JSON.parse(
      (sendResult as { status: "ok"; output: string }).output,
    );
    expect(parsed).toEqual({ delivered: 1, dropped: 0, partial: false });

    const hostB = hostAs(root, B, 1);
    const drained = await checkInboxTool.execute(
      { max: 10 },
      { cwd: CTX_CWD, host: hostB },
    );
    expect(drained.status).toBe("ok");
    const msgs = JSON.parse(
      (drained as { status: "ok"; output: string }).output,
    ) as AgentMessage[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      from: A,
      to: B,
      content: "hello",
    });
  });

  it('broadcast "*" fans out to depth-1 peers only (excludes root + sender) (M6 regression)', async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    const C = "C" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1);
    registerPeer(root, C, 1);

    const hostA = hostAs(root, A, 1);
    const res = await sendMessageTool.execute(
      { to: "*", content: "ping everyone" },
      { cwd: CTX_CWD, host: hostA },
    );
    expect(res.status).toBe("ok");
    const parsed = JSON.parse(
      (res as { status: "ok"; output: string }).output,
    );
    // B + C receive; A excluded as sender; root (R, depth 0) excluded by
    // design — nothing drains root's inbox, so fanning to it would leak.
    expect(parsed.delivered).toBe(2);

    // Sender A should NOT have received its own broadcast.
    const aInbox = await hostAs(root, A, 1).drainInbox(10);
    expect(aInbox).toEqual([]);

    // B and C each receive exactly one.
    expect(await hostAs(root, B, 1).drainInbox(10)).toHaveLength(1);
    expect(await hostAs(root, C, 1).drainInbox(10)).toHaveLength(1);

    // Root's own inbox stays empty — the core guarantee of the M6 fix.
    expect(await root.drainInbox(10)).toEqual([]);
  });

  it("role broadcast only reaches agents registered under that role", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    const C = "C" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1, "worker");
    registerPeer(root, C, 1, "reviewer");

    const hostA = hostAs(root, A, 1);
    const res = await sendMessageTool.execute(
      { to: "role:reviewer", content: "review this" },
      { cwd: CTX_CWD, host: hostA },
    );
    expect(res.status).toBe("ok");
    const parsed = JSON.parse(
      (res as { status: "ok"; output: string }).output,
    );
    expect(parsed.delivered).toBe(1);

    // Only C receives.
    expect(await hostAs(root, B, 1).drainInbox(10)).toEqual([]);
    const cMsgs = await hostAs(root, C, 1).drainInbox(10);
    expect(cMsgs).toHaveLength(1);
    expect(cMsgs[0]!.content).toBe("review this");
  });

  it("direct send to an unknown recipient surfaces unknown_recipient reason", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    registerPeer(root, A, 1);

    const res = await sendMessageTool.execute(
      { to: "ghost", content: "anyone?" },
      { cwd: CTX_CWD, host: hostAs(root, A, 1) },
    );
    expect(res.status).toBe("error");
    expect((res as { status: "error"; message: string }).message).toContain(
      "unknown_recipient",
    );
  });

  it("empty inbox → check_inbox returns []", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    registerPeer(root, A, 1);

    const res = await checkInboxTool.execute(
      { max: 10 },
      { cwd: CTX_CWD, host: hostAs(root, A, 1) },
    );
    expect(res.status).toBe("ok");
    expect(
      JSON.parse((res as { status: "ok"; output: string }).output),
    ).toEqual([]);
  });

  it("partial drain: max=2 returns 2 oldest, then rest, then []", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1);

    const hostA = hostAs(root, A, 1);
    for (let i = 0; i < 5; i++) {
      await sendMessageTool.execute(
        { to: B, content: `m${i}` },
        { cwd: CTX_CWD, host: hostA },
      );
    }

    const hostB = hostAs(root, B, 1);
    const first = await checkInboxTool.execute(
      { max: 2 },
      { cwd: CTX_CWD, host: hostB },
    );
    const firstMsgs = JSON.parse(
      (first as { status: "ok"; output: string }).output,
    ) as AgentMessage[];
    expect(firstMsgs.map((m) => m.content)).toEqual(["m0", "m1"]);

    const rest = await checkInboxTool.execute(
      { max: 10 },
      { cwd: CTX_CWD, host: hostB },
    );
    const restMsgs = JSON.parse(
      (rest as { status: "ok"; output: string }).output,
    ) as AgentMessage[];
    expect(restMsgs.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);

    const empty = await checkInboxTool.execute(
      { max: 10 },
      { cwd: CTX_CWD, host: hostB },
    );
    expect(
      JSON.parse((empty as { status: "ok"; output: string }).output),
    ).toEqual([]);
  });

  it("messages queued while target is busy are returned later on check_inbox", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1);

    const hostA = hostAs(root, A, 1);
    // Simulate "B is mid-turn": three messages pile up before B drains.
    await sendMessageTool.execute(
      { to: B, content: "one" },
      { cwd: CTX_CWD, host: hostA },
    );
    await sendMessageTool.execute(
      { to: B, content: "two" },
      { cwd: CTX_CWD, host: hostA },
    );
    await sendMessageTool.execute(
      { to: B, content: "three" },
      { cwd: CTX_CWD, host: hostA },
    );

    // B finally drains — all three appear.
    const drained = await checkInboxTool.execute(
      { max: 10 },
      { cwd: CTX_CWD, host: hostAs(root, B, 1) },
    );
    const msgs = JSON.parse(
      (drained as { status: "ok"; output: string }).output,
    ) as AgentMessage[];
    expect(msgs.map((m) => m.content)).toEqual(["one", "two", "three"]);
  });

  it("depth-2 sender is rejected with depth>1 reason", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const grandchild = "G" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, grandchild, 2);

    const res = await sendMessageTool.execute(
      { to: A, content: "hi from depth 2" },
      { cwd: CTX_CWD, host: hostAs(root, grandchild, 2) },
    );
    expect(res.status).toBe("error");
    expect((res as { status: "error"; message: string }).message).toContain(
      "depth>1",
    );
  });

  it("sender is excluded from role broadcast when it holds the same role", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    registerPeer(root, A, 1, "reviewer");
    registerPeer(root, B, 1, "reviewer");

    const res = await sendMessageTool.execute(
      { to: "role:reviewer", content: "reviewer-only" },
      { cwd: CTX_CWD, host: hostAs(root, A, 1) },
    );
    expect(res.status).toBe("ok");
    const parsed = JSON.parse(
      (res as { status: "ok"; output: string }).output,
    );
    expect(parsed.delivered).toBe(1);

    // Sender A should not see its own message.
    expect(await hostAs(root, A, 1).drainInbox(10)).toEqual([]);
    // B receives exactly one.
    expect(await hostAs(root, B, 1).drainInbox(10)).toHaveLength(1);
  });
});
