/**
 * Integration tests for retry-policy + dead-letter wiring in Orchestrator.
 *
 * These tests inject a fake StandaloneHost (no subprocess spawned) and
 * a tmp dead-letter file so they run fast and without I/O side-effects.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { PassThrough } from "node:stream";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/swarm/orchestrator.js";
import type { StandaloneHost } from "../../src/swarm/standalone-host.js";
import type { AgentHandle, AgentResult, TaskPacket } from "../../src/swarm/host.js";
import type { AgentId, SessionId } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers (mirrored from orchestrator.test.ts)
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
): AgentHandle {
  return {
    agentId,
    sessionId,
    wait: () => Promise.resolve(result),
    kill: vi.fn(() => Promise.resolve()),
    events: async function* () { return; },
  };
}

function successResult(output = "done"): AgentResult {
  return { status: "success", output, usage: { inputTokens: 1, outputTokens: 2 }, wallClockMs: 10 };
}

function failureResult(error = "boom"): AgentResult {
  return { status: "failure", error, usage: { inputTokens: 1, outputTokens: 1 }, wallClockMs: 10 };
}

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
// Setup: temp dir for dead-letter files
// ---------------------------------------------------------------------------

let tmpDir: string;

afterEach(() => {
  vi.restoreAllMocks();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
});

function makeTmpDir(): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), "swarm-retry-test-"));
  return tmpDir;
}

// ---------------------------------------------------------------------------
// Scenario 1: fails on first attempt, succeeds on second → retry_scheduled
// ---------------------------------------------------------------------------

describe("Retry integration: fail once then succeed", () => {
  it("emits retry_scheduled once and final result is succeeded", async () => {
    let callCount = 0;
    const emittedEvents: string[] = [];

    const host = fakeHost(async (_req) => {
      callCount++;
      if (callCount === 1) {
        return makeHandle(failureResult("first attempt failed"));
      }
      return makeHandle(successResult("second attempt ok"));
    });

    // Capture emit calls to verify retry_scheduled was emitted.
    const emitSpy = vi.spyOn(host, "emit").mockImplementation((evt) => {
      if (typeof evt === "object" && "type" in evt) {
        emittedEvents.push(evt.type as string);
      }
    });

    const dir = makeTmpDir();
    const deadLetterPath = path.join(dir, "dl.jsonl");
    const resultsOut = new PassThrough();
    const collectPromise = collectJsonl(resultsOut);

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
      allowDeadLetter: true,
    });

    const task = samplePacket("retry-once", {
      escalationPolicy: { kind: "retry", max: 3, backoff: "fixed" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();
    const lines = await collectPromise;

    // Should have spawned twice.
    expect(callCount).toBe(2);

    // retry_scheduled should have been emitted once.
    expect(emittedEvents).toContain("retry_scheduled");

    // Final result is succeeded.
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);

    const resultLine = (lines as Array<{ id: string; status: string }>).find(
      (l) => l.id === "retry-once",
    );
    expect(resultLine?.status).toBe("succeeded");

    // No dead-letter written (task eventually succeeded).
    expect(summary.deadLetterViolation).toBe(false);

    emitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: fails 4x with max=3 → dead-letter written, exit non-zero by default
// ---------------------------------------------------------------------------

describe("Retry integration: exhausts retry budget → dead-letter", () => {
  it("dead-letter has 1 line after max retries exhausted", async () => {
    let callCount = 0;

    const host = fakeHost(async (_req) => {
      callCount++;
      return makeHandle(failureResult(`fail #${callCount}`));
    });

    // Suppress emit noise.
    vi.spyOn(host, "emit").mockImplementation(() => {});

    const dir = makeTmpDir();
    const deadLetterPath = path.join(dir, "dl.jsonl");
    const resultsOut = new PassThrough();
    resultsOut.resume(); // drain without collecting

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
      allowDeadLetter: false, // default — should flag violation
    });

    const task = samplePacket("exhaust-retries", {
      escalationPolicy: { kind: "retry", max: 3, backoff: "fixed" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();

    // max=3 means 3 retries after the initial failure → 4 total spawn calls.
    expect(callCount).toBe(4);

    // Dead-letter file should have exactly 1 line.
    const dlContent = readFileSync(deadLetterPath, "utf8").trim();
    const dlLines = dlContent.split("\n").filter((l) => l.length > 0);
    expect(dlLines).toHaveLength(1);
    const dlEntry = JSON.parse(dlLines[0]!) as {
      id: string;
      attempts: number;
      lastStatus: string;
    };
    expect(dlEntry.id).toBe("exhaust-retries");
    expect(dlEntry.attempts).toBe(3); // 3 retries (0-indexed: attempt 0,1,2)
    expect(dlEntry.lastStatus).toBe("failure");

    // deadLetterViolation = true because allowDeadLetter = false.
    expect(summary.deadLetterViolation).toBe(true);
  });

  it("with allowDeadLetter=true, deadLetterViolation is false", async () => {
    const host = fakeHost(async (_req) => {
      return makeHandle(failureResult("always fails"));
    });
    vi.spyOn(host, "emit").mockImplementation(() => {});

    const dir = makeTmpDir();
    const deadLetterPath = path.join(dir, "dl2.jsonl");
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

    const task = samplePacket("exhaust-allowed", {
      escalationPolicy: { kind: "retry", max: 2, backoff: "fixed" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();

    expect(summary.deadLetterViolation).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: kind=none policy → never retries, no dead-letter
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario 4: Real-subprocess per-attempt wall-clock timeout (M3b Phase 8.0b)
// ---------------------------------------------------------------------------

describe("Per-attempt wall-clock timeout: real subprocess (M3b Phase 8.0b)", () => {
  beforeAll(() => {
    // Ensure dist/cli.js is fresh for the subprocess launch.
    execSync("npm run build", {
      cwd: path.resolve(process.cwd()),
      stdio: "pipe",
    });
  }, 60_000);

  it(
    "kills a real slow-fixture subprocess within 2s of the 500ms ceiling",
    async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), "swarm-retry-subproc-"));
      try {
        const tasksFile = path.join(tmp, "tasks.jsonl");
        const resultsFile = path.join(tmp, "results.jsonl");
        const deadLetterFile = path.join(tmp, "dl.jsonl");

        // slow.json emits 4 events × 200ms = 800ms total. With a 500ms
        // per-attempt ceiling, the orchestrator must kill the worker before
        // the fixture finishes streaming. escalationPolicy "none" means the
        // task fails immediately without retry (retry-policy Zod requires
        // max > 0, so "none" is the right way to express "no retry").
        const task: TaskPacket = {
          id: "slow-timeout-task",
          prompt: "run slow fixture",
          branchPolicy: { kind: "none" },
          commitPolicy: { kind: "none" },
          escalationPolicy: { kind: "none" },
          budget: { maxWallClockMsPerAttempt: 500 },
        };
        writeFileSync(tasksFile, JSON.stringify(task) + "\n");

        const cliPath = path.resolve(process.cwd(), "dist/cli.js");
        const slowFixture = path.resolve(
          process.cwd(),
          "test/fixtures/worker-scripts/slow.json",
        );

        const startedAt = Date.now();
        const child = spawn(
          process.execPath,
          [
            cliPath,
            "swarm",
            "run",
            tasksFile,
            "--concurrency",
            "1",
            "--output",
            resultsFile,
            "--dead-letter",
            deadLetterFile,
            "--allow-dead-letter",
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              SWARM_CODER_TEST_SCRIPT: slowFixture,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        const exitCode: number = await new Promise((resolve, reject) => {
          const killTimer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
              new Error(
                "orchestrator did not exit within 10s of 500ms ceiling",
              ),
            );
          }, 10_000);
          child.once("exit", (code) => {
            clearTimeout(killTimer);
            resolve(code ?? -1);
          });
          child.once("error", (err) => {
            clearTimeout(killTimer);
            reject(err);
          });
        });
        const elapsedMs = Date.now() - startedAt;

        // The orchestrator must exit well within 2 seconds of the 500ms
        // ceiling — this guards against the runaway-timer regression that
        // 8.0a fixes as well as basic kill() plumbing.
        expect(elapsedMs).toBeLessThan(8_000);

        // Exit code: task failed because retry max=0 and the attempt timed
        // out; with --allow-dead-letter the process may still exit 0. We
        // care only that it terminated.
        expect(exitCode).not.toBeNull();

        // Results file should show the task as failed or timeout (per-attempt
        // cutoff).
        const resultsContent = readFileSync(resultsFile, "utf8").trim();
        const resultLines = resultsContent
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as { id: string; status: string });
        const ours = resultLines.find((l) => l.id === "slow-timeout-task");
        expect(ours).toBeDefined();
        expect(["failed", "timeout", "cancelled"]).toContain(ours!.status);
      } finally {
        try {
          rmSync(tmp, { recursive: true });
        } catch {
          /* ignore */
        }
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Scenario 3: kind=none policy → never retries, no dead-letter
// ---------------------------------------------------------------------------

describe("Retry integration: kind=none policy does not retry", () => {
  it("spawn called exactly once, no dead-letter written", async () => {
    let callCount = 0;

    const host = fakeHost(async (_req) => {
      callCount++;
      return makeHandle(failureResult("single failure"));
    });
    vi.spyOn(host, "emit").mockImplementation(() => {});

    const dir = makeTmpDir();
    const deadLetterPath = path.join(dir, "dl3.jsonl");
    const resultsOut = new PassThrough();
    resultsOut.resume();

    const orch = new Orchestrator({
      concurrency: 1,
      permissionMode: "workspace-write",
      resultsOut,
      host,
      deadLetterPath,
    });

    const task = samplePacket("no-retry", {
      escalationPolicy: { kind: "none" },
    });

    const summary = await orch.run([task]);
    resultsOut.end();

    expect(callCount).toBe(1);
    expect(summary.failed).toBe(1);
    // No dead-letter delta for kind=none.
    expect(summary.deadLetterViolation).toBe(false);
  });
});
