/**
 * task_output sub-agent IPC — v0.4 stage 4I (Defect 1).
 *
 * Pre-fix, a worker-side `task_output` call routed through
 * `WorkerHost.task.get` → IPC `task.get` request, which
 * `StandaloneHost.handleWorkerRequest` did not handle, returning
 * UNKNOWN_METHOD. Stage 4I adds the `task.get` handler so the IPC round-trip
 * resolves and the tool returns the task's accumulated output.
 *
 * Approach mirrors the Layer A pattern in
 * test/integration/framework-mode-peer-parity.test.ts: bypass the engine,
 * dispatch the tool against a real WorkerHost wired to a real StandaloneHost
 * via in-memory PassThrough streams.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "../../swarm/standalone-host.js";
import { WorkerHost } from "../../swarm/worker-host.js";
import { ParentTransport } from "../../swarm/ipc/parent-transport.js";
import { ToolDispatcher } from "../dispatcher.js";
import { buildTier2Tools } from "./index.js";
import { encodeFrame } from "../../swarm/ipc/framing.js";
import type { TaskPacket } from "../../swarm/host.js";
import type { PermissionMode } from "../../core/types.js";
import type { SpawnWorkerArgs } from "../../swarm/subprocess-spawner.js";
import type { ToolExecutionContext, ToolImpl } from "../types.js";

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
      emitter.emit("close", null, null);
    }),
  }) as unknown as ChildProcess;
}

const baseCtx: ToolExecutionContext = { cwd: process.cwd() };

describe("task_output via worker-side host.task.get IPC (v0.4 stage 4I Defect 1)", () => {
  it("returns the task's accumulated output via task.get IPC round-trip", async () => {
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

    // Append output to the registry on the orchestrator side.
    orch.task.appendOutput(taskId, "chunk-from-orchestrator");

    // Build the worker-side WorkerHost and tool dispatcher.
    const workerTransport = new ParentTransport({
      stdin: parentToWorker,
      stdout: workerToParent,
      agentId: handle.agentId,
      heartbeatIntervalMs: 60_000,
    });
    const workerHost = new WorkerHost(
      handle.agentId,
      1,
      "workspace-write" as PermissionMode,
      workerTransport,
    );

    const dispatcher = new ToolDispatcher();
    for (const t of buildTier2Tools()) {
      const wrapped: ToolImpl = {
        ...t,
        execute: async (input: unknown, ctx: ToolExecutionContext) =>
          t.execute(input, { ...ctx, host: workerHost }),
      };
      dispatcher.register(wrapped);
    }

    const result = await dispatcher.dispatch(
      "task_output",
      { taskId },
      baseCtx,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.output) as {
        status: string;
        partialOutput?: string;
        output?: string;
      };
      // task may be running or terminal; either way the appended chunk
      // should appear in the surfaced output.
      const text = parsed.partialOutput ?? parsed.output ?? "";
      expect(text).toContain("chunk-from-orchestrator");
    }

    try {
      workerTransport.close();
    } catch {
      /* ignore */
    }
  });

  it("returns error when sub-agent queries an unknown taskId via IPC", async () => {
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

    const workerTransport = new ParentTransport({
      stdin: parentToWorker,
      stdout: workerToParent,
      agentId: handle.agentId,
      heartbeatIntervalMs: 60_000,
    });
    const workerHost = new WorkerHost(
      handle.agentId,
      1,
      "workspace-write" as PermissionMode,
      workerTransport,
    );

    const dispatcher = new ToolDispatcher();
    for (const t of buildTier2Tools()) {
      const wrapped: ToolImpl = {
        ...t,
        execute: async (input: unknown, ctx: ToolExecutionContext) =>
          t.execute(input, { ...ctx, host: workerHost }),
      };
      dispatcher.register(wrapped);
    }

    const result = await dispatcher.dispatch(
      "task_output",
      { taskId: "nonexistent-task-id" },
      baseCtx,
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toMatch(/unknown taskId/);
    }

    try {
      workerTransport.close();
    } catch {
      /* ignore */
    }
  });
});
