/**
 * spawn-integration.test.ts
 *
 * Integration tests for StandaloneHost spawn depth enforcement and permission
 * clamping. No real subprocess is spawned — a fake spawnWorker is injected
 * that returns a PassThrough-based ChildProcess, exactly like standalone-host.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "./standalone-host.js";
import { TaskRegistry } from "./task-registry.js";
import type { TaskPacket, SpawnRequest } from "./host.js";
import type { AgentId, PermissionMode } from "../core/types.js";
import { encodeFrame } from "./ipc/framing.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";

// ---------------------------------------------------------------------------
// Helpers (mirrors standalone-host.test.ts pattern)
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

function makeSpawnOverride(): {
  spawnFn: ReturnType<typeof vi.fn> & ((args: SpawnWorkerArgs) => ChildProcess);
  emitFromWorker: (frame: object) => void;
  child: ChildProcess;
} {
  const { child, emitFromWorker } = fakeProcPair();
  const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);
  return { spawnFn, emitFromWorker, child };
}

/** Emit worker_ready then task_result so a spawn() resolves. */
async function resolveSpawn(emitFromWorker: (frame: object) => void): Promise<void> {
  await new Promise((r) => setImmediate(r));
  emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
  await new Promise((r) => setImmediate(r));
  emitFromWorker({
    kind: "notification",
    method: "task_result",
    params: {
      status: "success",
      output: "done",
      usage: { inputTokens: 1, outputTokens: 2 },
      wallClockMs: 10,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("spawn integration — depth enforcement", () => {
  it("scenario 1: 3-level nesting succeeds (depths 1, 2, 3 allocated)", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    // Root (depth=0) → child A (depth=1).
    const p1 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    await resolveSpawn(emitFromWorker);
    const handleA = await p1;
    expect(spawnFn.mock.calls[0]![0].depth).toBe(1);

    // Child A (depth=1) → child B (depth=2).
    const p2 = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      parentAgentId: handleA.agentId,
    });
    await resolveSpawn(emitFromWorker);
    const handleB = await p2;
    expect(spawnFn.mock.calls[1]![0].depth).toBe(2);

    // Child B (depth=2) → child C (depth=3).
    const p3 = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      parentAgentId: handleB.agentId,
    });
    await resolveSpawn(emitFromWorker);
    await p3;
    expect(spawnFn.mock.calls[2]![0].depth).toBe(3);

    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it("scenario 2: 4th level is rejected with recursion depth limit error", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    // Depth 1.
    const p1 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    await resolveSpawn(emitFromWorker);
    const h1 = await p1;

    // Depth 2.
    const p2 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write", parentAgentId: h1.agentId });
    await resolveSpawn(emitFromWorker);
    const h2 = await p2;

    // Depth 3.
    const p3 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write", parentAgentId: h2.agentId });
    await resolveSpawn(emitFromWorker);
    const h3 = await p3;

    // Depth 4 — must reject.
    await expect(
      host.spawn({ task: samplePacket(), permissionMode: "workspace-write", parentAgentId: h3.agentId }),
    ).rejects.toThrow(/recursion depth limit reached \(3\)/);

    // spawnFn was called only 3 times (the 4th was rejected before calling it).
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it("scenario 3: adversarial SpawnRequest.depth is ignored; orchestrator is authoritative", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    // Depth 1.
    const p1 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    await resolveSpawn(emitFromWorker);
    const h1 = await p1;

    // Depth 2 (parent is h1.agentId at depth 1).
    const p2 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write", parentAgentId: h1.agentId });
    await resolveSpawn(emitFromWorker);
    const h2 = await p2;

    // Depth 3 (parent is h2.agentId at depth 2).
    const p3 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write", parentAgentId: h2.agentId });
    await resolveSpawn(emitFromWorker);
    const h3 = await p3;

    // Now try to spoof: claim depth=0 but actually parent is at depth 3.
    // Orchestrator should compute depth=4 and reject.
    await expect(
      host.spawn({
        task: samplePacket(),
        permissionMode: "workspace-write",
        parentAgentId: h3.agentId,
        depth: 0, // adversarial: ignored
      }),
    ).rejects.toThrow(/recursion depth limit reached \(3\)/);

    // spawnFn called 3 times, not 4.
    expect(spawnFn).toHaveBeenCalledTimes(3);
    // Confirm each call had authoritative depths.
    expect(spawnFn.mock.calls[0]![0].depth).toBe(1);
    expect(spawnFn.mock.calls[1]![0].depth).toBe(2);
    expect(spawnFn.mock.calls[2]![0].depth).toBe(3);
  });
});

describe("spawn integration — permission clamping", () => {
  it("scenario 4: parent read-only + child requests danger-full-access → child gets read-only", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({
      maxDepth: 3,
      spawnWorker: spawnFn,
      permissionMode: "read-only",
    });

    const p = host.spawn({
      task: samplePacket(),
      permissionMode: "danger-full-access", // adversarial escalation attempt
    });
    await resolveSpawn(emitFromWorker);
    await p;

    // The env var passed to the subprocess must be clamped to "read-only".
    expect(spawnFn).toHaveBeenCalledOnce();
    const args: SpawnWorkerArgs = spawnFn.mock.calls[0]![0];
    expect(args.permissionMode).toBe("read-only" satisfies PermissionMode);
  });

  it("scenario 4b: parent workspace-write + child requests read-only → child keeps read-only", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({
      maxDepth: 3,
      spawnWorker: spawnFn,
      permissionMode: "workspace-write",
    });

    const p = host.spawn({
      task: samplePacket(),
      permissionMode: "read-only",
    });
    await resolveSpawn(emitFromWorker);
    await p;

    const args: SpawnWorkerArgs = spawnFn.mock.calls[0]![0];
    expect(args.permissionMode).toBe("read-only" satisfies PermissionMode);
  });

  it("scenario 4c: parent workspace-write + child requests danger-full-access → clamped to workspace-write", async () => {
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    const host = new StandaloneHost({
      maxDepth: 3,
      spawnWorker: spawnFn,
      permissionMode: "workspace-write",
    });

    const p = host.spawn({
      task: samplePacket(),
      permissionMode: "danger-full-access",
    });
    await resolveSpawn(emitFromWorker);
    await p;

    const args: SpawnWorkerArgs = spawnFn.mock.calls[0]![0];
    expect(args.permissionMode).toBe("workspace-write" satisfies PermissionMode);
  });
});

describe("spawn integration — SWARM_HARNESS_MAX_DEPTH env override", () => {
  afterEach(() => {
    delete process.env.SWARM_HARNESS_MAX_DEPTH;
  });

  it("scenario 5: SWARM_HARNESS_MAX_DEPTH=1 causes depth=2 to reject", async () => {
    process.env.SWARM_HARNESS_MAX_DEPTH = "1";
    const { spawnFn, emitFromWorker } = makeSpawnOverride();
    // No explicit maxDepth — should pick up from env via resolveMaxDepth().
    const host = new StandaloneHost({ spawnWorker: spawnFn });

    // Depth 1 — should succeed.
    const p1 = host.spawn({ task: samplePacket(), permissionMode: "workspace-write" });
    await resolveSpawn(emitFromWorker);
    const h1 = await p1;
    expect(spawnFn.mock.calls[0]![0].depth).toBe(1);

    // Depth 2 — should reject because maxDepth=1.
    await expect(
      host.spawn({
        task: samplePacket(),
        permissionMode: "workspace-write",
        parentAgentId: h1.agentId,
      }),
    ).rejects.toThrow(/recursion depth limit reached \(1\)/);

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe("spawn integration — permissionMode exposed on host", () => {
  it("StandaloneHost exposes permissionMode from options", () => {
    const host = new StandaloneHost({ permissionMode: "read-only" });
    expect(host.permissionMode).toBe("read-only");
  });

  it("StandaloneHost defaults permissionMode to workspace-write", () => {
    const host = new StandaloneHost();
    expect(host.permissionMode).toBe("workspace-write");
  });

  it("WorkerHost exposes permissionMode passed in constructor", async () => {
    const { WorkerHost } = await import("./worker-host.js");
    const { ParentTransport } = await import("./ipc/parent-transport.js");
    // We can't easily construct a real ParentTransport without stdio, so use
    // a minimal cast — we only need to verify the stored value.
    const fakeTransport = {} as InstanceType<typeof ParentTransport>;
    const wh = new WorkerHost(
      "agent-123" as AgentId,
      2,
      "danger-full-access",
      fakeTransport,
    );
    expect(wh.permissionMode).toBe("danger-full-access");
    expect(wh.depth).toBe(2);
  });
});
