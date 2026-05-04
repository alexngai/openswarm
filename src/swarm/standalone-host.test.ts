import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "./standalone-host.js";
import { TaskRegistry } from "./task-registry.js";
import type { TaskPacket } from "./host.js";
import type { AgentId } from "../core/types.js";
import { encodeFrame } from "./ipc/framing.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";
import { writeWorkerState } from "./worker-state-file.js";

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

  it("forwards request.framework to spawnWorker when set (v0.4 stage 4M.5, Q9 fix)", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      framework: "codex-chatgpt",
    });

    await new Promise((r) => setImmediate(r));
    emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    await new Promise((r) => setImmediate(r));
    emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: { status: "success", output: "done", usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 100 },
    });

    await spawnPromise;

    expect(spawnFn).toHaveBeenCalledOnce();
    const callArgs = spawnFn.mock.calls[0]![0];
    expect(callArgs.framework).toBe("codex-chatgpt");
  });

  it("omits framework from spawnWorker args when SpawnRequest.framework is undefined", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

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
      params: { status: "success", output: "done", usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 100 },
    });

    await spawnPromise;

    expect(spawnFn).toHaveBeenCalledOnce();
    const callArgs = spawnFn.mock.calls[0]![0];
    expect(callArgs.framework).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // Stage 4A.3: scope-aware send_message
  // -------------------------------------------------------------------------

  it("scope-isolates broadcast: `*` from team A does not reach team B", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    // Inject a permissive spawnFn that returns a fresh fake child each call,
    // and pre-acks worker_ready so spawn() resolves quickly.
    const children: ReturnType<typeof fakeProcPair>[] = [];
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      _args: SpawnWorkerArgs,
    ) => {
      const pair = fakeProcPair();
      children.push(pair);
      // Drive worker_ready + a successful task_result on next ticks so the
      // spawn() promise resolves cleanly.
      setImmediate(() => {
        pair.emitFromWorker({
          kind: "notification",
          method: "worker_ready",
          params: {},
        });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: {
              status: "success",
              output: "done",
              usage: { inputTokens: 0, outputTokens: 0 },
              wallClockMs: 0,
            },
          });
        });
      });
      return pair.child;
    };

    const alphaHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-a",
    });
    const bravoHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-a",
    });
    const charlieHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-b",
    });

    // Sanity: scopeOf reports the right scope for each agent.
    expect(host.scopeOf(alphaHandle.agentId)).toBe("swarm:team-a");
    expect(host.scopeOf(bravoHandle.agentId)).toBe("swarm:team-a");
    expect(host.scopeOf(charlieHandle.agentId)).toBe("swarm:team-b");

    const result = await host.send("*", {
      from: alphaHandle.agentId,
      to: "*" as unknown as AgentId,
      content: "broadcast within team-a",
      timestamp: Date.now(),
    });

    // Only bravo should receive — charlie is in team-b.
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(1);
  });

  it("scope-isolates role addressing: role:reviewer from team A does not match reviewers in team B", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      _args: SpawnWorkerArgs,
    ) => {
      const pair = fakeProcPair();
      setImmediate(() => {
        pair.emitFromWorker({
          kind: "notification",
          method: "worker_ready",
          params: {},
        });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: {
              status: "success",
              output: "done",
              usage: { inputTokens: 0, outputTokens: 0 },
              wallClockMs: 0,
            },
          });
        });
      });
      return pair.child;
    };

    const alphaHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-a",
      role: "reviewer",
    });
    const bravoHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-b",
      role: "reviewer",
    });

    expect(host.scopeOf(alphaHandle.agentId)).toBe("swarm:team-a");
    expect(host.scopeOf(bravoHandle.agentId)).toBe("swarm:team-b");

    // alpha sends to role:reviewer — should resolve only to reviewers in team-a,
    // and self is excluded so recipients = []. delivered must be 0.
    const result = await host.send("role:reviewer", {
      from: alphaHandle.agentId,
      to: "role:reviewer" as unknown as AgentId,
      content: "any other reviewers around?",
      timestamp: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Stage 4M (B1): message_sent payload includes content for until_signal listeners
  // -------------------------------------------------------------------------

  it("emits message_sent with content so peer-team until_signal can match", async () => {
    const host = new StandaloneHost({ maxDepth: 5 });
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      _args: SpawnWorkerArgs,
    ) => {
      const pair = fakeProcPair();
      setImmediate(() => {
        pair.emitFromWorker({
          kind: "notification",
          method: "worker_ready",
          params: {},
        });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: {
              status: "success",
              output: "done",
              usage: { inputTokens: 0, outputTokens: 0 },
              wallClockMs: 0,
            },
          });
        });
      });
      return pair.child;
    };

    const alphaHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-a",
    });
    const bravoHandle = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-a",
    });

    const messageSentEvents: Array<{ type: string; payload: unknown }> = [];
    host["events"].on("lane_event", (e: { type: string; payload: unknown }) => {
      if (e.type === "message_sent") messageSentEvents.push(e);
    });

    const result = await host.send(bravoHandle.agentId, {
      from: alphaHandle.agentId,
      to: bravoHandle.agentId,
      content: "team consensus: APPROVED — ship it",
      timestamp: Date.now(),
    });

    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(1);
    expect(messageSentEvents).toHaveLength(1);
    const payload = messageSentEvents[0]!.payload as {
      content?: string;
      from?: string;
      to?: string;
    };
    expect(payload.content).toBe("team consensus: APPROVED — ship it");
    expect(payload.from).toBe(alphaHandle.agentId);
    expect(payload.to).toBe(bravoHandle.agentId);
  });

  it("end-to-end: peer-team until_signal matcher resolves via real host.send()", async () => {
    // Drives the same listener pattern PeerTeamTopology installs for
    // CompletionRule "until_signal", but against a real StandaloneHost.send()
    // (B1 regression). If message_sent ever stops including content again,
    // this test fails immediately.
    const host = new StandaloneHost({ maxDepth: 5 });
    (host as unknown as { spawnFn: (a: SpawnWorkerArgs) => unknown }).spawnFn = (
      _args: SpawnWorkerArgs,
    ) => {
      const pair = fakeProcPair();
      setImmediate(() => {
        pair.emitFromWorker({
          kind: "notification",
          method: "worker_ready",
          params: {},
        });
        setImmediate(() => {
          pair.emitFromWorker({
            kind: "notification",
            method: "task_result",
            params: {
              status: "success",
              output: "done",
              usage: { inputTokens: 0, outputTokens: 0 },
              wallClockMs: 0,
            },
          });
        });
      });
      return pair.child;
    };

    const sender = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-x",
    });
    const receiver = await host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      teamScope: "swarm:team-x",
    });

    const signal = "APPROVED";
    const signalP = new Promise<void>((resolve) => {
      const handler = (event: { type: string; payload?: unknown }): void => {
        if (event.type !== "message_sent") return;
        const payload = event.payload as { content?: string } | undefined;
        if (
          payload !== undefined &&
          typeof payload.content === "string" &&
          payload.content.includes(signal)
        ) {
          host["events"].off("lane_event", handler);
          resolve();
        }
      };
      host["events"].on("lane_event", handler);
    });

    await host.send(receiver.agentId, {
      from: sender.agentId,
      to: receiver.agentId,
      content: `team consensus: ${signal} — ship it`,
      timestamp: Date.now(),
    });

    await expect(signalP).resolves.toBeUndefined();
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

  // M1 regression: AbortSignal cancels the readline prompt and closes rl.
  it("TTY + AbortSignal: aborting mid-question returns {status: cancelled} and closes rl (M1)", async () => {
    const restore = withIsTTY(true);
    try {
      const closeFn = vi.fn();
      const ac = new AbortController();

      const host = new StandaloneHost({
        readlineFactory: async () => ({
          question: async (_prompt: string, opts?: { signal?: AbortSignal }) => {
            // Simulate readline honouring the AbortSignal: when aborted, reject
            // with an AbortError (same as node:readline/promises behaviour).
            return new Promise<string>((_resolve, reject) => {
              if (opts?.signal) {
                opts.signal.addEventListener("abort", () => {
                  const err = new Error("This operation was aborted");
                  err.name = "AbortError";
                  reject(err);
                }, { once: true });
              }
              // Abort immediately after listener is registered.
              ac.abort();
            });
          },
          close: closeFn,
        }),
      });

      const result = await host.askUser("continue?", undefined, ac.signal);
      expect(result).toEqual({ status: "cancelled" });
      expect(closeFn).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("TTY + AbortSignal: already-aborted signal returns {status: cancelled} immediately (M1)", async () => {
    const restore = withIsTTY(true);
    try {
      const ac = new AbortController();
      ac.abort(); // already aborted before askUser is called

      const host = new StandaloneHost({
        readlineFactory: async () => ({
          question: async () => "should not be called",
          close: () => {},
        }),
      });

      const result = await host.askUser("q?", undefined, ac.signal);
      expect(result).toEqual({ status: "cancelled" });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// scanForOrphanWorkers (v0.2 Stage 2B)
// SWARM_HARNESS_WORKERS_DIR is set to a tmp dir in vitest-setup.ts so these
// writes never touch ~/.swarm-harness/workers/.
// ---------------------------------------------------------------------------

describe("StandaloneHost.scanForOrphanWorkers", () => {
  it("returns empty list when no state files exist", () => {
    const host = new StandaloneHost();
    const orphans = host.scanForOrphanWorkers();
    // May include entries from other tests in the same vitest worker; just
    // assert none have our own pid as a dead pid (we ARE alive).
    const ownPidEntries = orphans.filter((s) => s.pid === process.pid);
    expect(ownPidEntries).toHaveLength(0);
  });

  it("returns non-terminal entries whose process is not alive", () => {
    const deadPid = 999999; // almost certainly not a live process
    const agentId = crypto.randomUUID() as AgentId;
    writeWorkerState({
      agentId,
      pid: deadPid,
      startedAt: Date.now(),
      lifecycleState: "running",
      lastTransitionAt: Date.now(),
    });

    const host = new StandaloneHost();
    const orphans = host.scanForOrphanWorkers();
    const match = orphans.find((s) => s.agentId === agentId);
    expect(match).toBeDefined();
    expect(match!.lifecycleState).toBe("running");
  });

  it("skips entries with terminal lifecycleState=finished even if process is dead", () => {
    const deadPid = 999999;
    const agentId = crypto.randomUUID() as AgentId;
    writeWorkerState({
      agentId,
      pid: deadPid,
      startedAt: Date.now(),
      lifecycleState: "finished",
      lastTransitionAt: Date.now(),
    });

    const host = new StandaloneHost();
    const orphans = host.scanForOrphanWorkers();
    expect(orphans.find((s) => s.agentId === agentId)).toBeUndefined();
  });

  it("skips entries with terminal lifecycleState=failed even if process is dead", () => {
    const deadPid = 999999;
    const agentId = crypto.randomUUID() as AgentId;
    writeWorkerState({
      agentId,
      pid: deadPid,
      startedAt: Date.now(),
      lifecycleState: "failed",
      lastTransitionAt: Date.now(),
      failureClass: "panic",
      reason: "engine blew up",
    });

    const host = new StandaloneHost();
    const orphans = host.scanForOrphanWorkers();
    expect(orphans.find((s) => s.agentId === agentId)).toBeUndefined();
  });

  it("skips non-terminal entries whose process IS alive", () => {
    const agentId = crypto.randomUUID() as AgentId;
    writeWorkerState({
      agentId,
      pid: process.pid, // this process is alive
      startedAt: Date.now(),
      lifecycleState: "running",
      lastTransitionAt: Date.now(),
    });

    const host = new StandaloneHost();
    const orphans = host.scanForOrphanWorkers();
    expect(orphans.find((s) => s.agentId === agentId)).toBeUndefined();
  });
});
