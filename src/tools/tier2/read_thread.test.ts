/**
 * Tests for the `read_thread` Tier 2 tool (v0.6 stage 6B).
 *
 * Covers the schema, the happy path (StandaloneHost wired to an
 * AgentInboxBackend), and the "threading not supported" error path
 * (default InMemoryInboxBackend).
 */

import { describe, it, expect } from "vitest";
import { readThreadTool } from "./read_thread.js";
import { sendMessageTool } from "./send_message.js";
import { makeFakeHost } from "./_fake-host.js";
import { StandaloneHost } from "../../swarm/standalone-host.js";
import { AgentInboxBackend } from "../../swarm/adapters/agent-inbox-backend.js";
import type { SwarmHost, AgentMessage } from "../../swarm/host.js";
import type { AgentId } from "../../core/types.js";

const CWD = process.cwd();

// Reuse the pattern from send_message.test.ts: register peers directly in
// the StandaloneHost's depths map and proxy a per-agent SwarmHost facade.
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
    askUser: (): never => {
      throw new Error("not used");
    },
    task: root.task,
  };
}

describe("read_thread tool — schema + host presence", () => {
  it("throws when no host is present", async () => {
    await expect(
      readThreadTool.execute({ threadId: "t1" }, { cwd: CWD }),
    ).rejects.toThrow(/read_thread requires SwarmHost/);
  });

  it("rejects empty threadId", async () => {
    const { host } = makeFakeHost();
    const res = await readThreadTool.execute(
      { threadId: "" },
      { cwd: CWD, host },
    );
    expect(res.status).toBe("error");
  });

  it("returns [] from a fake host that has no thread storage", async () => {
    const { host } = makeFakeHost();
    const res = await readThreadTool.execute(
      { threadId: "t1" },
      { cwd: CWD, host },
    );
    expect(res.status).toBe("ok");
    expect((res as { status: "ok"; output: string }).output).toBe("[]");
  });
});

describe("read_thread tool — backend integration", () => {
  it("returns a structured error when the backend lacks threading (in-memory default)", async () => {
    // Default StandaloneHost uses InMemoryInboxBackend, which has no
    // readThread method. The tool should surface a clean error, not throw.
    const root = new StandaloneHost({ agentId: "R" as AgentId });
    const A = "A" as AgentId;
    registerPeer(root, A, 1);
    const hostA = hostAs(root, A, 1);

    const res = await readThreadTool.execute(
      { threadId: "t1" },
      { cwd: CWD, host: hostA },
    );
    expect(res.status).toBe("error");
    expect((res as { status: "error"; message: string }).message).toMatch(
      /threading not supported/,
    );
  });

  it("returns messages from an agent-inbox backend by thread tag", async () => {
    // Wire a StandaloneHost backed by AgentInboxBackend, send two messages
    // tagged "t1" plus one "t2", then read_thread t1 from the recipient.
    const root = new StandaloneHost({
      agentId: "R" as AgentId,
      inboxBackend: new AgentInboxBackend(),
    });
    const A = "A" as AgentId;
    const B = "B" as AgentId;
    registerPeer(root, A, 1);
    registerPeer(root, B, 1);
    const hostA = hostAs(root, A, 1);
    const hostB = hostAs(root, B, 1);

    // A sends two messages with thread "t1" + one with "t2" to B.
    for (const [content, threadTag] of [
      ["first", "t1"],
      ["second", "t1"],
      ["other", "t2"],
    ] as const) {
      const r = await sendMessageTool.execute(
        { to: B, content, threadTag },
        { cwd: CWD, host: hostA },
      );
      expect(r.status).toBe("ok");
    }

    const res = await readThreadTool.execute(
      { threadId: "t1" },
      { cwd: CWD, host: hostB },
    );
    expect(res.status).toBe("ok");
    const messages = JSON.parse(
      (res as { status: "ok"; output: string }).output,
    ) as AgentMessage[];
    expect(messages.map((m) => m.content)).toEqual(["first", "second"]);
    for (const m of messages) {
      expect(m.threadTag).toBe("t1");
    }
  });
});
