import { describe, it, expect } from "vitest";
import { AgentInbox } from "./inbox.js";
import type { AgentId } from "../core/types.js";
import type { AgentMessage } from "./host.js";

function msg(i: number, to: AgentId = "b" as AgentId): AgentMessage {
  return {
    from: "a" as AgentId,
    to,
    content: `m${i}`,
    timestamp: 1_700_000_000_000 + i,
  };
}

describe("AgentInbox", () => {
  it("preserves FIFO order across enqueue/drain", () => {
    const inbox = new AgentInbox();
    const to = "b" as AgentId;
    for (let i = 0; i < 5; i++) inbox.enqueue(to, msg(i));
    const out = inbox.drain(to, 10);
    expect(out.map((m) => m.content)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("overflow: enqueue beyond cap evicts oldest and returns 1", () => {
    const inbox = new AgentInbox(3);
    const to = "b" as AgentId;
    inbox.enqueue(to, msg(0));
    inbox.enqueue(to, msg(1));
    inbox.enqueue(to, msg(2));
    expect(inbox.size(to)).toBe(3);
    // 4th overflows.
    const dropped = inbox.enqueue(to, msg(3));
    expect(dropped).toBe(1);
    expect(inbox.size(to)).toBe(3);
    // Oldest was evicted; newest kept.
    const out = inbox.drain(to, 10);
    expect(out.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
  });

  it("drain with fewer-than-max returns all; with more returns exactly max; empty returns []", () => {
    const inbox = new AgentInbox();
    const to = "b" as AgentId;
    for (let i = 0; i < 5; i++) inbox.enqueue(to, msg(i));

    const two = inbox.drain(to, 2);
    expect(two.map((m) => m.content)).toEqual(["m0", "m1"]);
    expect(inbox.size(to)).toBe(3);

    const rest = inbox.drain(to, 100);
    expect(rest.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);

    expect(inbox.drain(to, 10)).toEqual([]);
    // Unknown agent.
    expect(inbox.drain("nobody" as AgentId, 10)).toEqual([]);
  });

  it("discardAgent returns the discarded array and empties the queue", () => {
    const inbox = new AgentInbox();
    const to = "b" as AgentId;
    inbox.enqueue(to, msg(0));
    inbox.enqueue(to, msg(1));
    const discarded = inbox.discardAgent(to);
    expect(discarded).toHaveLength(2);
    expect(discarded.map((m) => m.content)).toEqual(["m0", "m1"]);
    expect(inbox.size(to)).toBe(0);
    expect(inbox.drain(to, 10)).toEqual([]);
  });

  it("discardAgent on an unknown agent returns []", () => {
    const inbox = new AgentInbox();
    expect(inbox.discardAgent("ghost" as AgentId)).toEqual([]);
  });

  it("multiple agents keep isolated queues", () => {
    const inbox = new AgentInbox();
    const b = "b" as AgentId;
    const c = "c" as AgentId;
    inbox.enqueue(b, msg(0, b));
    inbox.enqueue(c, msg(1, c));
    inbox.enqueue(b, msg(2, b));

    expect(inbox.size(b)).toBe(2);
    expect(inbox.size(c)).toBe(1);
    expect(inbox.totalSize()).toBe(3);

    expect(inbox.drain(b, 10).map((m) => m.content)).toEqual(["m0", "m2"]);
    // Draining b leaves c untouched.
    expect(inbox.size(c)).toBe(1);
    expect(inbox.drain(c, 10).map((m) => m.content)).toEqual(["m1"]);
  });

  it("size(unknown) is 0 and totalSize tracks across agents", () => {
    const inbox = new AgentInbox();
    expect(inbox.size("nobody" as AgentId)).toBe(0);
    expect(inbox.totalSize()).toBe(0);
    inbox.enqueue("b" as AgentId, msg(0));
    inbox.enqueue("c" as AgentId, msg(1));
    expect(inbox.totalSize()).toBe(2);
  });
});
