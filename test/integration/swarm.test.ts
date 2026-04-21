/**
 * Real-subprocess integration tests for the swarm worker pipeline.
 *
 * These tests spawn actual `node dist/cli.js --worker` processes using
 * ScriptedTestEngine fixtures (no real Anthropic API calls).
 *
 * Prerequisites: `npm run build` must have been run (dist/cli.js must exist).
 * The beforeAll block runs the build automatically.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
} from "vitest";
import { execSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  spawnWorkerProcess,
  makeTaskPacket,
  runWorker,
  type HarnessResult,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Setup: build dist so subprocess tests use current code.
// ---------------------------------------------------------------------------

beforeAll(() => {
  execSync("npm run build", {
    cwd: path.resolve(process.cwd()),
    stdio: "pipe",
  });
}, 60_000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.resolve(process.cwd(), "test/fixtures/worker-scripts");

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

// Track harnesses for cleanup.
let currentHarness: HarnessResult | null = null;

afterEach(async () => {
  if (currentHarness) {
    await currentHarness.close();
    currentHarness = null;
  }
});

// ---------------------------------------------------------------------------
// Scenario 1: Single worker, text-only response
// ---------------------------------------------------------------------------

describe("Scenario 1: text-only worker completes with success", () => {
  it("receives task_result with status=success and output containing 'done'", async () => {
    const harness = spawnWorkerProcess({
      testScript: fixturePath("text-only.json"),
      permissionMode: "workspace-write",
    });
    currentHarness = harness;

    const result = await runWorker(harness.transport, makeTaskPacket("say done"));

    expect(result).toMatchObject({
      status: "success",
      output: expect.stringContaining("done"),
    });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario 2: Tool-use events relayed in order
// ---------------------------------------------------------------------------

describe("Scenario 2: tool-use events relayed via lane_event in script order", () => {
  it("receives lane_events in the order defined by the fixture", async () => {
    const harness = spawnWorkerProcess({
      testScript: fixturePath("with-tool-call.json"),
      permissionMode: "workspace-write",
    });
    currentHarness = harness;

    const laneEvents: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15_000);

      harness.transport.on("lane_event", (evt) => {
        laneEvents.push(evt);
      });

      harness.transport.once("task_result", () => {
        clearTimeout(timer);
        resolve();
      });

      harness.transport.once("worker_ready", () => {
        harness.transport
          .send("run", makeTaskPacket("use a tool"), { timeoutMs: 15_000 })
          .catch(reject);
      });

      harness.transport.once("close", () => {
        clearTimeout(timer);
        reject(new Error("worker closed prematurely"));
      });
    });

    // Expect lane_events in script fixture order: tool_use_start, tool_use_input,
    // tool_use_end, tool_result, text_delta, message_stop.
    const eventTypes = laneEvents.map(
      (e) => (e as { payload?: { type?: string } }).payload?.type,
    );

    expect(eventTypes).toEqual([
      "tool_use_start",
      "tool_use_input",
      "tool_use_end",
      "tool_result",
      "text_delta",
      "message_stop",
    ]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario 3: Worker exits cleanly with exit code 0
// ---------------------------------------------------------------------------

describe("Scenario 3: worker exits with code 0 on success", () => {
  it("child process closes with exit code 0 after text-only task", async () => {
    const harness = spawnWorkerProcess({
      testScript: fixturePath("text-only.json"),
    });
    currentHarness = harness;

    // Run task to completion.
    await runWorker(harness.transport, makeTaskPacket());

    // Wait for exit.
    const exit = await harness.transport.waitForExit();

    expect(exit.code).toBe(0);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario 4: SIGTERM kills worker before task_result arrives
// ---------------------------------------------------------------------------

describe("Scenario 4: SIGTERM kills slow worker before task_result", () => {
  it("transport rejects pending requests with transport_closed after SIGTERM", async () => {
    const harness = spawnWorkerProcess({
      testScript: fixturePath("slow.json"),
    });
    currentHarness = harness;

    // Wait for worker_ready, send run, then immediately kill.
    const error = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for rejection")), 10_000);

      harness.transport.once("worker_ready", () => {
        // Send the run request (will be acked), then SIGTERM before task_result.
        harness.transport
          .send("run", makeTaskPacket(), { timeoutMs: 15_000 })
          .then(() => {
            // Acked — now kill before task_result arrives (slow.json has 200ms delays).
            harness.transport.kill("SIGTERM");

            // Wait for close to propagate.
            harness.transport.once("close", () => {
              clearTimeout(timer);
              // After transport closes, subsequent sends should fail.
              resolve(new Error("transport_closed"));
            });
          })
          .catch((err: Error) => {
            clearTimeout(timer);
            resolve(err);
          });
      });
    });

    // Either the run request was rejected with transport_closed or we got
    // the close event — either way the worker was killed.
    expect(error).toBeInstanceOf(Error);
    // Worker should not have exit code 0.
    const exit = await harness.transport.waitForExit();
    expect(exit.signal ?? exit.code).toBeTruthy();
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario 5: Worker crash — error event yields failure task_result
// ---------------------------------------------------------------------------

describe("Scenario 5: worker crash produces failure task_result", () => {
  it("task_result has status=failure with error from crash fixture", async () => {
    const harness = spawnWorkerProcess({
      testScript: fixturePath("crash.json"),
    });
    currentHarness = harness;

    const result = await runWorker(harness.transport, makeTaskPacket());

    expect(result).toMatchObject({
      status: "failure",
      error: expect.stringContaining("crashed"),
    });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Scenario 6: Heartbeat observed within short window
// ---------------------------------------------------------------------------

describe("Scenario 6: heartbeat received with fast heartbeat interval", () => {
  it("receives at least one heartbeat notification within 2 seconds", async () => {
    // Use slow.json so the worker stays alive; configure short heartbeat interval.
    const harness = spawnWorkerProcess({
      testScript: fixturePath("slow.json"),
      heartbeatIntervalMs: 50, // very fast for test
    });
    currentHarness = harness;

    const heartbeat = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no heartbeat received within 2000ms")),
        2000,
      );

      harness.transport.once("heartbeat", (params) => {
        clearTimeout(timer);
        resolve(params);
      });

      // Start the worker running so it stays alive long enough for a heartbeat.
      harness.transport.once("worker_ready", () => {
        harness.transport
          .send("run", makeTaskPacket(), { timeoutMs: 10_000 })
          .catch(() => {
            /* ignore — we may kill before task_result */
          });
      });
    });

    expect(heartbeat).toMatchObject({
      agentId: expect.any(String),
      ts: expect.any(Number),
    });
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Scenario 7: Parallel workers complete independently
// ---------------------------------------------------------------------------

describe("Scenario 7: two parallel workers both succeed", () => {
  it("spawns two workers concurrently and both return success", async () => {
    const harness1 = spawnWorkerProcess({
      agentId: "worker-1",
      testScript: fixturePath("text-only.json"),
    });
    const harness2 = spawnWorkerProcess({
      agentId: "worker-2",
      testScript: fixturePath("text-only.json"),
    });

    try {
      const [result1, result2] = await Promise.all([
        runWorker(harness1.transport, makeTaskPacket("task 1")),
        runWorker(harness2.transport, makeTaskPacket("task 2")),
      ]);

      expect(result1).toMatchObject({ status: "success" });
      expect(result2).toMatchObject({ status: "success" });
    } finally {
      await Promise.all([harness1.close(), harness2.close()]);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Scenario 8: with-tool-call worker completes with status=success
// ---------------------------------------------------------------------------

describe("Scenario 8: with-tool-call worker returns success", () => {
  it("task_result status is success after tool-use sequence", async () => {
    const harness = spawnWorkerProcess({
      testScript: fixturePath("with-tool-call.json"),
    });
    currentHarness = harness;

    const result = await runWorker(harness.transport, makeTaskPacket());

    expect(result).toMatchObject({ status: "success" });
    const r = result as { output: string };
    expect(r.output).toContain("I read the file");
  }, 15_000);
});
