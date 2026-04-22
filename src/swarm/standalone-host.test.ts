import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "./standalone-host.js";
import { TaskRegistry } from "./task-registry.js";
import type { TaskPacket } from "./host.js";
import type { AgentId } from "../core/types.js";
import { encodeFrame } from "./ipc/framing.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function samplePacket(overrides: Partial<Omit<TaskPacket, "id">> = {}): TaskPacket {
  return {
    id: "task-" + Math.random().toString(36).slice(2),
    prompt: "do something",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    ...overrides,
  };
}

/**
 * Build a fake ChildProcess whose stdout/stdin are PassThrough streams.
 * The returned `emitFromWorker` helper lets tests inject JSONL frames
 * as if the worker wrote them to stdout.
 */
function fakeProcPair(): {
  child: ChildProcess;
  emitFromWorker: (frame: object) => void;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();

  const child = Object.assign(emitter, {
    stdout,
    stdin,
    stderr: null,
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((signal?: string) => {
      emitter.emit("close", null, signal ?? null);
    }),
  }) as unknown as ChildProcess;

  function emitFromWorker(frame: object): void {
    stdout.push(encodeFrame(frame as Parameters<typeof encodeFrame>[0]));
  }

  return { child, emitFromWorker };
}

/** Build a spawnWorker override that returns a fake child. */
function makeSpawnOverride(): {
  spawnFn: ReturnType<typeof vi.fn> & ((args: SpawnWorkerArgs) => ChildProcess);
  emitFromWorker: (frame: object) => void;
  child: ChildProcess;
} {
  const { child, emitFromWorker } = fakeProcPair();
  const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);
  return { spawnFn, emitFromWorker, child };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StandaloneHost", () => {
  it("root depth is 0", () => {
    const host = new StandaloneHost();
    expect(host.depth).toBe(0);
  });

  it("agentId is set from options", () => {
    const id = "my-agent" as AgentId;
    const host = new StandaloneHost({ agentId: id });
    expect(host.agentId).toBe(id);
  });

  it("mode is standalone", () => {
    const host = new StandaloneHost();
    expect(host.mode).toBe("standalone");
  });

  it("TaskRegistry passthrough: create, get, list, update work", async () => {
    const host = new StandaloneHost();
    const record = await host.task.create({
      prompt: "hello",
      branchPolicy: { kind: "none" },
      commitPolicy: { kind: "none" },
      escalationPolicy: { kind: "none" },
    });
    expect(record.id).toBeDefined();
    expect(record.status).toBe("pending");

    const fetched = await host.task.get(record.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(record.id);

    await host.task.update(record.id, { status: "running" });
    const updated = await host.task.get(record.id);
    expect(updated!.status).toBe("running");

    const list = await host.task.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it("spawn computes child depth = parentDepth + 1", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const registry = new TaskRegistry();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn, registry });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
    });

    // Let transport wire up.
    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 100 },
    });

    const handle = await spawnPromise;
    expect(handle.agentId).toBeDefined();

    // Verify depth was passed correctly to spawnFn.
    expect(spawnFn).toHaveBeenCalledOnce();
    const callArgs = spawnFn.mock.calls[0]![0];
    expect(callArgs.depth).toBe(1); // parent=0, child=1
  });

  it("depth limit rejects when childDepth > maxDepth", async () => {
    const host = new StandaloneHost({ maxDepth: 0 });

    await expect(
      host.spawn({
        task: samplePacket(),
        permissionMode: "workspace-write",
      }),
    ).rejects.toThrow(/recursion depth limit reached/);
  });

  it("spawn ignores client-supplied SpawnRequest.depth field (orchestrator is authoritative)", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      depth: 999, // caller tries to pass arbitrary depth — must be ignored
    });

    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
    });

    await spawnPromise;

    // The orchestrator must have computed depth=1 regardless.
    const callArgs = spawnFn.mock.calls[0]![0];
    expect(callArgs.depth).toBe(1);
  });

  // Regression (C1): StandaloneHost.spawn must populate TaskRecord.owner with
  // the spawned child's agentId so host.task.ownerOf(taskId) resolves to the
  // running worker. Without this, task_stop's ancestry check short-circuits
  // to "unknown taskId" for every worker-side caller.
  it("spawn populates TaskRecord.owner with child agentId (C1 regression)", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const registry = new TaskRegistry();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn, registry });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
    });

    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
    });

    const handle = await spawnPromise;

    // Find the registry record created by spawn.
    const records = registry.list();
    expect(records).toHaveLength(1);
    const taskId = records[0]!.id;

    const owner = await host.task.ownerOf(taskId);
    expect(owner).toBeDefined();
    expect(owner).toBe(handle.agentId);
  });

  it("spawning with parentAgentId from first child computes depth=2", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    // First spawn: root (depth=0) → child (depth=1).
    const firstSpawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
    });

    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
    });

    const firstHandle = await firstSpawnPromise;
    const childAgentId = firstHandle.agentId;

    // Second spawn: use childAgentId as parentAgentId → grandchild depth=2.
    const { spawnFn: spawnFn2, emitFromWorker: emit2 } = makeSpawnOverride();

    const secondSpawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      parentAgentId: childAgentId,
    });

    // spawnFn was called again on the same host (2nd call uses spawnFn still
    // since host was constructed with spawnFn). We need to emit worker_ready
    // for the second child — but spawnFn still returns the same fake child.
    // Use emit2 helper (which targets a different child), so instead reuse
    // emitFromWorker which is bound to the child spawnFn always returns.
    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 0, outputTokens: 0 }, wallClockMs: 0 },
    });

    await secondSpawnPromise;

    // Second spawn call should have depth=2.
    expect(spawnFn.mock.calls).toHaveLength(2);
    const secondCallArgs = spawnFn.mock.calls[1]![0];
    expect(secondCallArgs.depth).toBe(2);

    // Suppress unused variable warning.
    void spawnFn2;
    void emit2;
  });
});

// ---------------------------------------------------------------------------
// askUser — M3b Phase 6
// ---------------------------------------------------------------------------

describe("StandaloneHost.askUser", () => {
  /**
   * Temporarily force process.stdin/stdout `isTTY` to a given value for the
   * duration of a test. `isTTY` is a runtime-set readonly property; we use
   * defineProperty so the override is reversible.
   */
  function withIsTTY(value: boolean): () => void {
    const prevIn = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const prevOut = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value,
    });
    return () => {
      if (prevIn) Object.defineProperty(process.stdin, "isTTY", prevIn);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (prevOut) Object.defineProperty(process.stdout, "isTTY", prevOut);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    };
  }

  it("TTY: reads a free-form answer via readline", async () => {
    const restore = withIsTTY(true);
    try {
      const host = new StandaloneHost({
        readlineFactory: async () => ({
          question: async () => "yes please",
          close: () => {},
        }),
      });
      const events: string[] = [];
      host["events"].on("lane_event", (e: { type: string }) =>
        events.push(e.type),
      );
      const result = await host.askUser("do you?");
      expect(result).toEqual({ status: "answered", answer: "yes please" });
      expect(events).toContain("ask_user_question_sent");
      expect(events).toContain("ask_user_question_answered");
    } finally {
      restore();
    }
  });

  it("headless (no TTY): returns {status: 'error'} with TTY message", async () => {
    const restore = withIsTTY(false);
    try {
      const host = new StandaloneHost();
      const result = await host.askUser("ping?");
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/TTY/);
      }
    } finally {
      restore();
    }
  });

  it("TTY + options: numeric answer maps to the option at that index", async () => {
    const restore = withIsTTY(true);
    try {
      const host = new StandaloneHost({
        readlineFactory: async () => ({
          // User types "2" → second option ("b").
          question: async () => "2",
          close: () => {},
        }),
      });
      const result = await host.askUser("pick one", ["a", "b", "c"]);
      expect(result).toEqual({ status: "answered", answer: "b" });
    } finally {
      restore();
    }
  });

  it("TTY + options: out-of-range numeric answer is returned as-is (literal)", async () => {
    const restore = withIsTTY(true);
    try {
      const host = new StandaloneHost({
        readlineFactory: async () => ({
          question: async () => "9",
          close: () => {},
        }),
      });
      const result = await host.askUser("pick one", ["a", "b"]);
      // 9 is out of range — fall through to raw answer.
      expect(result).toEqual({ status: "answered", answer: "9" });
    } finally {
      restore();
    }
  });

  it("TTY: trims whitespace from the answer", async () => {
    const restore = withIsTTY(true);
    try {
      const host = new StandaloneHost({
        readlineFactory: async () => ({
          question: async () => "   hello world   \n",
          close: () => {},
        }),
      });
      const result = await host.askUser("q");
      expect(result).toEqual({ status: "answered", answer: "hello world" });
    } finally {
      restore();
    }
  });
});
