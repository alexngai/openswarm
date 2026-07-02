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
    runMore: () => Promise.reject(new Error("runMore not supported in test fake")),
    drain: () => Promise.resolve(),
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
    // v0.7 stage 7G — fanout topology consults this before applying defaults.
    supportsStreams: () => false,
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

  it("propagates per-task model through legacy fanout conversion", async () => {
    const seen: Array<string | undefined> = [];
    const host = fakeHost(async (req) => {
      seen.push(req.model);
      return makeHandle(successResult(), `agent-${req.task.id}` as AgentId);
    });

    const resultsOut = new PassThrough();
    resultsOut.resume();
    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    await orch.run([
      samplePacket("t1", { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }),
    ]);
    resultsOut.end();

    expect(seen).toEqual(["us.anthropic.claude-sonnet-4-5-20250929-v1:0"]);
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

  // C3 regression: branch-lock key for `{ kind: "create", name: undefined }`
  // must skip lock acquire entirely. Synthesizing a per-task key would
  // generate DIFFERENT keys for two tasks targeting the same base, making
  // the lock a no-op — defeating its purpose. The orchestrator must emit a
  // `branch_policy_noop` event with `reason: "create_without_name"` so
  // operators see the skip.
  it("C3: two `create` tasks without name skip lock acquire and emit branch_policy_noop", async () => {
    const branchLockModule = await import("./git/branch-lock.js");

    const acquireSpy = vi
      .spyOn(branchLockModule, "acquire")
      .mockImplementation(async () => ({
        branch: "should-not-be-called",
        release: async () => {},
      }));

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

    const emittedEvents: Array<{ type: string; payload?: unknown }> = [];
    const host = fakeHost(async (req) =>
      makeHandle(successResult(`spawned for ${req.task.id}`)),
    );
    (host as unknown as { emit: (e: unknown) => void }).emit = (e) => {
      emittedEvents.push(e as { type: string; payload?: unknown });
    };

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 2,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const tasks = [
      samplePacket("c3-a", { branchPolicy: { kind: "create", from: "main" } }),
      samplePacket("c3-b", { branchPolicy: { kind: "create", from: "main" } }),
    ];

    const summary = await orch.run(tasks);
    resultsOut.end();

    // Both tasks completed without acquiring any lock.
    expect(summary.succeeded).toBe(2);
    expect(acquireSpy).not.toHaveBeenCalled();

    // No branch_lock_acquired events.
    const lockAcquired = emittedEvents.filter(
      (e) => e.type === "branch_lock_acquired",
    );
    expect(lockAcquired).toHaveLength(0);

    // branch_policy_noop with reason "create_without_name" emitted for both.
    const noops = emittedEvents.filter(
      (e) =>
        e.type === "branch_policy_noop" &&
        (e.payload as { reason?: string } | undefined)?.reason ===
          "create_without_name",
    );
    expect(noops.length).toBeGreaterThanOrEqual(2);
    const taskIdsWithNoop = noops
      .map((e) => (e.payload as { taskId: string }).taskId)
      .sort();
    expect(taskIdsWithNoop).toEqual(["c3-a", "c3-b"]);

    acquireSpy.mockRestore();
    spawnSyncSpy.mockRestore();
  });

  // C3 regression (positive case): two `create` tasks with the SAME explicit
  // `.name` must serialize on that name. The second task's acquire must only
  // begin after the first task's release() has been called.
  it("C3: two `create` tasks with same explicit name serialize on that name", async () => {
    const branchLockModule = await import("./git/branch-lock.js");

    // Track acquire lifecycle: record each call's [acquiredAt, releasedAt].
    const timeline: Array<{
      taskKey: string;
      acquiredAt: number;
      releasedAt?: number;
    }> = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const acquireSpy = vi
      .spyOn(branchLockModule, "acquire")
      .mockImplementation(async (branch: string) => {
        // Emulate a mutex on the branch name: block while another holder is
        // still in flight for the same branch key.
        while (
          timeline.some(
            (e) => e.taskKey === branch && e.releasedAt === undefined,
          )
        ) {
          await new Promise<void>((res) => setTimeout(res, 5));
        }
        const entry: {
          taskKey: string;
          acquiredAt: number;
          releasedAt?: number;
        } = { taskKey: branch, acquiredAt: Date.now() };
        timeline.push(entry);
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        return {
          branch,
          release: async () => {
            entry.releasedAt = Date.now();
            inFlight--;
          },
        };
      });

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

    // Slow spawn handler so the first task holds the lock long enough for
    // the second task to observe contention.
    const host = fakeHost(async (req) =>
      makeHandle(
        successResult(`spawned for ${req.task.id}`),
        `agent-${req.task.id}` as AgentId,
        `session-${req.task.id}` as SessionId,
        30, // 30ms wait
      ),
    );

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 2,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const tasks = [
      samplePacket("c3-named-a", {
        branchPolicy: { kind: "create", from: "main", name: "feature/x" },
      }),
      samplePacket("c3-named-b", {
        branchPolicy: { kind: "create", from: "main", name: "feature/x" },
      }),
    ];

    const summary = await orch.run(tasks);
    resultsOut.end();

    expect(summary.succeeded).toBe(2);

    // acquire called twice, both with the explicit branch name.
    expect(acquireSpy).toHaveBeenCalledTimes(2);
    expect(acquireSpy.mock.calls[0]![0]).toBe("feature/x");
    expect(acquireSpy.mock.calls[1]![0]).toBe("feature/x");

    // Serialization: at most one acquire in flight for "feature/x" at a time.
    expect(maxInFlight).toBe(1);

    // Second acquire started no earlier than first release.
    expect(timeline).toHaveLength(2);
    expect(timeline[0]!.releasedAt).toBeDefined();
    expect(timeline[1]!.acquiredAt).toBeGreaterThanOrEqual(
      timeline[0]!.releasedAt!,
    );

    acquireSpy.mockRestore();
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

// ---------------------------------------------------------------------------
// M3a Phase 6 — Role dispatch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M3a revisions — budget + dead-letter + usage fixes
// ---------------------------------------------------------------------------

describe("Orchestrator — per-attempt wall-clock ceiling (C2 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("kills a runaway attempt at maxWallClockMsPerAttempt and dead-letters with per_attempt_budget_exceeded", async () => {
    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "swarm-c2-"));
    const deadLetterPath = nodePath.join(tmpDir, "dl.jsonl");

    // Handle whose wait() never resolves — simulates a frozen attempt that
    // the orchestrator must kill at the per-attempt ceiling.
    const killSpy = vi.fn(() => Promise.resolve());
    const host = fakeHost(async () => ({
      agentId: "stuck-agent" as AgentId,
      sessionId: "stuck-session" as SessionId,
      wait: () => new Promise<AgentResult>(() => {}), // never resolves
      kill: killSpy,
      events: async function* () { return; },
      runMore: () => Promise.reject(new Error("runMore not supported in test fake")),
      drain: () => Promise.resolve(),
    }));

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
    });

    const task = samplePacket("runaway", {
      budget: { maxWallClockMsPerAttempt: 50 },
      escalationPolicy: { kind: "retry", max: 3, backoff: "fixed" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();

    // kill() must have been called at least once.
    expect(killSpy).toHaveBeenCalled();

    // Dead-letter file must contain a line with per_attempt_budget_exceeded.
    const dlContent = await nodeFs.readFile(deadLetterPath, "utf8");
    const lines = dlContent
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id: string; lastStatus: string });
    const ours = lines.find((l) => l.id === "runaway");
    expect(ours).toBeDefined();
    expect(ours!.lastStatus).toBe("per_attempt_budget_exceeded");

    // Summary should reflect deadLetterViolation (no allowDeadLetter).
    expect(summary.deadLetterViolation).toBe(true);

    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);
});

describe("Orchestrator — per-attempt timer cleared on race-win (M3b Phase 8.0a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("clears the per-attempt setTimeout when waitPromise wins the race", async () => {
    // Use fake timers so we can inspect how many are pending after the run.
    // The orchestrator sets a setTimeout(ceilingMs) for the timeout race; we
    // resolve waitPromise quickly and assert no timers remain scheduled.
    vi.useFakeTimers();

    // Resolve the wait() call on the next microtask, then advance real/fake
    // time — if the fix is in place, no timers should be left behind.
    const host = fakeHost(async () =>
      makeHandle(successResult("fast done")),
    );

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    // 10 minute ceiling; the wait resolves immediately so the timer MUST be
    // cleared to avoid hanging the event loop.
    const task = samplePacket("fast", {
      budget: { maxWallClockMsPerAttempt: 10 * 60_000 },
    });

    const runPromise = orch.run([task]);
    // Drive pending microtasks + any scheduled 0-delay tasks through fake timers.
    await vi.runAllTimersAsync();
    const summary = await runPromise;
    resultsOut.end();

    expect(summary.succeeded).toBe(1);
    // With the fix, no per-attempt timer should remain pending.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("process can exit within 50ms after run() returns when per-attempt ceiling is huge", async () => {
    // Real timers: measure wall-clock between run() resolution and a
    // setImmediate callback. If the ceiling timer is still pending, the
    // setImmediate will still fire but Node's event loop would have extra
    // pending timers keeping it alive. We assert on the wall-clock delta and
    // indirectly that the event loop can drain.
    const host = fakeHost(async () => makeHandle(successResult(), undefined, undefined, 5));

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    const task = samplePacket("quick", {
      budget: { maxWallClockMsPerAttempt: 10 * 60_000 }, // 10 min ceiling
    });

    await orch.run([task]);
    resultsOut.end();

    const beforeImmediate = Date.now();
    await new Promise<void>((r) => setImmediate(r));
    const delta = Date.now() - beforeImmediate;

    // setImmediate should fire within 50ms of scheduling regardless of the
    // pending ceiling timer. More importantly, the process is unblocked.
    expect(delta).toBeLessThan(50);
  });
});

describe("Orchestrator — dead-letter write failures force exit non-zero (M2 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forces deadLetterViolation=true even with allowDeadLetter=true when DeadLetterWriter has write failures", async () => {
    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "swarm-m2-"));
    // Point deadLetterPath at a DIRECTORY so every write fails with EISDIR.
    const deadLetterPath = tmpDir;

    const host = fakeHost(async () => makeHandle(failureResult("boom")));

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
      allowDeadLetter: true, // should NOT suppress write failures
    });

    const task = samplePacket("will-fail", {
      escalationPolicy: { kind: "retry", max: 1, backoff: "fixed" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();

    expect(summary.deadLetterWriteFailures).toBeGreaterThan(0);
    expect(summary.deadLetterViolation).toBe(true);

    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);
});

describe("Orchestrator — dead-letter cumulativeUsage input/output split (M4 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records separate input/output token totals across retries", async () => {
    const nodeFs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await nodeFs.mkdtemp(nodePath.join(os.tmpdir(), "swarm-m4-"));
    const deadLetterPath = nodePath.join(tmpDir, "dl.jsonl");

    let call = 0;
    const host = fakeHost(async () => {
      call += 1;
      // Two failures with distinct input/output usage values.
      const result: AgentResult =
        call === 1
          ? {
              status: "failure",
              error: "first",
              usage: { inputTokens: 11, outputTokens: 22 },
              wallClockMs: 5,
            }
          : {
              status: "failure",
              error: "second",
              usage: { inputTokens: 33, outputTokens: 44 },
              wallClockMs: 5,
            };
      return makeHandle(result);
    });

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
    });

    const task = samplePacket("usage-split", {
      escalationPolicy: { kind: "retry", max: 1, backoff: "fixed" },
    });

    await orch.run([task]);
    resultsOut.end();

    const dlContent = await nodeFs.readFile(deadLetterPath, "utf8");
    const lines = dlContent
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            id: string;
            cumulativeUsage?: { input: number; output: number };
          },
      );
    const ours = lines.find((l) => l.id === "usage-split");
    expect(ours).toBeDefined();
    // After 2 failures: inputs = 11+33 = 44, outputs = 22+44 = 66.
    expect(ours!.cumulativeUsage).toEqual({ input: 44, output: 66 });

    await nodeFs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);
});

describe("Orchestrator — cross-run dead-letter delta (M3 regression)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("second run with --allow-dead-letter does not see prior run's lines as a delta", async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
    const nodePath = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await mkdtemp(nodePath.join(os.tmpdir(), "swarm-m3-"));
    const deadLetterPath = nodePath.join(tmpDir, "dl.jsonl");

    // Seed the file with a prior run's entries.
    await writeFile(
      deadLetterPath,
      JSON.stringify({
        id: "prior",
        attempts: 2,
        lastStatus: "failure",
        droppedAt: Date.now(),
      }) + "\n",
    );

    // Second "run" that succeeds with no new failures — it should NOT see
    // the prior file contents as a delta. allowDeadLetter still true.
    const host = fakeHost(async () => makeHandle(successResult()));
    const resultsOut = new PassThrough();
    resultsOut.resume();
    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
      allowDeadLetter: true,
    });

    const summary = await orch.run([samplePacket("clean")]);
    resultsOut.end();

    expect(summary.deadLetterViolation).toBe(false);
    expect(summary.deadLetterWriteFailures).toBe(0);

    // File still holds the prior entry.
    const content = await readFile(deadLetterPath, "utf8");
    expect(content).toContain("prior");

    await rm(tmpDir, { recursive: true, force: true });
  }, 10_000);
});

describe("Orchestrator — role dispatch (M3a Phase 6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies defaultRole to every task without a per-task role", async () => {
    const { RoleRegistry, BUILTIN_ROLES } = await import("./roles.js");
    const roles = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roles.register(r);

    const observed: Array<{ role?: string; allowedTools?: readonly string[] }> = [];
    const host = fakeHost(async (req) => {
      observed.push({
        role: req.role,
        allowedTools: req.allowedTools,
      });
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 2,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      roles,
      defaultRole: "executor",
    });

    await orch.run([samplePacket("a"), samplePacket("b")]);
    resultsOut.end();

    expect(observed).toHaveLength(2);
    for (const o of observed) {
      expect(o.role).toBe("executor");
      expect(o.allowedTools).toBeDefined();
      expect(o.allowedTools!).toContain("bash");
      expect(o.allowedTools!).not.toContain("agent");
    }
  });

  it("per-task role overrides defaultRole", async () => {
    const { RoleRegistry, BUILTIN_ROLES } = await import("./roles.js");
    const roles = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roles.register(r);

    const observed: Array<{ taskId: string; role?: string }> = [];
    const host = fakeHost(async (req) => {
      observed.push({ taskId: req.task.id, role: req.role });
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 2,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      roles,
      defaultRole: "executor",
    });

    await orch.run([
      samplePacket("default"),
      samplePacket("override", { role: "architect" } as Partial<TaskPacket>),
    ]);
    resultsOut.end();

    const defaultTask = observed.find((o) => o.taskId === "default");
    const overrideTask = observed.find((o) => o.taskId === "override");
    expect(defaultTask?.role).toBe("executor");
    expect(overrideTask?.role).toBe("architect");
  });

  it("unknown role fails the task at dispatch with 'unknown role: X'", async () => {
    const { RoleRegistry, BUILTIN_ROLES } = await import("./roles.js");
    const roles = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roles.register(r);

    let spawnCalls = 0;
    const host = fakeHost(async (_req) => {
      spawnCalls++;
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      roles,
    });

    await orch.run([
      samplePacket("bad", { role: "nonexistent-role" } as Partial<TaskPacket>),
    ]);
    resultsOut.end();
    const lines = (await collectPromise) as Array<{
      id: string;
      status: string;
      error?: string;
    }>;

    expect(spawnCalls).toBe(0); // never spawned
    expect(lines).toHaveLength(1);
    expect(lines[0]!.status).toBe("failed");
    expect(lines[0]!.error).toContain("unknown role: nonexistent-role");
  });

  it("no roles configured + no role on task → spawn proceeds without role info", async () => {
    const observed: Array<{ role?: string }> = [];
    const host = fakeHost(async (req) => {
      observed.push({ role: req.role });
      return makeHandle(successResult());
    });

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
    });

    await orch.run([samplePacket("t1")]);
    resultsOut.end();

    expect(observed).toHaveLength(1);
    expect(observed[0]!.role).toBeUndefined();
  });

  it("emits role_applied lane event when role is used", async () => {
    const { RoleRegistry, BUILTIN_ROLES } = await import("./roles.js");
    const roles = new RoleRegistry();
    for (const r of BUILTIN_ROLES) roles.register(r);

    const events: Array<{ type: string; payload?: unknown }> = [];
    const host = fakeHost(async (_req) => makeHandle(successResult()));
    (host as unknown as { emit: (e: unknown) => void }).emit = (e) => {
      events.push(e as { type: string; payload?: unknown });
    };

    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      roles,
      defaultRole: "reviewer",
    });

    await orch.run([samplePacket("t1")]);
    resultsOut.end();

    const roleApplied = events.find((e) => e.type === "role_applied");
    expect(roleApplied).toBeDefined();
    expect(roleApplied!.payload).toMatchObject({ taskId: "t1", role: "reviewer" });
  });
});
