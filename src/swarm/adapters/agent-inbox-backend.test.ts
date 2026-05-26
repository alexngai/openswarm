/**
 * agent-inbox-backend.test.ts — v0.6 stage 6A.2.
 *
 * Runs the InboxBackend conformance suite against AgentInboxBackend (with
 * agent-inbox's InMemoryStorage). Adds extension-method coverage for the
 * optional readThread / listAgents methods, which the in-memory backend
 * doesn't implement.
 */

import { describe, it, expect } from "vitest";
import { runInboxConformance } from "../inbox.test.js";
import { AgentInboxBackend } from "./agent-inbox-backend.js";
import type { AgentId } from "../../core/types.js";
import type { AgentMessage } from "../host.js";

function msg(content: string, opts: Partial<AgentMessage> = {}): AgentMessage {
  return {
    from: ("a" as AgentId),
    to: ("b" as AgentId),
    content,
    timestamp: 1_000_000,
    ...opts,
  };
}

// ---- Conformance suite (InboxBackend contract) ---------------------------

runInboxConformance(() => new AgentInboxBackend(), "AgentInboxBackend");

// ---- Optional-method extensions ------------------------------------------

describe("AgentInboxBackend — optional methods", () => {
  it("readThread returns messages tagged with the thread id", async () => {
    const inbox = new AgentInboxBackend();
    const scope = "swarm:thread-test";
    const to = "b" as AgentId;
    await inbox.enqueue(scope, to, msg("first", { threadTag: "T1" }));
    await inbox.enqueue(scope, to, msg("second", { threadTag: "T1" }));
    await inbox.enqueue(scope, to, msg("other", { threadTag: "T2" }));

    const t1 = await inbox.readThread!(scope, "T1");
    expect(t1.map((m) => m.content)).toEqual(["first", "second"]);

    const t2 = await inbox.readThread!(scope, "T2");
    expect(t2.map((m) => m.content)).toEqual(["other"]);
  });

  it("readThread is exposed (interface feature-detection still works)", () => {
    const inbox = new AgentInboxBackend();
    expect(typeof inbox.readThread).toBe("function");
    expect(typeof inbox.listAgents).toBe("function");
  });

  it("threadTag roundtrips through enqueue → drain", async () => {
    const inbox = new AgentInboxBackend();
    const scope = "swarm:tag-test";
    const to = "b" as AgentId;
    await inbox.enqueue(scope, to, msg("hello", { threadTag: "X-42" }));
    const drained = await inbox.drain(scope, to, 10);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.threadTag).toBe("X-42");
    // v0.6 stage 6B: correlationId is no longer auto-mapped to thread_tag.
    expect(drained[0]!.correlationId).toBeUndefined();
  });

  it("correlationId is NOT carried through agent-inbox storage", async () => {
    // v0.6 stage 6B: agent-inbox v0.2 has no native field for correlationId,
    // so it's dropped on the round-trip. Callers needing correlationId
    // persistence must use the in-memory backend.
    const inbox = new AgentInboxBackend();
    const scope = "swarm:corr-drop";
    const to = "b" as AgentId;
    await inbox.enqueue(scope, to, msg("hello", { correlationId: "req-1" }));
    const drained = await inbox.drain(scope, to, 10);
    expect(drained).toHaveLength(1);
    expect(drained[0]!.correlationId).toBeUndefined();
  });
});
