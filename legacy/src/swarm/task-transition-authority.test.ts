/**
 * FX-CLAIM-002 — a task transition is authorized against who asked for it
 * (docs/67 `WP-06`).
 *
 * The orchestrator knows which worker a request arrived from: the transport is
 * per-child, and `handleWorkerRequest` is handed that identity. Some handlers
 * use it — `task.create` derives the caller's scope from it rather than
 * believing a scope in the params — and the transition handlers did not, taking
 * the task id, the claiming agent, and the target scope from the request body
 * instead. A worker could therefore finish a task belonging to another agent,
 * claim work in another team's scope, or claim on behalf of an agent that is
 * not itself.
 *
 * These tests drive the real IPC surface rather than the `TaskAPI` methods,
 * because the methods are exactly what a compromised worker does not have to
 * go through. What it has is a socket.
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
import type { AgentId } from "../core/types.js";

function packet(prompt: string): TaskPacket {
  return {
    id: "task-" + Math.random().toString(36).slice(2),
    prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };
}

function fakeChild(parentToWorker: PassThrough, workerToParent: PassThrough): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout: workerToParent,
    stdin: parentToWorker,
    stderr: null,
    pid: 90000 + Math.floor(Math.random() * 1000),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      setImmediate(() => emitter.emit("close", null, "SIGTERM"));
    }),
  }) as unknown as ChildProcess;
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** One simulated worker: its streams, and the agent id the host assigned it. */
interface Worker {
  readonly agentId: AgentId;
  readonly toHost: PassThrough;
  readonly fromHost: PassThrough;
}

/**
 * A host with `count` workers attached, each of which has reported ready and
 * returned a result — so their tasks exist and their transports are live.
 */
async function hostWithWorkers(count: number): Promise<{
  host: StandaloneHost;
  workers: Worker[];
}> {
  const pending: Worker[] = [];
  const spawnWorker = vi.fn((_args: SpawnWorkerArgs) => {
    const toHost = new PassThrough();
    const fromHost = new PassThrough();
    pending.push({ agentId: "" as AgentId, toHost, fromHost });
    return fakeChild(fromHost, toHost);
  });

  const host = new StandaloneHost({ maxDepth: 5, spawnWorker });
  const workers: Worker[] = [];

  for (let i = 0; i < count; i++) {
    const spawning = host.spawn({
      task: packet(`work ${i}`),
      permissionMode: "workspace-write",
    });
    await tick();
    const slot = pending[i]!;
    slot.toHost.push(
      encodeFrame({ kind: "notification", method: "worker_ready", params: {} }),
    );
    await tick();
    slot.toHost.push(
      encodeFrame({
        kind: "notification",
        method: "task_result",
        params: {
          status: "success",
          output: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          wallClockMs: 1,
        },
      }),
    );
    const handle = await spawning;
    workers.push({ agentId: handle.agentId, toHost: slot.toHost, fromHost: slot.fromHost });
  }

  return { host, workers };
}

/** Send a request as `worker` and return the host's response. */
async function ask(
  worker: Worker,
  method: string,
  params: unknown,
): Promise<IpcResponse | { timedOut: true }> {
  const id = `req-${method}-${Math.random().toString(36).slice(2)}`;
  const response = awaitResponseFor(worker.fromHost, id, 1500);
  worker.toHost.push(encodeFrame({ kind: "request", id, method, params } as IpcFrame));
  return response;
}

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
        if (decoded.frame.kind === "response" && decoded.frame.id === requestId) {
          clearTimeout(timer);
          stream.removeListener("data", onData);
          resolve(decoded.frame);
          return;
        }
      }
    };
    stream.on("data", onData);
  });
}

const refused = (r: IpcResponse | { timedOut: true }): boolean =>
  !("timedOut" in r) && r.kind === "response" && r.ok === false;

describe("a worker reporting a transition on someone else's task", () => {
  it("FX-CLAIM-002a cannot finish a task it does not own", async () => {
    const { host, workers } = await hostWithWorkers(2);
    const [alice, bob] = workers as [Worker, Worker];

    const tasks = await host.task.list();
    const aliceTask = tasks.find((t) => t.owner === alice.agentId);
    expect(aliceTask).toBeDefined();

    const response = await ask(bob, "task.update", {
      taskId: aliceTask!.id,
      patch: { status: "succeeded", output: "forged by bob" },
    });

    expect(refused(response)).toBe(true);
    const after = await host.task.get(aliceTask!.id);
    expect(after?.output).not.toBe("forged by bob");
  });

  it("FX-CLAIM-002b can still report its own", async () => {
    // The refusal has to be about ownership, not about workers being unable to
    // report at all — otherwise the fix breaks every honest transition.
    const { host, workers } = await hostWithWorkers(1);
    const [alice] = workers as [Worker];

    const tasks = await host.task.list();
    const own = tasks.find((t) => t.owner === alice.agentId)!;

    const response = await ask(alice, "task.update", {
      taskId: own.id,
      patch: { status: "succeeded", output: "honest work" },
    });

    expect(refused(response)).toBe(false);
    expect((await host.task.get(own.id))?.output).toBe("honest work");
  });

  it("FX-CLAIM-002c cannot reassign a task to another agent", async () => {
    // Rewriting `owner` is the same forgery wearing a different hat: it makes
    // the next honest ownership check agree with the attacker.
    const { host, workers } = await hostWithWorkers(2);
    const [alice, bob] = workers as [Worker, Worker];

    const tasks = await host.task.list();
    const own = tasks.find((t) => t.owner === bob.agentId)!;

    const response = await ask(bob, "task.update", {
      taskId: own.id,
      patch: { owner: alice.agentId },
    });

    expect(refused(response)).toBe(true);
    expect((await host.task.get(own.id))?.owner).toBe(bob.agentId);
  });
});

describe("a worker claiming work", () => {
  it("FX-CLAIM-002d cannot claim on behalf of another agent", async () => {
    const { host, workers } = await hostWithWorkers(2);
    const [alice, bob] = workers as [Worker, Worker];

    const created = await host.task.create(packet("unclaimed"));

    await ask(bob, "task.pull_next", {
      scope: (await host.task.get(created.id))!.scope,
      claimerId: alice.agentId,
    });

    const after = await host.task.get(created.id);
    // Either the claim is refused, or it belongs to whoever actually asked.
    // What must not happen is work attributed to an agent that never asked:
    // every later ownership check then believes the lie.
    if (after?.owner !== undefined) {
      expect(after.owner).toBe(bob.agentId);
    }
  });

  it("FX-CLAIM-002e claims in its own scope, not the one it asked for", async () => {
    // A worker naming its own team is indistinguishable from one naming
    // somebody else's, so the scope cannot come from the request either. The
    // observable form of that: a request carrying a foreign scope still claims
    // the caller's own work, because the named scope was never consulted.
    const { host, workers } = await hostWithWorkers(1);
    const [alice] = workers as [Worker];

    const created = await host.task.create(packet("unclaimed, in alice's scope"));

    await ask(alice, "task.pull_next", {
      scope: "swarm:some-other-team",
      claimerId: alice.agentId,
    });

    expect((await host.task.get(created.id))?.owner).toBe(alice.agentId);
  });
});
