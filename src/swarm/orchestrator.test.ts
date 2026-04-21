/**
 * orchestrator.test.ts — unit tests for Orchestrator.
 *
 * All tests inject a fake StandaloneHost via opts.host so no real
 * subprocess is ever spawned. The fake host's spawn() returns a
 * mock AgentHandle with a canned result.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorOptions } from "./orchestrator.js";
import type { StandaloneHost } from "./standalone-host.js";
import type { AgentHandle, AgentResult, TaskPacket } from "./host.js";
import type { AgentId, SessionId } from "../core/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function samplePacket(id: string, overrides: Partial<TaskPacket> = {}): TaskPacket {
  return {
    id,
    prompt: `task ${id}`,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    ...overrides,
  };
}

function makeHandle(
  result: AgentResult,
  agentId: AgentId = "agent-1" as AgentId,
  sessionId: SessionId = "session-1" as SessionId,
  delayMs = 0,
): AgentHandle {
  return {
    agentId,
    sessionId,
    wait: () =>
      delayMs > 0
        ? new Promise((resolve) => setTimeout(() => resolve(result), delayMs))
        : Promise.resolve(result),
    kill: vi.fn(() => Promise.resolve()),
    events: async function* () { return; },
  };
}

function successResult(output = "done"): AgentResult {
  return { status: "success", output, usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 50 };
}

function failureResult(error = "boom"): AgentResult {
  return { status: "failure", error, wallClockMs: 10 };
}

/**
 * Build a minimal fake StandaloneHost that delegates spawn to the provided fn.
 */
function fakeHost(
  spawnImpl: (req: Parameters<StandaloneHost["spawn"]>[0]) => Promise<AgentHandle>,
): StandaloneHost {
  return {
    mode: "standalone",
    agentId: "orchestrator-agent" as AgentId,
    depth: 0,
    spawn: spawnImpl,
    emit: vi.fn(),
    send: vi.fn(),
    inbox: async function* () { return; },
    task: {} as StandaloneHost["task"],
  } as unknown as StandaloneHost;
}

/**
 * Collect all bytes written to a PassThrough and parse them as JSONL.
 */
async function collectJsonl(stream: PassThrough): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const lines = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      resolve(lines);
    });
    stream.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. Happy path: 3 tasks, all succeed.
  it("happy path: 3 tasks all succeed → 3 result lines with status succeeded", async () => {
    const host = fakeHost(async (req) => {
      return makeHandle(
        successResult(`output for ${req.task.id}`),
        `agent-${req.task.id}` as AgentId,
        `session-${req.task.id}` as SessionId,
      );
    });

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 3,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const tasks = [
      samplePacket("t1"),
      samplePacket("t2"),
      samplePacket("t3"),
    ];

    const summary = await orch.run(tasks);
    resultsOut.end();
    const lines = await collectPromise;

    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.timeout).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(summary.resultWriteFailures).toBe(0);

    expect(lines).toHaveLength(3);
    const ids = (lines as Array<{ id: string; status: string }>).map((l) => l.id).sort();
    expect(ids).toEqual(["t1", "t2", "t3"]);
    for (const line of lines as Array<{ status: string }>) {
      expect(line.status).toBe("succeeded");
    }
  });

  // 2. Concurrency capping: 5 tasks, concurrency=2, activeCount never exceeds 2.
  it("concurrency capping: activeCount never exceeds configured limit", async () => {
    let maxSeen = 0;
    let current = 0;

    const host = fakeHost(async (_req) => {
      current++;
      if (current > maxSeen) maxSeen = current;
      // Simulate async work.
      await new Promise((r) => setTimeout(r, 5));
      current--;
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    resultsOut.resume(); // drain without collecting

    const orch = new Orchestrator({
      concurrency: 2,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const tasks = Array.from({ length: 5 }, (_, i) => samplePacket(`t${i + 1}`));
    await orch.run(tasks);
    resultsOut.end();

    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(maxSeen).toBeGreaterThanOrEqual(1);
  });

  // 3. Result ordering: completedAt is set at write time (not spawn time).
  it("result ordering: completedAt is a positive epoch ms number for each task", async () => {
    const before = Date.now();

    const host = fakeHost(async (req) => {
      return makeHandle(successResult(), `agent-${req.task.id}` as AgentId);
    });

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 3,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    await orch.run([samplePacket("a"), samplePacket("b"), samplePacket("c")]);
    resultsOut.end();

    const after = Date.now();
    const lines = (await collectPromise) as Array<{ completedAt: number }>;

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.completedAt).toBeGreaterThanOrEqual(before);
      expect(line.completedAt).toBeLessThanOrEqual(after);
    }
  });

  // 4. Task-level failure: one task rejects → result shows failed, orchestrator continues.
  it("task-level failure: failed task is written as failed, other tasks still complete", async () => {
    const host = fakeHost(async (req) => {
      if (req.task.id === "bad") {
        return makeHandle(failureResult("exploded"));
      }
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 3,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const summary = await orch.run([
      samplePacket("good1"),
      samplePacket("bad"),
      samplePacket("good2"),
    ]);
    resultsOut.end();

    const lines = (await collectPromise) as Array<{ id: string; status: string; error?: string }>;

    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);

    const badLine = lines.find((l) => l.id === "bad");
    expect(badLine).toBeDefined();
    expect(badLine!.status).toBe("failed");
    expect(badLine!.error).toBe("exploded");
  });

  // 5. Write-failure: resultsOut errors on write → resultWriteFailures > 0.
  it("write-failure: broken resultsOut increments resultWriteFailures", async () => {
    const host = fakeHost(async () => makeHandle(successResult()));

    // A Writable that always errors on write.
    const brokenOut = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error("EBADF: bad file descriptor"));
      },
    });

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut: brokenOut,
      host,
    });

    const summary = await orch.run([samplePacket("x")]);

    expect(summary.resultWriteFailures).toBeGreaterThan(0);
  });

  // 7. Pre-flight: branchPolicy reuse — missing branch → task fails without spawn.
  it("pre-flight: branchPolicy reuse with missing branch fails task without spawn", async () => {
    const spawnMock = vi.fn();
    const host = fakeHost(spawnMock);

    const spawnSyncSpy = vi.spyOn(
      await import("node:child_process"),
      "spawnSync",
    ).mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("fatal: not a git branch"),
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const task = samplePacket("branch-missing", {
      branchPolicy: { kind: "reuse", branch: "feature/nonexistent" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();
    const lines = (await collectPromise) as Array<{ id: string; status: string; error?: string }>;

    expect(summary.failed).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();

    const failedLine = lines.find((l) => l.id === "branch-missing");
    expect(failedLine).toBeDefined();
    expect(failedLine!.status).toBe("failed");
    expect(failedLine!.error).toContain("feature/nonexistent");

    spawnSyncSpy.mockRestore();
  });

  // 8. Pre-flight: branchPolicy reuse with existing branch → spawn proceeds.
  it("pre-flight: branchPolicy reuse with existing branch proceeds to spawn", async () => {
    const spawnSyncSpy = vi.spyOn(
      await import("node:child_process"),
      "spawnSync",
    ).mockReturnValue({
      status: 0,
      stdout: Buffer.from("abc1234"),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const host = fakeHost(async (req) =>
      makeHandle(successResult(`spawned for ${req.task.id}`)),
    );

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const task = samplePacket("branch-exists", {
      branchPolicy: { kind: "reuse", branch: "main" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();
    const lines = (await collectPromise) as Array<{ id: string; status: string }>;

    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    const line = lines.find((l) => l.id === "branch-exists");
    expect(line?.status).toBe("succeeded");

    spawnSyncSpy.mockRestore();
  });

  // 9. Pre-flight: branchPolicy create with missing from branch → task fails.
  it("pre-flight: branchPolicy create with missing from branch fails task", async () => {
    const spawnMock = vi.fn();
    const host = fakeHost(spawnMock);

    const spawnSyncSpy = vi.spyOn(
      await import("node:child_process"),
      "spawnSync",
    ).mockReturnValue({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("fatal: not a valid object name"),
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const task = samplePacket("create-bad-base", {
      branchPolicy: { kind: "create", from: "nonexistent-base" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();
    const lines = (await collectPromise) as Array<{ id: string; status: string; error?: string }>;

    expect(summary.failed).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();

    const failedLine = lines.find((l) => l.id === "create-bad-base");
    expect(failedLine?.status).toBe("failed");
    expect(failedLine?.error).toContain("nonexistent-base");

    spawnSyncSpy.mockRestore();
  });

  // 6. Cancelled: pool.close() called mid-run → queued tasks written as cancelled.
  it("cancelled: closing the pool marks queued tasks as cancelled", async () => {
    // Use concurrency=1 so second task queues behind first.
    // First task takes long enough that we can close the pool before it finishes.
    // The second task should be cancelled (never dequeued).
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((res) => {
      resolveFirst = res;
    });

    const host = fakeHost(async (req) => {
      if (req.task.id === "slow") {
        // Signal that slow task has started, then block briefly.
        resolveFirst();
        await new Promise((r) => setTimeout(r, 50));
        return makeHandle(successResult("slow done"));
      }
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    // Access pool via a subclass trick: we need to close it externally.
    // Instead, we spy on pool.close via a small wrapper host that intercepts.
    // Simpler: create orchestrator, start run(), wait for first task to start,
    // then call pool.close indirectly by triggering SIGINT simulation.
    // Actually: the cleanest way is to close the pool by replacing it.
    // Per the spec: "pool.close() called mid-run". The only public API is
    // through the Orchestrator's SIGINT handler. We emit SIGINT.

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const runPromise = orch.run([samplePacket("slow"), samplePacket("queued")]);

    // Wait until slow task has actually started, then emit SIGINT once.
    await firstStarted;
    process.emit("SIGINT");

    const summary = await runPromise;
    resultsOut.end();

    const lines = (await collectPromise) as Array<{ id: string; status: string }>;

    // "queued" was waiting in the pool queue and should be cancelled.
    const queuedLine = lines.find((l) => l.id === "queued");
    expect(queuedLine).toBeDefined();
    expect(queuedLine!.status).toBe("cancelled");

    expect(summary.cancelled).toBeGreaterThanOrEqual(1);
  });
});
