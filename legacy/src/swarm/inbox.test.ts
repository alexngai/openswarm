/**
 * inbox.test.ts — InboxBackend conformance + InMemoryInboxBackend behaviour.
 *
 * v0.6 stage 6A.1: tests are scope-aware and async, mirroring the
 * refactored InboxBackend interface. The "conformance suite" describe block
 * is exported as a function so 6A.2's `AgentInboxBackend` (and any future
 * backend) can run the same checks against its own factory.
 */

import { describe, it, expect } from "vitest";
import { InMemoryInboxBackend, type InboxBackend } from "./inbox.js";
import type { AgentId } from "../core/types.js";
import type { AgentMessage } from "./host.js";

const SCOPE = "swarm:default";

function msg(i: number, to: AgentId = "b" as AgentId): AgentMessage {
  return {
    from: "a" as AgentId,
    to,
    content: `m${i}`,
    timestamp: 1000 + i,
  };
}

/**
 * Conformance suite — every InboxBackend impl should pass these. Exported
 * so 6A.2 + future backends can `runInboxConformance(() => new MyBackend())`.
 */
export function runInboxConformance(
  factory: () => InboxBackend,
  name: string,
): void {
  describe(`InboxBackend conformance — ${name}`, () => {
    it("FIFO drain returns enqueued messages in order", async () => {
      const inbox = factory();
      const to = "b" as AgentId;
      for (let i = 0; i < 5; i++) await inbox.enqueue(SCOPE, to, msg(i));
      const out = await inbox.drain(SCOPE, to, 10);
      expect(out.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    });

    it("partial drain leaves the rest in queue", async () => {
      const inbox = factory();
      const to = "b" as AgentId;
      for (let i = 0; i < 5; i++) await inbox.enqueue(SCOPE, to, msg(i));
      const two = await inbox.drain(SCOPE, to, 2);
      expect(two.map((m) => m.content)).toEqual(["m0", "m1"]);
      const rest = await inbox.drain(SCOPE, to, 100);
      expect(rest.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
      expect(await inbox.drain(SCOPE, to, 10)).toEqual([]);
    });

    it("drain returns [] for an unknown agent", async () => {
      const inbox = factory();
      expect(await inbox.drain(SCOPE, "nobody" as AgentId, 10)).toEqual([]);
    });

    it("size reports current queue depth", async () => {
      const inbox = factory();
      const to = "b" as AgentId;
      expect(await inbox.size(SCOPE, to)).toBe(0);
      await inbox.enqueue(SCOPE, to, msg(0));
      await inbox.enqueue(SCOPE, to, msg(1));
      expect(await inbox.size(SCOPE, to)).toBe(2);
      await inbox.drain(SCOPE, to, 1);
      expect(await inbox.size(SCOPE, to)).toBe(1);
    });

    it("discard drops the queue and returns the messages", async () => {
      const inbox = factory();
      const to = "b" as AgentId;
      await inbox.enqueue(SCOPE, to, msg(0));
      await inbox.enqueue(SCOPE, to, msg(1));
      const discarded = await inbox.discard(SCOPE, to);
      expect(discarded.map((m) => m.content)).toEqual(["m0", "m1"]);
      expect(await inbox.drain(SCOPE, to, 10)).toEqual([]);
    });

    it("discard on unknown agent returns []", async () => {
      const inbox = factory();
      expect(await inbox.discard(SCOPE, "ghost" as AgentId)).toEqual([]);
    });

    it("queues for different agents are independent", async () => {
      const inbox = factory();
      const b = "b" as AgentId;
      const c = "c" as AgentId;
      await inbox.enqueue(SCOPE, b, msg(0, b));
      await inbox.enqueue(SCOPE, c, msg(1, c));
      await inbox.enqueue(SCOPE, b, msg(2, b));
      expect((await inbox.drain(SCOPE, b, 10)).map((m) => m.content)).toEqual([
        "m0",
        "m2",
      ]);
      expect((await inbox.drain(SCOPE, c, 10)).map((m) => m.content)).toEqual([
        "m1",
      ]);
    });

    it("queues are isolated across scopes", async () => {
      const inbox = factory();
      const to = "b" as AgentId;
      await inbox.enqueue("swarm:alpha", to, msg(0));
      await inbox.enqueue("swarm:beta", to, msg(1));
      const alpha = await inbox.drain("swarm:alpha", to, 10);
      const beta = await inbox.drain("swarm:beta", to, 10);
      expect(alpha.map((m) => m.content)).toEqual(["m0"]);
      expect(beta.map((m) => m.content)).toEqual(["m1"]);
    });
  });
}

// ---------------------------------------------------------------------------
// InMemoryInboxBackend specifics
// ---------------------------------------------------------------------------

runInboxConformance(() => new InMemoryInboxBackend(), "InMemoryInboxBackend");

describe("InMemoryInboxBackend — overflow policy", () => {
  it("evicts oldest when capacity exceeded; reports drop count", async () => {
    const inbox = new InMemoryInboxBackend(3);
    const to = "b" as AgentId;
    await inbox.enqueue(SCOPE, to, msg(0));
    await inbox.enqueue(SCOPE, to, msg(1));
    await inbox.enqueue(SCOPE, to, msg(2));
    // Capacity now full; next enqueue evicts oldest (m0) and reports drop=1.
    const dropped = await inbox.enqueue(SCOPE, to, msg(3));
    expect(dropped).toBe(1);
    const out = await inbox.drain(SCOPE, to, 10);
    expect(out.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
  });

  it("totalSize counts across scopes + agents", async () => {
    const inbox = new InMemoryInboxBackend();
    await inbox.enqueue("swarm:a", "x" as AgentId, msg(0));
    await inbox.enqueue("swarm:a", "y" as AgentId, msg(1));
    await inbox.enqueue("swarm:b", "x" as AgentId, msg(2));
    expect(inbox.totalSize()).toBe(3);
  });
});
