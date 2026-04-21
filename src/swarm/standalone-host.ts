import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  SwarmHost,
  SpawnRequest,
  AgentHandle,
  AgentResult,
  AgentMessage,
  InboxEvent,
  TaskAPI,
  TaskRecord,
  TaskPacket,
  TaskFilter,
} from "./host.js";
import type { AgentId, SessionId } from "../core/types.js";
import type { LaneEvent } from "./events.js";
import { TaskRegistry } from "./task-registry.js";
import { WorkerTransport } from "./ipc/worker-transport.js";
import { spawnWorker } from "./subprocess-spawner.js";
import { resolveMaxDepth } from "./depth-limit.js";

export interface StandaloneHostOptions {
  readonly registry?: TaskRegistry;
  readonly agentId?: AgentId;
  readonly maxDepth?: number;
  /** For tests: override subprocess spawn so no real child is created. */
  readonly spawnWorker?: typeof spawnWorker;
}

export class StandaloneHost implements SwarmHost {
  readonly mode = "standalone" as const;
  readonly agentId: AgentId;
  readonly depth: number = 0; // root is always depth 0

  private readonly registry: TaskRegistry;
  private readonly depths = new Map<AgentId, number>();
  private readonly maxDepth: number;
  private readonly events = new EventEmitter();
  private readonly spawnFn: typeof spawnWorker;

  // Expose the registry via the TaskAPI wrapper.
  readonly task: TaskAPI;

  constructor(opts: StandaloneHostOptions = {}) {
    this.agentId = (opts.agentId ?? (randomUUID() as string)) as AgentId;
    this.registry = opts.registry ?? new TaskRegistry();
    this.maxDepth = opts.maxDepth ?? resolveMaxDepth();
    this.spawnFn = opts.spawnWorker ?? spawnWorker;
    this.depths.set(this.agentId, 0);

    this.task = {
      create: async (packet) => this.registry.create(packet),
      get: async (id) => this.registry.get(id),
      list: async (filter?: TaskFilter) => this.registry.list(filter),
      update: async (id, patch) => this.registry.update(id, patch),
      stop: async () => {
        throw new Error("task.stop not implemented in M1");
      },
      output: async function* () {
        // Empty iterator; output streaming is M3.
        return;
      },
    };
  }

  emit(event: Omit<LaneEvent, "ts" | "agentId">): void {
    const full: LaneEvent = { ...event, ts: Date.now(), agentId: this.agentId };
    this.registry.emit(full);
    this.events.emit("lane_event", full);
  }

  async spawn(request: SpawnRequest): Promise<AgentHandle> {
    // AUTHORITATIVE depth: compute from parent's depth in our own map.
    const parentId =
      (request.parentAgentId ?? this.agentId) as AgentId;
    const parentDepth = this.depths.get(parentId);
    if (parentDepth === undefined) {
      throw new Error(
        `StandaloneHost.spawn: unknown parentAgentId "${parentId}"`,
      );
    }
    const childDepth = parentDepth + 1;
    if (childDepth > this.maxDepth) {
      // Emit lane event and reject.
      this.emit({
        type: "recursion_limit_hit",
        payload: { parentAgentId: parentId, attemptedDepth: childDepth, limit: this.maxDepth },
      });
      throw new Error(
        `recursion depth limit reached (${this.maxDepth})`,
      );
    }

    // Allocate child identity.
    const childAgentId = randomUUID() as AgentId;
    this.depths.set(childAgentId, childDepth);

    // Task registration: reuse or create.
    let taskRecord: TaskRecord;
    if (request.taskId !== undefined) {
      const existing = this.registry.get(request.taskId);
      if (!existing) {
        throw new Error(
          `StandaloneHost.spawn: unknown taskId "${request.taskId}"`,
        );
      }
      taskRecord = existing;
    } else {
      // Create a record from the packet (without id).
      // SpawnRequest.task is a TaskPacket including id; registry.create wants
      // Omit<TaskPacket,"id">. We strip id.
      const { id: _ignored, ...packetWithoutId } = request.task;
      taskRecord = this.registry.create(packetWithoutId);
    }

    // Spawn the subprocess.
    this.emit({
      type: "spawn_requested",
      payload: {
        parentAgentId: parentId,
        childAgentId,
        taskId: taskRecord.id,
        depth: childDepth,
      },
    });

    const child = this.spawnFn({
      agentId: childAgentId,
      depth: childDepth,
      parentPid: process.pid,
      orchestratorPid: process.pid,
      parentToolUseId: request.parentToolUseId,
    });
    const transport = new WorkerTransport(child);

    // Wait for worker_ready with a 10s timeout.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        transport.kill("SIGTERM");
        reject(
          new Error("worker_ready timeout: child never emitted worker_ready"),
        );
      }, 10_000);
      transport.once("worker_ready", () => {
        clearTimeout(timer);
        resolve();
      });
      transport.once("close", () => {
        clearTimeout(timer);
        reject(new Error("worker exited before emitting worker_ready"));
      });
    });
    await readyPromise;

    // Fire off the `run` request with the task packet.
    const taskForWorker: TaskPacket = { ...taskRecord };
    const runAckPromise = transport.send("run", taskForWorker, {
      timeoutMs: 30_000,
    });

    // Collect lane events into a buffer + re-emit on our bus.
    const laneBuffer: LaneEvent[] = [];
    const laneListener = (params: unknown) => {
      laneBuffer.push(params as LaneEvent);
      this.events.emit("lane_event", params as LaneEvent);
    };
    transport.on("lane_event", laneListener);

    // Promise that resolves with the final AgentResult.
    const resultPromise = new Promise<AgentResult>((resolve) => {
      transport.once("task_result", (params: unknown) => {
        resolve(params as AgentResult);
      });
      transport.once("close", (exit: unknown) => {
        // If close arrives before task_result, synthesize a failure.
        const exitCode = (exit as { code: number | null } | undefined)?.code ?? null;
        resolve({
          status: "failure",
          error: `worker exited (code=${exitCode}) before emitting task_result`,
          wallClockMs: 0,
        });
      });
    });

    // Await run ack (don't block the final result — run() just confirms receipt).
    void runAckPromise.catch(() => {
      /* if run ack rejects, result will resolve via task_result or close */
    });

    const handle: AgentHandle = {
      agentId: childAgentId,
      sessionId: childAgentId as unknown as SessionId, // M1 fresh session per worker; reuse id
      wait: async () => resultPromise,
      kill: async () => {
        transport.kill("SIGTERM");
      },
      events: async function* () {
        // Replay buffered events then listen for more.
        for (const evt of laneBuffer) yield evt;
        // M1: don't stream live; return after buffer.
        return;
      },
    };
    return handle;
  }

  async send(_to: AgentId, _message: AgentMessage): Promise<void> {
    throw new Error("send not implemented in M1");
  }

  async *inbox(): AsyncIterable<InboxEvent> {
    return; // M3
  }
}
