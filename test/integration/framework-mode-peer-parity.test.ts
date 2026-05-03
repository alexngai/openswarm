/**
 * framework-mode peer-parity — Tier 2 SwarmHost-routed tools dispatch
 * correctly through the framework's tool surface (claude-agent-sdk-style
 * wiring), without the v0.4-pre-stage-4G strip.
 *
 * Background: prior to v0.4 stage 4G, `filterToolsForFramework` stripped
 * 5 SwarmHost-routed tools (send_message, check_inbox, task_stop,
 * task_output, ask_user_question) from the model's tool surface in
 * framework modes. The Track A spike (docs/26 §Track A,
 * docs/26b-spike-track-b-codex-protocol.md) showed empirically that the
 * tools dispatch fine — canUseTool routes the framework's call back to
 * swarm-harness. This file ports the spike's verifications into the main
 * suite as a regression baseline now that the strip is gone.
 *
 * Approach (Layer A from the spike): bypass the engine entirely. Build a
 * ToolDispatcher with all Tier 2 tools, connect a real StandaloneHost to a
 * fake worker via WorkerTransport / ParentTransport. Call dispatcher with a
 * ToolExecutionContext carrying a WorkerHost. Confirm the tool's execute()
 * reaches StandaloneHost via IPC and returns the expected ToolResult.
 */

import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StandaloneHost } from "../../src/swarm/standalone-host.js";
import { WorkerHost } from "../../src/swarm/worker-host.js";
import { ParentTransport } from "../../src/swarm/ipc/parent-transport.js";
import { ToolDispatcher } from "../../src/tools/dispatcher.js";
import { buildTier2Tools } from "../../src/tools/tier2/index.js";
import { encodeFrame } from "../../src/swarm/ipc/framing.js";
import type { TaskPacket } from "../../src/swarm/host.js";
import type { AgentId, PermissionMode } from "../../src/core/types.js";
import type { SpawnWorkerArgs } from "../../src/swarm/subprocess-spawner.js";
import type { ToolExecutionContext, ToolImpl } from "../../src/tools/types.js";

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
 * Build a fake ChildProcess whose stdin/stdout are the supplied PassThroughs.
 * StandaloneHost's WorkerTransport reads from `child.stdout` and writes to
 * `child.stdin`, which is exactly the worker's stdin/stdout pair from the
 * worker's point of view.
 */
function fakeChildProcess(
  parentToWorker: PassThrough,
  workerToParent: PassThrough,
): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    // From orchestrator's view: read from worker's stdout = workerToParent
    stdout: workerToParent,
    // Write to worker's stdin = parentToWorker
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

/**
 * Per-test helper: build a fresh StandaloneHost paired with a WorkerHost
 * representing one spawned worker. The WorkerHost is the ctx.host that
 * Tier 2 tools see; the StandaloneHost sits at the orchestrator side and
 * answers IPC requests.
 */
async function makeOrchestratorAndWorker(): Promise<{
  orch: StandaloneHost;
  workerHost: WorkerHost;
  workerAgentId: AgentId;
  taskId: string;
  cleanup: () => void;
}> {
  const parentToWorker = new PassThrough();
  const workerToParent = new PassThrough();
  const child = fakeChildProcess(parentToWorker, workerToParent);
  const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);

  const orch = new StandaloneHost({ maxDepth: 3, spawnWorker: spawnFn });

  const spawnPromise = orch.spawn({
    task: samplePacket(),
    permissionMode: "workspace-write",
  });

  // Allow StandaloneHost to register listeners on the fake child.
  await new Promise((r) => setImmediate(r));

  // worker_ready notification (worker → orch).
  workerToParent.push(
    encodeFrame({ kind: "notification", method: "worker_ready", params: {} }),
  );

  await new Promise((r) => setImmediate(r));

  // task_result so spawn() resolves.
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
  const workerAgentId = handle.agentId;
  const tasks = await orch.task.list();
  const taskId = tasks[tasks.length - 1]!.id;

  // Build a WorkerHost on the worker side. Its ParentTransport reads from
  // `parentToWorker` (orch → worker) and writes to `workerToParent`
  // (worker → orch).
  const workerTransport = new ParentTransport({
    stdin: parentToWorker as unknown as NodeJS.ReadableStream,
    stdout: workerToParent as unknown as NodeJS.WritableStream,
    agentId: workerAgentId,
    heartbeatIntervalMs: 60_000,
  });
  const workerHost = new WorkerHost(
    workerAgentId,
    1,
    "workspace-write" as PermissionMode,
    workerTransport,
  );

  return {
    orch,
    workerHost,
    workerAgentId,
    taskId,
    cleanup: () => {
      try {
        workerTransport.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Build a ToolDispatcher with all Tier 2 tools registered. Wraps each
 * tool's `execute` to inject `host` into ctx — mirroring the wiring in
 * `src/cli/worker-entry.ts`.
 */
function buildDispatcherWithHost(host: WorkerHost): ToolDispatcher {
  const dispatcher = new ToolDispatcher();
  for (const t of buildTier2Tools()) {
    const wrapped: ToolImpl = {
      ...t,
      execute: async (input: unknown, ctx: ToolExecutionContext) =>
        t.execute(input, { ...ctx, host }),
    };
    dispatcher.register(wrapped);
  }
  return dispatcher;
}

const baseCtx: ToolExecutionContext = { cwd: process.cwd() };

// ---------------------------------------------------------------------------
// Layer A — pure tool dispatch through the SwarmHost layer.
// ---------------------------------------------------------------------------

describe("framework-mode peer parity (Layer A: pure tool dispatch via worker host)", () => {
  describe("send_message", () => {
    it("dispatches to a known recipient and produces a SendResult; orchestrator records message_sent lane event", async () => {
      const { orch, workerHost, workerAgentId, cleanup } =
        await makeOrchestratorAndWorker();

      const dispatcher = buildDispatcherWithHost(workerHost);

      // Capture orchestrator-side lane events.
      const events: { type: string; payload: unknown }[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orch as any).events.on("lane_event", (evt: any) => {
        events.push({ type: evt.type, payload: evt.payload });
      });

      const result = await dispatcher.dispatch(
        "send_message",
        { to: workerAgentId, content: "hello self" },
        baseCtx,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const parsed = JSON.parse(result.output) as {
          delivered: number;
          dropped: number;
          partial: boolean;
        };
        expect(parsed.delivered).toBe(1);
      }

      // Allow IPC roundtrip + lane event flush.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const sent = events.filter((e) => e.type === "message_sent");
      expect(sent.length).toBeGreaterThanOrEqual(1);

      cleanup();
    });

    it("returns an error for an unknown recipient", async () => {
      const { workerHost, cleanup } = await makeOrchestratorAndWorker();
      const dispatcher = buildDispatcherWithHost(workerHost);

      const result = await dispatcher.dispatch(
        "send_message",
        { to: "ghost-agent", content: "anyone there?" },
        baseCtx,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/unknown_recipient|send_message failed/);
      }
      cleanup();
    });
  });

  describe("check_inbox", () => {
    it("returns [] initially, then drains a previously-sent message", async () => {
      const { workerHost, workerAgentId, cleanup } =
        await makeOrchestratorAndWorker();
      const dispatcher = buildDispatcherWithHost(workerHost);

      // 1. Initially, no messages.
      const empty = await dispatcher.dispatch("check_inbox", { max: 10 }, baseCtx);
      expect(empty.status).toBe("ok");
      if (empty.status === "ok") {
        expect(JSON.parse(empty.output)).toEqual([]);
      }

      // 2. Send a message to ourselves so something lands in the inbox.
      const sendResult = await dispatcher.dispatch(
        "send_message",
        { to: workerAgentId, content: "for me" },
        baseCtx,
      );
      expect(sendResult.status).toBe("ok");

      // Allow inbox_delivery sub_agent_event to propagate.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // 3. Drain.
      const drained = await dispatcher.dispatch(
        "check_inbox",
        { max: 10 },
        baseCtx,
      );
      expect(drained.status).toBe("ok");
      if (drained.status === "ok") {
        const messages = JSON.parse(drained.output) as Array<{
          from: string;
          to: string;
          content: string;
        }>;
        expect(messages.length).toBeGreaterThanOrEqual(1);
        expect(messages[0]!.content).toBe("for me");
      }

      cleanup();
    });
  });

  describe("task_stop", () => {
    it("peer-stop: worker A stops worker B's task (with SWARM_HARNESS_ALLOW_PEER_TASK_STOP=1)", async () => {
      // To exercise peer-stop without triggering the self-stop response-drop
      // race (kill() synchronously closes the calling worker's transport,
      // dropping its own response), we spawn TWO workers and have worker A
      // stop worker B's task.
      const parentToWorkerA = new PassThrough();
      const workerToParentA = new PassThrough();
      const childA = fakeChildProcess(parentToWorkerA, workerToParentA);
      const parentToWorkerB = new PassThrough();
      const workerToParentB = new PassThrough();
      const childB = fakeChildProcess(parentToWorkerB, workerToParentB);

      let callIdx = 0;
      const spawnFn = vi.fn((_args: SpawnWorkerArgs) => {
        const c = callIdx++ === 0 ? childA : childB;
        return c;
      });

      const orch = new StandaloneHost({
        maxDepth: 3,
        spawnWorker: spawnFn,
      });

      // Spawn worker A.
      const pA = orch.spawn({
        task: samplePacket(),
        permissionMode: "workspace-write",
      });
      await new Promise((r) => setImmediate(r));
      workerToParentA.push(
        encodeFrame({
          kind: "notification",
          method: "worker_ready",
          params: {},
        }),
      );
      await new Promise((r) => setImmediate(r));
      workerToParentA.push(
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
      const handleA = await pA;

      // Spawn worker B.
      const pB = orch.spawn({
        task: samplePacket(),
        permissionMode: "workspace-write",
      });
      await new Promise((r) => setImmediate(r));
      workerToParentB.push(
        encodeFrame({
          kind: "notification",
          method: "worker_ready",
          params: {},
        }),
      );
      await new Promise((r) => setImmediate(r));
      workerToParentB.push(
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
      const handleB = await pB;
      void handleB;

      // Find B's taskId.
      const allTasks = await orch.task.list();
      const taskBId = allTasks[allTasks.length - 1]!.id;

      // Build worker A's local WorkerHost.
      const workerATransport = new ParentTransport({
        stdin: parentToWorkerA as unknown as NodeJS.ReadableStream,
        stdout: workerToParentA as unknown as NodeJS.WritableStream,
        agentId: handleA.agentId,
        heartbeatIntervalMs: 60_000,
      });
      const workerAHost = new WorkerHost(
        handleA.agentId,
        1,
        "workspace-write" as PermissionMode,
        workerATransport,
      );

      const dispatcher = buildDispatcherWithHost(workerAHost);

      // Capture orchestrator events.
      const events: { type: string; payload: unknown }[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orch as any).events.on("lane_event", (evt: any) => {
        events.push({ type: evt.type, payload: evt.payload });
      });

      // Default ancestry-only mode: worker A is NOT an ancestor of worker B.
      // Expect permission denied.
      const denied = await dispatcher.dispatch(
        "task_stop",
        { taskId: taskBId },
        baseCtx,
      );
      expect(denied.status).toBe("error");
      if (denied.status === "error") {
        expect(denied.message).toMatch(/permission denied/);
      }

      // Now allow peer-stop via env var, retry.
      const orig = process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
      process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP = "1";
      try {
        const ok = await dispatcher.dispatch(
          "task_stop",
          { taskId: taskBId },
          baseCtx,
        );
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(ok.status).toBe("ok");
        const stoppedReq = events.find((e) => e.type === "task_stop_requested");
        expect(stoppedReq).toBeDefined();
      } finally {
        if (orig === undefined) delete process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
        else process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP = orig;
      }

      try {
        workerATransport.close();
      } catch {
        /* ignore */
      }
    });

    it("rejects with permission denied when caller is not an ancestor", async () => {
      const { orch, workerHost, cleanup } = await makeOrchestratorAndWorker();
      const dispatcher = buildDispatcherWithHost(workerHost);

      // Create a task whose owner is some unrelated agent id.
      const stranger = await orch.task.create({
        prompt: "stranger task",
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
      });
      // Set the owner to a synthetic agent the worker has no relation to.
      await orch.task.update(stranger.id, {
        owner: "stranger-agent" as AgentId,
      });

      const result = await dispatcher.dispatch(
        "task_stop",
        { taskId: stranger.id },
        baseCtx,
      );

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.message).toMatch(/permission denied/);
      }
      cleanup();
    });
  });

  describe("task_output", () => {
    // Track A defect (docs/27 §V0.4.D8): task_output is BROKEN for sub-agent
    // workers because StandaloneHost.handleWorkerRequest does not implement
    // a "task.get" IPC method (only task.output / task.stop / task.owner_of).
    // The tool's worker-side implementation calls host.task.get(taskId), which
    // IPC-routes to UNKNOWN_METHOD on the orchestrator. Scheduled for fix in
    // stage 4I along with the dispatcher try/catch and task_stop self-stop
    // race. Until then the worker-side scenario stays skipped.
    it.skip(
      "BROKEN: tool calls host.task.get(...) which IPC-routes to UNKNOWN_METHOD on StandaloneHost (worker side) — fix scheduled stage 4I",
      async () => {
        // Intentionally empty; documents the pending defect.
      },
    );

    it("WORKS when host is the StandaloneHost itself (root-mounted scenario)", async () => {
      // Direct usage: build a fresh StandaloneHost, mount Tier 2 tools with
      // host = StandaloneHost (i.e. root-mounted, the team-orchestration
      // scenario). task.get is wired through the in-process registry.
      const orch = new StandaloneHost({ maxDepth: 3 });

      const dispatcher = new ToolDispatcher();
      for (const t of buildTier2Tools()) {
        const wrapped: ToolImpl = {
          ...t,
          execute: async (input: unknown, ctx: ToolExecutionContext) =>
            t.execute(input, { ...ctx, host: orch }),
        };
        dispatcher.register(wrapped);
      }

      // Create a task and append output via the in-process registry.
      const record = await orch.task.create({
        prompt: "p",
        branchPolicy: { kind: "none" },
        commitPolicy: { kind: "none" },
        escalationPolicy: { kind: "none" },
      });
      orch.task.appendOutput(record.id, "first chunk\n");

      const result = await dispatcher.dispatch(
        "task_output",
        { taskId: record.id },
        baseCtx,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const parsed = JSON.parse(result.output) as {
          status: string;
          partialOutput?: string;
        };
        expect(parsed.partialOutput ?? "").toContain("first chunk");
      }
    });
  });

  describe("ask_user_question", () => {
    it("routes via IPC; orchestrator answers via injected askUser override", async () => {
      const parentToWorker = new PassThrough();
      const workerToParent = new PassThrough();
      const child = fakeChildProcess(parentToWorker, workerToParent);
      const spawnFn = vi.fn((_args: SpawnWorkerArgs) => child);

      // readlineFactory is only consulted when the host's askUser passes its
      // TTY check, which doesn't hold under vitest. We cover the IPC path by
      // monkey-patching askUser on the host directly (see below) — same
      // approach used in the original Track A spike.
      const orch = new StandaloneHost({
        maxDepth: 3,
        spawnWorker: spawnFn,
        readlineFactory: async () => ({
          question: async (_prompt: string) => "the answer",
          close: () => {},
        }),
      });

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
        stdin: parentToWorker as unknown as NodeJS.ReadableStream,
        stdout: workerToParent as unknown as NodeJS.WritableStream,
        agentId: handle.agentId,
        heartbeatIntervalMs: 60_000,
      });
      const workerHost = new WorkerHost(
        handle.agentId,
        1,
        "workspace-write" as PermissionMode,
        workerTransport,
      );
      const dispatcher = buildDispatcherWithHost(workerHost);

      // Patch host.askUser to return a deterministic answered response,
      // bypassing the TTY check that's hard to mock.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orch as any).askUser = async (
        _q: string,
        _opts?: readonly string[],
      ) => {
        return { status: "answered", answer: "the answer" };
      };

      const result = await dispatcher.dispatch(
        "ask_user_question",
        { question: "what now?", options: ["a", "b"] },
        baseCtx,
      );

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        const parsed = JSON.parse(result.output) as {
          status: string;
          answer?: string;
        };
        expect(parsed.status).toBe("answered");
        expect(parsed.answer).toBe("the answer");
      }

      try {
        workerTransport.close();
      } catch {
        /* ignore */
      }
    });
  });
});
