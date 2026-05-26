/**
 * Tests for the `list_agents` Tier 2 tool (v0.6 stage 6C).
 *
 * Covers schema/host-presence checks plus the two backend paths: a
 * registry-capable backend (AgentInboxBackend) returns the agents seen in
 * the scope; the default in-memory backend surfaces a structured error.
 */

import { describe, it, expect } from "vitest";
import { listAgentsTool } from "./list_agents.js";
import { sendMessageTool } from "./send_message.js";
import { makeFakeHost } from "./_fake-host.js";
import { StandaloneHost } from "../../swarm/standalone-host.js";
import { AgentInboxBackend } from "../../swarm/adapters/agent-inbox-backend.js";
import type { SwarmHost, AgentMessage } from "../../swarm/host.js";
import type { AgentId } from "../../core/types.js";

const CWD = process.cwd();

function registerPeer(host: StandaloneHost, agentId: AgentId, depth: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const depths: Map<AgentId, number> = (host as any).depths;
  depths.set(agentId, depth);
}

function hostAs(
  root: StandaloneHost,
  agentId: AgentId,
  depth: number,
): SwarmHost {
  return {
    mode: "standalone",
    kind: "standalone",
    agentId,
    depth,
    permissionMode: "workspace-write",
    emit: () => undefined,
    spawn: () => {
      throw new Error("not used");
    },
    isAncestorOf: (a, d) => root.isAncestorOf(a, d),
    send: (to, message) => root.send(to, message),
    inbox: async function* () {
      return;
    },
    drainInbox: async (max: number) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((root as any).messageInbox as {
        drain: (s: string, a: AgentId, n: number) => Promise<AgentMessage[]>;
      }).drain("swarm:default", agentId, max),
    readThread: (threadId: string) => root.readThread(threadId),
    listAgents: () => root.listAgents(),
    askUser: (): never => {
      throw new Error("not used");
    },
    task: root.task,
  };
}

describe("list_agents tool — schema + host presence", () => {
  it("throws when no host is present", async () => {
    await expect(
      listAgentsTool.execute({}, { cwd: CWD }),
    ).rejects.toThrow(/list_agents requires SwarmHost/);
  });

  it("returns [] from a fake host (no registry)", async () => {
    const { host } = makeFakeHost();
    const res = await listAgentsTool.execute({}, { cwd: CWD, host });
    expect(res.status).toBe("ok");
    expect((res as { status: "ok"; output: string }).output).toBe("[]");
  });
});

describe("list_agents tool — backend integration", () => {
  it("surfaces a structured error when the backend lacks a registry (in-memory default)", async () => {
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    registerPeer(root, A, 1);
    const hostA = hostAs(root, A, 1);

    const res = await listAgentsTool.execute({}, { cwd: CWD, host: hostA });
    expect(res.status).toBe("error");
    expect((res as { status: "error"; message: string }).message).toMatch(
      /agent registry not supported/,
    );
  });

  it("returns the agents seen by an agent-inbox-backed host in the caller's scope", async () => {
    const root = new StandaloneHost({
      agentId: "R" as AgentId,
      inboxBackend: new AgentInboxBackend(),
    });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    const C = "C" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1);
    registerPeer(root, C, 1);
    const hostA = hostAs(root, A, 1);

    // A sends to B and C; agent-inbox records A (as sender) plus B, C
    // (as recipients) in the scope.
    for (const target of [B, C]) {
      const sent = await sendMessageTool.execute(
        { to: target, content: "hi" },
        { cwd: CWD, host: hostA },
      );
      expect(sent.status).toBe("ok");
    }

    const res = await listAgentsTool.execute({}, { cwd: CWD, host: hostA });
    expect(res.status).toBe("ok");
    const agents = JSON.parse(
      (res as { status: "ok"; output: string }).output,
    ) as readonly AgentId[];
    expect([...agents].sort()).toEqual([A, B, C].sort());
  });
});
