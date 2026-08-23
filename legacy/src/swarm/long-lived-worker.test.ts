/**
 * long-lived-worker.test.ts — v0.4 stage 4D acceptance.
 *
 * Verifies that workers spawned with `SpawnRequest.longLived === true`:
 *   1. Accept multiple sequential prompts via `runMore` on a SINGLE subprocess.
 *   2. Drain gracefully via `drain()` (idle path).
 *   3. Throw clear errors when `runMore`/`drain` is called on a non-long-lived
 *      worker.
 *   4. Surface `worker_idle` lane events to the orchestrator after each turn.
 *
 * Mock pattern mirrors `standalone-host.test.ts`: a fake ChildProcess pair
 * exposes the worker stdout/stdin streams so tests inject IPC frames and
 * observe outbound writes.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "./standalone-host.js";
import { TaskRegistry } from "./task-registry.js";
import type { TaskPacket, AgentResult } from "./host.js";
import type { LaneEvent } from "./events.js";
import { encodeFrame, decodeFrame } from "./ipc/framing.js";
import type { SpawnWorkerArgs } from "./subprocess-spawner.js";

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

interface FakePair {
  child: ChildProcess;
  emitFromWorker: (frame: object) => void;
  /**
   * Promises that resolve to the next inbound IPC request the orchestrator
   * sends to "stdin". Each call awaits the next frame.
   */
  nextInbound: () => Promise<{ method: string; id?: string; params: unknown; kind: string }>;
}

function fakeProcPair(): FakePair {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const emitter = new EventEmitter();
  const inboundLines: string[] = [];
  const inboundWaiters: Array<(line: string) => void> = [];

  stdin.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      const waiter = inboundWaiters.shift();
      if (waiter !== undefined) {
        waiter(line);
      } else {
        inboundLines.push(line);
      }
    }
  });

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

  function nextInbound(): Promise<{ method: string; id?: string; params: unknown; kind: string }> {
    return new Promise((resolve, reject) => {
      const consume = (line: string): void => {
        const decoded = decodeFrame(line);
        if (!decoded.ok) {
          reject(new Error(`malformed inbound frame: ${decoded.error}`));
          return;
        }
        const f = decoded.frame as { kind: string; method?: string; id?: string; params?: unknown };
        resolve({
          kind: f.kind,
          method: f.method ?? "",
          ...(f.id !== undefined && { id: f.id }),
          params: f.params,
        });
      };
      const buffered = inboundLines.shift();
      if (buffered !== undefined) {
        consume(buffered);
      } else {
        inboundWaiters.push(consume);
      }
    });
  }

  return { child, emitFromWorker, nextInbound };
}

function makeSpawnOverride(): {
  spawnFn: ((args: SpawnWorkerArgs) => ChildProcess) & { mock: { calls: SpawnWorkerArgs[][] } };
  pair: FakePair;
  args: SpawnWorkerArgs[];
} {
  const pair = fakeProcPair();
  const args: SpawnWorkerArgs[] = [];
  const spawnFn = vi.fn((a: SpawnWorkerArgs) => {
    args.push(a);
    return pair.child;
  }) as unknown as ((args: SpawnWorkerArgs) => ChildProcess) & {
    mock: { calls: SpawnWorkerArgs[][] };
  };
  return { spawnFn, pair, args };
}

function buildResult(output: string, wallClockMs = 5): AgentResult {
  return {
    status: "success",
    output,
    usage: { inputTokens: 1, outputTokens: 2 },
    wallClockMs,
  };
}

describe("long-lived workers (v0.4 stage 4D)", () => {
  it("accepts three sequential prompts via runMore on a single subprocess", async () => {
    const { spawnFn, pair, args } = makeSpawnOverride();
    const registry = new TaskRegistry();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn, registry });

    const spawnPromise = host.spawn({
      task: samplePacket({ prompt: "first" }),
      permissionMode: "workspace-write",
      longLived: true,
    });

    // Drain the initial "run" request the host sends after worker_ready.
    // Worker_ready handshake first.
    await new Promise((r) => setImmediate(r));
    pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });

    // The host sends a "run" request — consume it.
    const runFrame = await pair.nextInbound();
    expect(runFrame.kind).toBe("request");
    expect(runFrame.method).toBe("run");
    pair.emitFromWorker({
      kind: "response",
      id: runFrame.id,
      ok: true,
      result: { accepted: true },
    });

    // First task_result.
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("first-output"),
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "worker_idle",
      params: { agentId: args[0]?.agentId, readyForRunMoreAt: Date.now() },
    });

    const handle = await spawnPromise;
    const firstResult = await handle.wait();
    expect(firstResult.status).toBe("success");
    if (firstResult.status === "success") {
      expect(firstResult.output).toBe("first-output");
    }

    // Verify the spawnFn received longLived=true and only ONE subprocess was started.
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(args[0]?.longLived).toBe(true);

    // Second prompt via runMore.
    const secondPromise = handle.runMore("second prompt");
    const runMoreFrame1 = await pair.nextInbound();
    expect(runMoreFrame1.kind).toBe("request");
    expect(runMoreFrame1.method).toBe("run_more");
    expect((runMoreFrame1.params as { prompt: string }).prompt).toBe("second prompt");
    pair.emitFromWorker({
      kind: "response",
      id: runMoreFrame1.id,
      ok: true,
      result: { accepted: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("second-output"),
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "worker_idle",
      params: { agentId: args[0]?.agentId, readyForRunMoreAt: Date.now() },
    });
    const secondResult = await secondPromise;
    expect(secondResult.status).toBe("success");
    if (secondResult.status === "success") {
      expect(secondResult.output).toBe("second-output");
    }

    // Third prompt via runMore.
    const thirdPromise = handle.runMore("third prompt");
    const runMoreFrame2 = await pair.nextInbound();
    expect(runMoreFrame2.method).toBe("run_more");
    pair.emitFromWorker({
      kind: "response",
      id: runMoreFrame2.id,
      ok: true,
      result: { accepted: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("third-output"),
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "worker_idle",
      params: { agentId: args[0]?.agentId, readyForRunMoreAt: Date.now() },
    });
    const thirdResult = await thirdPromise;
    expect(thirdResult.status).toBe("success");
    if (thirdResult.status === "success") {
      expect(thirdResult.output).toBe("third-output");
    }

    // Critical: still exactly one subprocess (single pid).
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(pair.child.pid).toBe(12345);
  });

  it("drains a long-lived worker after idle (drain on idle path)", async () => {
    const { spawnFn, pair, args } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      longLived: true,
    });

    await new Promise((r) => setImmediate(r));
    pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });

    const runFrame = await pair.nextInbound();
    pair.emitFromWorker({
      kind: "response",
      id: runFrame.id,
      ok: true,
      result: { accepted: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("done"),
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "worker_idle",
      params: { agentId: args[0]?.agentId, readyForRunMoreAt: Date.now() },
    });

    const handle = await spawnPromise;
    await handle.wait();

    // Now drain.
    const drainPromise = handle.drain();
    const drainFrame = await pair.nextInbound();
    expect(drainFrame.kind).toBe("request");
    expect(drainFrame.method).toBe("drain");
    pair.emitFromWorker({
      kind: "response",
      id: drainFrame.id,
      ok: true,
      result: { acknowledged: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "worker_drained",
      params: { agentId: args[0]?.agentId },
    });

    await expect(drainPromise).resolves.toBeUndefined();
  });

  it("runMore on a non-long-lived worker rejects with a clear error", async () => {
    const { spawnFn, pair } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      // longLived omitted — default behaviour.
    });

    await new Promise((r) => setImmediate(r));
    pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });

    const runFrame = await pair.nextInbound();
    pair.emitFromWorker({
      kind: "response",
      id: runFrame.id,
      ok: true,
      result: { accepted: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("done"),
    });

    const handle = await spawnPromise;
    await handle.wait();

    await expect(handle.runMore("more")).rejects.toThrow(/long-lived/);
    await expect(handle.drain()).rejects.toThrow(/long-lived/);
  });

  it("emits a worker_idle lane event after task_result on a long-lived worker", async () => {
    const { spawnFn, pair, args } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    const laneEvents: LaneEvent[] = [];
    (host as unknown as { events: EventEmitter }).events.on(
      "lane_event",
      (e: LaneEvent) => laneEvents.push(e),
    );

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      longLived: true,
    });

    await new Promise((r) => setImmediate(r));
    pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });

    const runFrame = await pair.nextInbound();
    pair.emitFromWorker({
      kind: "response",
      id: runFrame.id,
      ok: true,
      result: { accepted: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("done"),
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "worker_idle",
      params: { agentId: args[0]?.agentId, readyForRunMoreAt: 1234 },
    });

    await spawnPromise;
    // give the notification handler a tick.
    await new Promise((r) => setImmediate(r));

    const idleEvents = laneEvents.filter((e) => e.type === "worker_idle");
    expect(idleEvents.length).toBeGreaterThanOrEqual(1);
    expect((idleEvents[0]!.payload as { readyForRunMoreAt: number }).readyForRunMoreAt).toBe(1234);
  });

  it("propagates idleTimeoutMs to spawnFn args", async () => {
    const { spawnFn, pair, args } = makeSpawnOverride();
    const host = new StandaloneHost({ maxDepth: 5, spawnWorker: spawnFn });

    const spawnPromise = host.spawn({
      task: samplePacket(),
      permissionMode: "workspace-write",
      longLived: true,
      idleTimeoutMs: 100,
    });

    await new Promise((r) => setImmediate(r));
    pair.emitFromWorker({ kind: "notification", method: "worker_ready", params: {} });
    const runFrame = await pair.nextInbound();
    pair.emitFromWorker({
      kind: "response",
      id: runFrame.id,
      ok: true,
      result: { accepted: true },
    });
    pair.emitFromWorker({
      kind: "notification",
      method: "task_result",
      params: buildResult("done"),
    });

    await spawnPromise;
    expect(args[0]?.idleTimeoutMs).toBe(100);
    expect(args[0]?.longLived).toBe(true);
  });
});
