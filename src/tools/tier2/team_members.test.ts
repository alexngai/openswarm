/**
 * Tests for team_members tool — v0.4 stage 4E.1.
 *
 * Standalone path: wires a real StandaloneHost with agents registered into
 * `agentToScope` + RoleIndex directly (avoids the subprocess pipeline). The
 * tool is invoked through a hostAs façade so it appears as a worker peer.
 *
 * Worker path: uses a fake transport with a `send` mock to verify the IPC
 * method, params, and result are wired end-to-end through WorkerHost.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { StandaloneHost } from "../../swarm/standalone-host.js";
import { WorkerHost } from "../../swarm/worker-host.js";
import type { ParentTransport } from "../../swarm/ipc/parent-transport.js";
import type { SwarmHost, AgentMessage } from "../../swarm/host.js";
import type { AgentId, PermissionMode } from "../../core/types.js";
import { teamMembersTool } from "./team_members.js";
import { RoleIndex } from "../../swarm/role-index.js";

// ---------------------------------------------------------------------------
// Helpers (mirror send_message.test.ts)
// ---------------------------------------------------------------------------

function registerPeer(
  host: StandaloneHost,
  agentId: AgentId,
  depth: number,
  scope: string,
  role: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const depths: Map<AgentId, number> = (host as any).depths;
  depths.set(agentId, depth);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scopes: Map<AgentId, string> = (host as any).agentToScope;
  scopes.set(agentId, scope);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ri: RoleIndex = (host as any).roles;
  ri.register(scope, agentId, role);
}

function hostAs(
  root: StandaloneHost,
  agentId: AgentId,
  depth: number,
): SwarmHost {
  const base: SwarmHost = {
    mode: "standalone",
    kind: "standalone",
    agentId,
    depth,
    permissionMode: "workspace-write",
    emit: () => undefined,
    spawn: () => {
      throw new Error("spawn not used in this test");
    },
    isAncestorOf: (a: AgentId, d: AgentId) => root.isAncestorOf(a, d),
    send: (
      to: AgentId | "*" | `role:${string}`,
      message: AgentMessage,
    ) => root.send(to, message),
    inbox: async function* () {
      return;
    },
    drainInbox: async (max: number) =>
      // v0.6 stage 6A.1: messageInbox.drain is now (scope, agent, max) → Promise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((root as any).messageInbox as {
        drain: (scope: string, id: AgentId, n: number) => Promise<AgentMessage[]>;
      }).drain("swarm:default", agentId, max),
    readThread: (threadId: string) => root.readThread(threadId),
    listAgents: () => root.listAgents(),
    askUser: (): never => {
      throw new Error("not used");
    },
    task: root.task,
  };
  // Augment with the standalone introspection helpers the tool reaches for.
  return Object.assign(base, {
    listMembersInScope: (scope: string, exclude?: AgentId) =>
      root.listMembersInScope(scope, exclude),
    scopeOf: (id: AgentId) => root.scopeOf(id),
  }) as SwarmHost;
}

const CTX_CWD = process.cwd();

// ---------------------------------------------------------------------------
// Standalone host paths
// ---------------------------------------------------------------------------

describe("team_members tool — standalone host", () => {
  it("returns the other 2 members in a single team of 3", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    const C = "C" as AgentId;
    const scope = "swarm:my-team";
    registerPeer(root, A, 1, scope, "executor");
    registerPeer(root, B, 1, scope, "reviewer");
    registerPeer(root, C, 1, scope, "executor");

    const hostA = hostAs(root, A, 1);
    const result = await teamMembersTool.execute(
      {},
      { cwd: CTX_CWD, host: hostA },
    );
    expect(result.status).toBe("ok");
    const members = JSON.parse(
      (result as { status: "ok"; output: string }).output,
    ) as Array<{ memberId: string; role: string; agentId: string }>;
    expect(members).toHaveLength(2);
    const ids = members.map((m) => m.agentId).sort();
    expect(ids).toEqual([B, C].sort());
    // Roles round-trip too.
    const byId = new Map(members.map((m) => [m.agentId, m.role]));
    expect(byId.get(B)).toBe("reviewer");
    expect(byId.get(C)).toBe("executor");
  });

  it("scope-isolates: caller in team A only sees team A peers", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A1 = "A1" as AgentId;
    const A2 = "A2" as AgentId;
    const B1 = "B1" as AgentId;
    const B2 = "B2" as AgentId;
    registerPeer(root, A1, 1, "swarm:team-a", "executor");
    registerPeer(root, A2, 1, "swarm:team-a", "reviewer");
    registerPeer(root, B1, 1, "swarm:team-b", "executor");
    registerPeer(root, B2, 1, "swarm:team-b", "reviewer");

    const hostA1 = hostAs(root, A1, 1);
    const result = await teamMembersTool.execute(
      {},
      { cwd: CTX_CWD, host: hostA1 },
    );
    expect(result.status).toBe("ok");
    const members = JSON.parse(
      (result as { status: "ok"; output: string }).output,
    ) as Array<{ agentId: string }>;
    expect(members).toHaveLength(1);
    expect(members[0]!.agentId).toBe(A2);
  });

  it("returns empty array when caller has no other team members in default scope", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    // Note: no role registered → listMembersInScope omits the agent regardless.
    // Register a role so the agent itself is registered, then verify "exclude
    // self" leaves an empty list.
    registerPeer(root, A, 1, "swarm:default", "executor");

    const hostA = hostAs(root, A, 1);
    const result = await teamMembersTool.execute(
      {},
      { cwd: CTX_CWD, host: hostA },
    );
    expect(result.status).toBe("ok");
    const members = JSON.parse(
      (result as { status: "ok"; output: string }).output,
    );
    expect(members).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Worker host (IPC) path
// ---------------------------------------------------------------------------

function makeFakeTransport(): {
  transport: ParentTransport;
  send: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const send = vi.fn();
  const transport = Object.assign(emitter, {
    send,
    notify: vi.fn(async () => {}),
    respond: vi.fn(),
    respondError: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    close: vi.fn(),
  }) as unknown as ParentTransport;
  return { transport, send };
}

describe("team_members tool — worker host (IPC round-trip)", () => {
  it("sends team.members request and returns the orchestrator's reply", async () => {
    const { transport, send } = makeFakeTransport();
    const expected = [
      { memberId: "peer-1", role: "executor", agentId: "peer-1" },
      { memberId: "peer-2", role: "reviewer", agentId: "peer-2" },
    ];
    send.mockResolvedValue(expected);
    const host = new WorkerHost(
      "worker-agent" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
    );

    const result = await teamMembersTool.execute(
      {},
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect(
      JSON.parse((result as { status: "ok"; output: string }).output),
    ).toEqual(expected);

    expect(send).toHaveBeenCalledTimes(1);
    const [method, params, opts] = send.mock.calls[0]!;
    expect(method).toBe("team.members");
    expect(params).toEqual({});
    expect(opts).toMatchObject({ timeoutMs: 5000 });
  });

  it("surfaces transport errors as a tool error", async () => {
    const { transport, send } = makeFakeTransport();
    send.mockRejectedValue(new Error("transport closed"));
    const host = new WorkerHost(
      "worker-agent-2" as AgentId,
      1,
      "workspace-write" as PermissionMode,
      transport,
    );

    const result = await teamMembersTool.execute(
      {},
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toContain(
      "transport closed",
    );
  });
});

// ---------------------------------------------------------------------------
// Schema / host-presence
// ---------------------------------------------------------------------------

describe("team_members tool — schema + host presence", () => {
  it("throws when no host is present (dispatcher catches as ToolResult)", async () => {
    await expect(
      teamMembersTool.execute({}, { cwd: CTX_CWD }),
    ).rejects.toThrow(/team_members requires SwarmHost/);
  });
});
