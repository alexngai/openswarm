/**
 * swarm-view-events.test.ts — GitHub #15.
 *
 * Proves the swarm-view producer:
 *   1. (unit) SwarmViewTranslator maps synthetic lane events onto the three
 *      REPL view NormalizedEvents (agent_spawned / agent_status / task_update).
 *   2. (integration) a real StandaloneHost spawning a (faked) worker emits
 *      those NormalizedEvents through subscribeSwarmViewEvents — i.e. the
 *      emission fires from production spawn code, not test-only dispatch.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  SwarmViewTranslator,
  lifecycleToPhase,
  subscribeSwarmViewEvents,
} from "./swarm-view-events.js";
import { StandaloneHost } from "./standalone-host.js";
import { encodeFrame } from "./ipc/framing.js";
import type { LaneEvent } from "./events.js";
import type { AgentId } from "../core/types.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";
import type { TaskPacket } from "./host.js";

function lane(type: string, agentId: string, payload: unknown): LaneEvent {
  return { ts: 1, agentId: agentId as AgentId, type: type as LaneEvent["type"], payload };
}

// ---------------------------------------------------------------------------
// Unit — SwarmViewTranslator
// ---------------------------------------------------------------------------

describe("SwarmViewTranslator", () => {
  it("worker_spawned emits agent_spawned + task_update(active); root child has no parentId", () => {
    const t = new SwarmViewTranslator({
      orchestratorId: "orch" as AgentId,
      resolveTaskTitle: (id) => (id === "task-1" ? "Fix the bug" : undefined),
    });
    const out = t.onLaneEvent(
      lane("worker_spawned", "orch", {
        childAgentId: "w1",
        parentAgentId: "orch",
        role: "executor",
        taskId: "task-1",
      }),
    );
    expect(out).toEqual([
      { type: "agent_spawned", agentId: "w1", name: "executor", role: "executor" },
      {
        type: "task_update",
        taskId: "task-1",
        title: "Fix the bug",
        status: "active",
        assignee: "w1",
      },
    ]);
    // No parentId key at all (direct orchestrator child renders as a tree root).
    expect("parentId" in (out[0] as object)).toBe(false);
  });

  it("falls back to role for the task title when the resolver returns undefined", () => {
    const t = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    const out = t.onLaneEvent(
      lane("worker_spawned", "orch", {
        childAgentId: "w1",
        parentAgentId: "orch",
        role: "researcher",
        taskId: "task-9",
      }),
    );
    const task = out.find((e) => e.type === "task_update");
    expect(task).toMatchObject({ title: "researcher" });
  });

  it("carries parentId only when the parent is itself a tracked member", () => {
    const t = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    t.onLaneEvent(
      lane("worker_spawned", "orch", {
        childAgentId: "w1",
        parentAgentId: "orch",
        role: "lead",
        taskId: "t1",
      }),
    );
    const out = t.onLaneEvent(
      lane("worker_spawned", "orch", {
        childAgentId: "w2",
        parentAgentId: "w1",
        role: "sub",
        taskId: "t2",
      }),
    );
    expect(out[0]).toEqual({
      type: "agent_spawned",
      agentId: "w2",
      name: "sub",
      role: "sub",
      parentId: "w1",
    });
  });

  it("worker_lifecycle_changed maps to agent_status; orchestrator self + unknown member ignored", () => {
    const t = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    t.onLaneEvent(
      lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "x", taskId: "t1" }),
    );
    expect(t.onLaneEvent(lane("worker_lifecycle_changed", "w1", { from: "spawning", to: "running" }))).toEqual([
      { type: "agent_status", agentId: "w1", phase: "running", toolCount: 0, tokenUsage: 0 },
    ]);
    // Orchestrator's own transition is not a member.
    expect(t.onLaneEvent(lane("worker_lifecycle_changed", "orch", { from: "spawning", to: "running" }))).toEqual([]);
    // Unknown member.
    expect(t.onLaneEvent(lane("worker_lifecycle_changed", "ghost", { from: "spawning", to: "running" }))).toEqual([]);
  });

  it("tool_use_start increments toolCount and flips spawning→running", () => {
    const t = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    t.onLaneEvent(lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "x", taskId: "t1" }));
    const a = t.onLaneEvent(lane("tool_use_start", "w1", { type: "tool_use_start", id: "tu1", name: "bash" }));
    expect(a).toEqual([{ type: "agent_status", agentId: "w1", phase: "running", toolCount: 1, tokenUsage: 0 }]);
    const b = t.onLaneEvent(lane("tool_use_start", "w1", { type: "tool_use_start", id: "tu2", name: "read" }));
    expect(b[0]).toMatchObject({ toolCount: 2 });
  });

  it("message_stop accrues token usage", () => {
    const t = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    t.onLaneEvent(lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "x", taskId: "t1" }));
    const out = t.onLaneEvent(
      lane("message_stop", "w1", { type: "message_stop", usage: { inputTokens: 10, outputTokens: 5 } }),
    );
    expect(out[0]).toMatchObject({ tokenUsage: 15 });
  });

  it("worker_exited(exitCode 0) → done; nonzero → failed; both finalize the task", () => {
    const t = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    t.onLaneEvent(lane("worker_spawned", "orch", { childAgentId: "w1", parentAgentId: "orch", role: "x", taskId: "t1" }));
    const ok = t.onLaneEvent(lane("worker_exited", "orch", { agentId: "w1", exitCode: 0 }));
    expect(ok).toEqual([
      { type: "agent_status", agentId: "w1", phase: "done", toolCount: 0, tokenUsage: 0 },
      { type: "task_update", taskId: "t1", title: "x", status: "done", assignee: "w1" },
    ]);

    const t2 = new SwarmViewTranslator({ orchestratorId: "orch" as AgentId });
    t2.onLaneEvent(lane("worker_spawned", "orch", { childAgentId: "w2", parentAgentId: "orch", role: "y", taskId: "t2" }));
    const bad = t2.onLaneEvent(lane("worker_exited", "orch", { agentId: "w2", exitCode: 1 }));
    expect(bad).toEqual([
      { type: "agent_status", agentId: "w2", phase: "failed", toolCount: 0, tokenUsage: 0 },
      { type: "task_update", taskId: "t2", title: "y", status: "failed", assignee: "w2" },
    ]);
  });

  it("ignores unrelated lane events", () => {
    const t = new SwarmViewTranslator({});
    expect(t.onLaneEvent(lane("heartbeat", "x", {}))).toEqual([]);
    expect(t.onLaneEvent(lane("message_sent", "x", { from: "a", to: "b", content: "hi" }))).toEqual([]);
  });

  // GitHub #23 — real task_* lane events drive the task board directly.
  it("task_created → task_update(pending) with the prompt as title", () => {
    const t = new SwarmViewTranslator({});
    const out = t.onLaneEvent(
      lane("task_created", "orch", { taskId: "t1", prompt: "Fix the flaky test" }),
    );
    expect(out).toEqual([
      { type: "task_update", taskId: "t1", title: "Fix the flaky test", status: "pending" },
    ]);
  });

  it("task_updated maps registry status→view status and records the owner as assignee", () => {
    const t = new SwarmViewTranslator({});
    t.onLaneEvent(lane("task_created", "orch", { taskId: "t1", prompt: "Do a thing" }));
    const out = t.onLaneEvent(
      lane("task_updated", "orch", { taskId: "t1", patch: { status: "running", owner: "w1" } }),
    );
    expect(out).toEqual([
      { type: "task_update", taskId: "t1", title: "Do a thing", status: "active", assignee: "w1" },
    ]);
  });

  it("task_completed/task_failed reuse the stored title + assignee", () => {
    const t = new SwarmViewTranslator({});
    t.onLaneEvent(lane("task_created", "orch", { taskId: "t1", prompt: "Ship it" }));
    t.onLaneEvent(lane("task_updated", "orch", { taskId: "t1", patch: { owner: "w1" } }));
    expect(t.onLaneEvent(lane("task_completed", "orch", { taskId: "t1" }))).toEqual([
      { type: "task_update", taskId: "t1", title: "Ship it", status: "done", assignee: "w1" },
    ]);

    const t2 = new SwarmViewTranslator({});
    t2.onLaneEvent(lane("task_created", "orch", { taskId: "t2", prompt: "Break it" }));
    expect(t2.onLaneEvent(lane("task_failed", "orch", { taskId: "t2", error: "boom" }))).toEqual([
      { type: "task_update", taskId: "t2", title: "Break it", status: "failed" },
    ]);
  });

  it("falls back to the resolver then short id when task_* carries no prompt", () => {
    const t = new SwarmViewTranslator({
      resolveTaskTitle: (id) => (id === "known" ? "Resolved title" : undefined),
    });
    expect(
      t.onLaneEvent(lane("task_updated", "orch", { taskId: "known", patch: { status: "running" } })),
    ).toEqual([{ type: "task_update", taskId: "known", title: "Resolved title", status: "active" }]);
    expect(
      t.onLaneEvent(lane("task_completed", "orch", { taskId: "abcdef123456" })),
    ).toEqual([{ type: "task_update", taskId: "abcdef123456", title: "abcdef12", status: "done" }]);
  });
});

describe("lifecycleToPhase", () => {
  it("maps every worker lifecycle state to a coarse phase", () => {
    expect(lifecycleToPhase("spawning")).toBe("spawning");
    expect(lifecycleToPhase("ready_for_prompt")).toBe("spawning");
    expect(lifecycleToPhase("prompt_accepted")).toBe("running");
    expect(lifecycleToPhase("running")).toBe("running");
    expect(lifecycleToPhase("blocked")).toBe("running");
    expect(lifecycleToPhase("idle")).toBe("idle");
    expect(lifecycleToPhase("drained")).toBe("idle");
    expect(lifecycleToPhase("finished")).toBe("done");
    expect(lifecycleToPhase("failed")).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Integration — real StandaloneHost + faked worker subprocess
// ---------------------------------------------------------------------------

function samplePacket(overrides: Partial<Omit<TaskPacket, "id">> = {}): TaskPacket {
  return {
    id: "task-" + Math.random().toString(36).slice(2),
    prompt: "investigate the flaky test",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    ...overrides,
  };
}

function fakeProcPair(): { child: ChildProcess; emitFromWorker: (frame: object) => void } {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout,
    stdin,
    stderr: null,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal?: string) => {
      emitter.emit("close", null, signal ?? null);
    }),
  }) as unknown as ChildProcess;
  const emitFromWorker = (frame: object): void => {
    stdout.push(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
  };
  return { child, emitFromWorker };
}

async function tick(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe("subscribeSwarmViewEvents — live StandaloneHost spawn", () => {
  it("emits agent_spawned + task_update(active) then done on a real spawn/exit", async () => {
    const { child, emitFromWorker } = fakeProcPair();
    const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);
    const host = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const unsub = subscribeSwarmViewEvents(host, (e) => events.push(e as never));

    const spawnP = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    // worker_ready lets spawn() proceed to emit worker_spawned.
    await tick();
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await tick();
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 5 },
    });
    const handle = await spawnP;
    await tick();

    // agent_spawned + task_update(active) fired from production spawn code.
    const spawned = events.find((e) => e.type === "agent_spawned");
    expect(spawned).toBeDefined();
    expect(spawned!.agentId).toBe(handle.agentId);
    const active = events.find((e) => e.type === "task_update" && e.status === "active");
    expect(active).toBeDefined();
    // Task title resolved from the registry prompt.
    expect(active!.title).toBe("investigate the flaky test");
    expect(active!.assignee).toBe(handle.agentId);

    // Worker exits cleanly → done.
    child.emit("close", 0, null);
    await tick();
    const done = events.find((e) => e.type === "agent_status" && e.phase === "done");
    expect(done).toBeDefined();
    expect(events.find((e) => e.type === "task_update" && e.status === "done")).toBeDefined();

    unsub();
  });

  it("emits real task_created/task_updated/task_completed lane events from the spawn path (GitHub #23)", async () => {
    const { child, emitFromWorker } = fakeProcPair();
    const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);
    const host = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    const laneTypes: string[] = [];
    const taskEvents: Array<{ type: string; payload: unknown }> = [];
    const unsub = host.onLaneEvent((e) => {
      laneTypes.push(e.type);
      if (e.type.startsWith("task_")) taskEvents.push({ type: e.type, payload: e.payload });
    });

    const spawnP = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    await tick();
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await tick();
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 5 },
    });
    const handle = await spawnP;
    await tick();

    // task_created (with the prompt) + task_updated (owner assignment) fired
    // from the spawn path — not synthesized by the view translator.
    expect(laneTypes).toContain("task_created");
    expect(laneTypes).toContain("task_updated");
    const created = taskEvents.find((e) => e.type === "task_created");
    expect((created!.payload as { prompt?: string }).prompt).toBe("investigate the flaky test");
    const updated = taskEvents.find((e) => e.type === "task_updated");
    expect((updated!.payload as { patch?: { owner?: string } }).patch?.owner).toBe(handle.agentId);

    // Clean exit → real task_completed.
    child.emit("close", 0, null);
    await tick();
    expect(taskEvents.find((e) => e.type === "task_completed")).toBeDefined();

    unsub();
  });

  it("unsubscribe stops further projection", async () => {
    const { child, emitFromWorker } = fakeProcPair();
    const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);
    const host = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });
    const events: unknown[] = [];
    const unsub = subscribeSwarmViewEvents(host, (e) => events.push(e));
    unsub();

    const spawnP = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    await tick();
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await tick();
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "x", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 1 },
    });
    await spawnP;
    await tick();
    expect(events).toHaveLength(0);
  });
});
