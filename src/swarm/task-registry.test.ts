import { describe, it, expect } from "vitest";
import { TaskRegistry } from "./task-registry.js";
import type { TaskPacket } from "./host.js";
import type { AgentId } from "../core/types.js";
import type { LaneEvent } from "./events.js";

function samplePacket(
  overrides: Partial<Omit<TaskPacket, "id">> = {},
): Omit<TaskPacket, "id"> {
  return {
    prompt: "sample prompt",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    ...overrides,
  };
}

describe("TaskRegistry", () => {
  it("create() returns unique ids across multiple calls", () => {
    const reg = new TaskRegistry();
    const r1 = reg.create(samplePacket());
    const r2 = reg.create(samplePacket());
    const r3 = reg.create(samplePacket());
    expect(new Set([r1.id, r2.id, r3.id]).size).toBe(3);
  });

  it("create() populates createdAt and updatedAt", () => {
    const reg = new TaskRegistry();
    const before = Date.now();
    const rec = reg.create(samplePacket());
    const after = Date.now();
    expect(rec.createdAt).toBeGreaterThanOrEqual(before);
    expect(rec.createdAt).toBeLessThanOrEqual(after);
    expect(rec.updatedAt).toBe(rec.createdAt);
    expect(rec.status).toBe("pending");
  });

  it("update() patches fields and bumps updatedAt", async () => {
    const reg = new TaskRegistry();
    const rec = reg.create(samplePacket());
    const originalUpdatedAt = rec.updatedAt;
    // Wait a tick so Date.now() advances.
    await new Promise((r) => setTimeout(r, 2));
    reg.update(rec.id, { status: "running", owner: "agent-1" as AgentId });
    const after = reg.get(rec.id)!;
    expect(after.status).toBe("running");
    expect(after.owner).toBe("agent-1");
    expect(after.updatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  it("update() throws on unknown id", () => {
    const reg = new TaskRegistry();
    expect(() => reg.update("nonexistent", { status: "failed" })).toThrow(
      /unknown task id/,
    );
  });

  it("list() filters by status and owner", () => {
    const reg = new TaskRegistry();
    const r1 = reg.create(samplePacket());
    const r2 = reg.create(samplePacket());
    reg.create(samplePacket());
    reg.update(r1.id, { status: "succeeded", owner: "a-1" as AgentId });
    reg.update(r2.id, { status: "succeeded", owner: "a-2" as AgentId });

    expect(reg.list({ status: "succeeded" })).toHaveLength(2);
    expect(reg.list({ owner: "a-1" as AgentId })).toHaveLength(1);
    expect(reg.list({ status: "pending" })).toHaveLength(1);
    expect(reg.list()).toHaveLength(3);
  });

  it("list() filters by parentTaskId via context", () => {
    const reg = new TaskRegistry();
    const parent = reg.create(samplePacket());
    reg.create(samplePacket({ context: { parentTaskId: parent.id } }));
    reg.create(samplePacket({ context: { parentTaskId: parent.id } }));
    reg.create(samplePacket());
    expect(reg.list({ parentTaskId: parent.id })).toHaveLength(2);
  });

  it("emit() delivers to listeners in FIFO order; unsubscribe stops delivery", () => {
    const reg = new TaskRegistry();
    const received: LaneEvent[] = [];
    const unsubscribe = reg.onEvent((e) => received.push(e));

    const evt1: LaneEvent = {
      ts: 1,
      agentId: "a" as AgentId,
      type: "task_created",
      payload: null,
    };
    const evt2: LaneEvent = {
      ts: 2,
      agentId: "a" as AgentId,
      type: "task_completed",
      payload: null,
    };
    reg.emit(evt1);
    reg.emit(evt2);
    expect(received).toEqual([evt1, evt2]);

    unsubscribe();
    reg.emit({ ...evt1, ts: 3 });
    expect(received).toHaveLength(2); // no new event delivered
  });
});
