/**
 * task.stop self-stop transport race — v0.4 stage 4I (Defect 3).
 *
 * Pre-fix: when a worker called `task_stop` on its OWN task, the orchestrator
 * called `handle.kill()` synchronously which closed the worker's transport
 * BEFORE the IPC response could be written — `WorkerTransport.writeFrame`
 * short-circuits when `closed === true`, so the response was dropped and the
 * worker hung waiting for it.
 *
 * Stage 4I flips the order: the orchestrator's `task.stop` IPC handler now
 * responds FIRST, then awaits `this.task.stop`. The worker receives its ack
 * before its transport tears down.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "./standalone-host.js";
import { encodeFrame, decodeFrame, LineSplitter } from "./ipc/framing.js";
import type { TaskPacket } from "./host.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";
import type { IpcFrame, IpcResponse } from "./ipc/protocol.js";

function samplePacket(): TaskPacket {
  return {
    id: "task-" + Math.random().toString(36).slice(2),
    prompt: "do something",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };
}

function fakeChildProcess(
  parentToWorker: PassThrough,
  workerToParent: PassThrough,
): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout: workerToParent,
    stdin: parentToWorker,
    stderr: null,
    pid: 99999,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((_signal?: string) => {
      // Simulate the kernel-delivered SIGTERM closing the child: emit close
      // on next tick so the orchestrator's transport sees it.
      setImmediate(() => emitter.emit("close", null, "SIGTERM"));
    }),
  }) as unknown as ChildProcess;
}

/**
 * Drain `parentToWorker` (orchestrator → worker) and resolve with the first
 * IPC response that has the matching correlation id. Times out after `ms`.
 */
async function awaitResponseFor(
  stream: PassThrough,
  requestId: string,
  ms: number,
): Promise<IpcResponse | { timedOut: true }> {
  const splitter = new LineSplitter();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stream.removeListener("data", onData);
      resolve({ timedOut: true });
    }, ms);

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let lines: string[];
      try {
        lines = splitter.push(text);
      } catch {
        return;
      }
      for (const line of lines) {
        const decoded = decodeFrame(line);
        if (!decoded.ok) continue;
        const frame: IpcFrame = decoded.frame;
        if (frame.kind === "response" && frame.id === requestId) {
          clearTimeout(timer);
          stream.removeListener("data", onData);
          resolve(frame);
          return;
        }
      }
    };

    stream.on("data", onData);
  });
}

describe("task.stop self-stop IPC response (v0.4 stage 4I Defect 3)", () => {
  it("orchestrator responds to task.stop BEFORE killing the calling worker (no hang)", async () => {
    const parentToWorker = new PassThrough();
    const workerToParent = new PassThrough();
    const child = fakeChildProcess(parentToWorker, workerToParent);
    const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);

    const orch = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    const spawnPromise = orch.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
    });

    await new Promise((r) => setImmediate(r));
    workerToParent.push(
      encodeFrame({
        kind: "notification",
        method: "worker_ready",
        params: {},
      }),
    );
    await new Promise((r) => setImmediate(r));
    workerToParent.push(
      encodeFrame({
        kind: "notification",
        method: "task_result",
        params: {
          status: "success",
          output: "done",
          usage: { inputTokens: 1, outputTokens: 2 },
          wallClockMs: 10,
        },
      }),
    );

    const handle = await spawnPromise;
    const tasks = await orch.task.list();
    const taskId = tasks[tasks.length - 1]!.id;

    // Begin watching the orchestrator → worker stream BEFORE we send the
    // request — the response can arrive synchronously.
    const requestId = "req-self-stop-1";
    const responsePromise = awaitResponseFor(parentToWorker, requestId, 1500);

    // Send a task.stop request from the worker for its OWN task.
    workerToParent.push(
      encodeFrame({
        kind: "request",
        id: requestId,
        method: "task.stop",
        params: { taskId, by: handle.agentId },
      }),
    );

    const response = await responsePromise;
    expect("timedOut" in response).toBe(false);
    if (!("timedOut" in response)) {
      expect(response.kind).toBe("response");
      expect(response.id).toBe(requestId);
      expect(response.ok).toBe(true);
    }

    // The kill happens after the response is sent; let async work settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // This fixture reports a successful `task_result` before it stops itself, so
    // the task had already finished by the time the stop arrived. It keeps the
    // outcome it reported: a cancellation that lands after completion cancelled
    // nothing, and recording it as stopped would throw away a real result
    // (docs/67 WP-06). What this test is about is the ordering above — the
    // response reaching the worker before its transport tears down.
    const updated = await orch.task.get(taskId);
    expect(updated?.status).toBe("succeeded");
  });

  it("self-stop response is delivered even though kill() closes the transport", async () => {
    // Variant that asserts the kill sequence ran (handle.kill was invoked).
    // Without the fix, the test would time out; with the fix the response
    // arrives first and the kill follows.
    const parentToWorker = new PassThrough();
    const workerToParent = new PassThrough();
    const child = fakeChildProcess(parentToWorker, workerToParent);
    const killSpy = (child.kill as unknown) as ReturnType<typeof vi.fn>;
    const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);

    const orch = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

    const spawnPromise = orch.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
    });

    await new Promise((r) => setImmediate(r));
    workerToParent.push(
      encodeFrame({
        kind: "notification",
        method: "worker_ready",
        params: {},
      }),
    );
    await new Promise((r) => setImmediate(r));
    workerToParent.push(
      encodeFrame({
        kind: "notification",
        method: "task_result",
        params: {
          status: "success",
          output: "done",
          usage: { inputTokens: 1, outputTokens: 2 },
          wallClockMs: 10,
        },
      }),
    );

    const handle = await spawnPromise;
    const tasks = await orch.task.list();
    const taskId = tasks[tasks.length - 1]!.id;

    const requestId = "req-self-stop-2";
    const responsePromise = awaitResponseFor(parentToWorker, requestId, 1500);

    workerToParent.push(
      encodeFrame({
        kind: "request",
        id: requestId,
        method: "task.stop",
        params: { taskId, by: handle.agentId },
      }),
    );

    const response = await responsePromise;
    expect("timedOut" in response).toBe(false);

    // Allow the post-respond kill to drain.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(killSpy).toHaveBeenCalled();
  });
});
