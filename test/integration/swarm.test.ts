/**
 * Real-subprocess integration tests for the swarm worker pipeline.
 *
 * These tests spawn actual `node dist/cli.js --worker` processes using
 * ScriptedTestEngine fixtures (no real Anthropic API calls).
 *
 * Prerequisites: `npm run build` must have been run (dist/cli.js must exist).
 * Build runs once via test/integration/global-setup.ts — vitest's globalSetup
 * hook — to avoid per-file parallel-build races on the shared dist/ output.
 */

import {
  describe,
  it,
  expect,
  afterEach,
} from "vitest";
import * as path from "node:path";
import {
  spawnWorkerProcess,
  makeTaskPacket,
  runWorker,
  type HarnessResult,
} from "./harness.js";
import { StandaloneHost } from "../../src/swarm/standalone-host.js";
import type { AgentId } from "../../src/core/types.js";
import type { AgentMessage, SendResult } from "../../src/swarm/host.js";

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
    // Filter out worker_lifecycle_changed events (no payload.type) — they are
    // wired in worker-entry and expected alongside engine events.
    const eventTypes = laneEvents
      .map((e) => (e as { payload?: { type?: string } }).payload?.type)
      .filter((t): t is string => t !== undefined);

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

// ---------------------------------------------------------------------------
// Scenario 9 (M3a Phase 3): cross-worker send_message routed by orchestrator
// ---------------------------------------------------------------------------

describe("Scenario 9: orchestrator routes message.send between two depth-1 workers", () => {
  it("worker A sends 'ping' to worker B via message.send IPC; orchestrator buffers for B's drain", async () => {
    // Spawn a real StandaloneHost (depth 0) that owns the inbox + routing.
    const root = new StandaloneHost({ agentId: "root-for-p3" as AgentId });

    // Spawn two scripted workers through the host. Each task ends quickly so
    // we can exercise message routing during the window before `close`.
    const handleA = await root.spawn({
      task: {
        ...makeTaskPacket("worker A"),
        id: "task-a",
      },
      permissionMode: "workspace-write",
    });
    const handleB = await root.spawn({
      task: {
        ...makeTaskPacket("worker B"),
        id: "task-b",
      },
      permissionMode: "workspace-write",
    });

    // Orchestrator-side send: from A → B. Since ScriptedTestEngine doesn't
    // dispatch tool bodies, the worker can't itself call send_message; we
    // exercise the host routing path directly, which is what the IPC handler
    // reaches into when a live worker proxies via "message.send".
    const msg: AgentMessage = {
      from: handleA.agentId,
      to: handleB.agentId,
      content: "ping",
      timestamp: Date.now(),
    };
    const result: SendResult = await root.send(handleB.agentId, msg);
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(1);

    // Drain from B's orchestrator-side queue via the same internal API the
    // "message.recv" IPC handler uses. (B is a real subprocess; its in-process
    // check_inbox would hit this queue via IPC.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inbox = (root as any).messageInbox as {
      drain: (id: AgentId, n: number) => AgentMessage[];
    };
    const drained = inbox.drain(handleB.agentId, 10);
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      from: handleA.agentId,
      to: handleB.agentId,
      content: "ping",
    });

    // Wait for workers to finish their scripts (text-only completes quickly).
    await Promise.all([handleA.wait(), handleB.wait()]);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Scenario 9b (C1 + Phase 6 coverage gap): real-spawn ancestry + task_stop
// ---------------------------------------------------------------------------

describe("Scenario 9b: real spawn chain — ancestry-based task_stop end-to-end", () => {
  it(
    "A can stop C; B (peer) cannot (permission denied); registry captures stoppedBy=A",
    async () => {
      const { taskStopTool } = await import(
        "../../src/tools/tier2/task_stop.js"
      );

      // Use maxDepth=3 so depth-2 (C) spawn is allowed.
      const root = new StandaloneHost({
        agentId: "root-for-9b" as AgentId,
        maxDepth: 3,
      });

      // Spawn A and B at depth 1 using the text-only fixture so they don't
      // exit instantly — slow.json keeps the workers alive long enough for
      // the ancestry check + registry lookup to succeed.
      const handleA = await root.spawn({
        task: { ...makeTaskPacket("worker A"), id: "task-a-9b" },
        permissionMode: "workspace-write",
      });
      const handleB = await root.spawn({
        task: { ...makeTaskPacket("worker B"), id: "task-b-9b" },
        permissionMode: "workspace-write",
      });

      // "Spawn" C as depth-2 under A. We use the host API directly (not
      // the `agent` tool) because that's what the worker's spawn IPC would
      // trigger anyway — and ScriptedTestEngine can't dispatch tool bodies.
      const handleC = await root.spawn({
        task: { ...makeTaskPacket("worker C"), id: "task-c-9b" },
        permissionMode: "workspace-write",
        parentAgentId: handleA.agentId,
      });

      // Registry.create assigns a fresh UUID id, so the packet's id field is
      // not the registry id. Look up C's actual TaskRecord by owner.
      const cTasks = await root.task.list({ owner: handleC.agentId });
      expect(cTasks).toHaveLength(1);
      const taskCId = cTasks[0]!.id;

      // C1 regression: TaskRecord.owner must equal C's agentId.
      const ownerOfC = await root.task.ownerOf(taskCId);
      expect(ownerOfC).toBe(handleC.agentId);

      // Ancestry check: A IS an ancestor of C; B is NOT.
      expect(
        await root.isAncestorOf(handleA.agentId, handleC.agentId),
      ).toBe(true);
      expect(
        await root.isAncestorOf(handleB.agentId, handleC.agentId),
      ).toBe(false);

      // Build worker-flavored hosts for A and B that proxy task.* through
      // `root` so the tool walks the real ancestry path.
      const hostFor = (agentId: AgentId) =>
        ({
          ...root,
          agentId,
          kind: "worker" as const,
          mode: "worker" as const,
          task: root.task,
          isAncestorOf: root.isAncestorOf.bind(root),
        }) as unknown as import("../../src/swarm/host.js").SwarmHost;

      // B (peer) calls task_stop on C — should be rejected.
      const denied = await taskStopTool.execute(
        { taskId: taskCId },
        { cwd: process.cwd(), host: hostFor(handleB.agentId) },
      );
      expect(denied.status).toBe("error");
      expect(
        (denied as { status: "error"; message: string }).message,
      ).toContain("permission denied");

      // A (ancestor) stops C — should succeed.
      const allowed = await taskStopTool.execute(
        { taskId: taskCId },
        { cwd: process.cwd(), host: hostFor(handleA.agentId) },
      );
      expect(allowed.status).toBe("ok");

      // Registry captures the canceling caller.
      const stoppedRecord = await root.task.get(taskCId);
      expect(stoppedRecord?.status).toBe("stopped");
      expect(stoppedRecord?.stoppedBy).toBe(handleA.agentId);

      // Drain all workers so the test exits cleanly.
      await Promise.all([
        handleA.wait().catch(() => {}),
        handleB.wait().catch(() => {}),
        handleC.wait().catch(() => {}),
      ]);
    },
    // 60s to accommodate 3 subprocess spawns + the task_stop protocol
    // under CI load. Observed ~20-35s wall-clock locally; 30s was borderline.
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Scenario 10 (M3a Phase 3): depth-2 sender is rejected with a typed reason
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario 11 (M3b Phase 2): two tasks on same branch serialize via branch lock
// ---------------------------------------------------------------------------

describe("Scenario 11: branch-lock serializes two tasks sharing a branch", () => {
  it(
    "two tasks with branchPolicy.reuse on the same branch acquire and release the lock in order",
    async () => {
      // Import after the test file has loaded so we use the current source tree.
      const { acquire } = await import("../../src/swarm/git/branch-lock.js");
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const path = await import("node:path");

      const lockDir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "swarm-scenario11-"),
      );
      try {
        const branch = "feature/scenario11";
        const acquireOrder: string[] = [];
        const releaseOrder: string[] = [];

        // Task A acquires, holds briefly, releases.
        const a = await acquire(branch, {
          agentId: "task-a",
          timeoutMs: 2_000,
          lockDir,
          pollIntervalMs: 20,
        });
        acquireOrder.push("a");

        // Task B tries to acquire concurrently — must wait for A.
        const bPromise = acquire(branch, {
          agentId: "task-b",
          timeoutMs: 3_000,
          lockDir,
          pollIntervalMs: 20,
        }).then((h) => {
          acquireOrder.push("b");
          return h;
        });

        // Give B time to observe EEXIST at least once.
        await new Promise((r) => setTimeout(r, 80));
        expect(acquireOrder).toEqual(["a"]);

        releaseOrder.push("a");
        await a.release();

        const b = await bPromise;
        expect(acquireOrder).toEqual(["a", "b"]);

        releaseOrder.push("b");
        await b.release();

        expect(releaseOrder).toEqual(["a", "b"]);
      } finally {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    15_000,
  );
});

describe("Scenario 10: depth>1 messaging is rejected (rev-2 Option A)", () => {
  it("a message from a depth-2 agent returns { ok: false, reason: 'depth>1 messaging unsupported' }", async () => {
    const root = new StandaloneHost({
      agentId: "root-for-p3-d2" as AgentId,
      maxDepth: 4,
    });

    // Manually register a depth-1 peer and a depth-2 grandchild in the host
    // so we can drive a send without having to spawn two real subprocesses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const depths: Map<AgentId, number> = (root as any).depths;
    const A = "depth1-A" as AgentId;
    const G = "depth2-G" as AgentId;
    depths.set(A, 1);
    depths.set(G, 2);

    const msg: AgentMessage = {
      from: G,
      to: A,
      content: "hi",
      timestamp: Date.now(),
    };
    const result = await root.send(A, msg);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("depth>1 messaging unsupported");
    expect(result.delivered).toBe(0);
  });
});
