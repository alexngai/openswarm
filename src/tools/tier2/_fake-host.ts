/**
 * FakeSwarmHost — minimal SwarmHost stand-in for Tier 2 tool tests.
 *
 * Leading underscore in filename keeps it out of any tool-factory globs.
 * Records all incoming calls for assertion convenience.
 */

import { vi } from "vitest";
import type {
  SwarmHost,
  SpawnRequest,
  AgentHandle,
  AgentMessage,
  InboxEvent,
  TaskAPI,
  TaskRecord,
  TaskPacket,
  TaskFilter,
  AgentResult,
  SendResult,
} from "../../swarm/host.js";
import type { AgentId, SessionId } from "../../core/types.js";
import type { LaneEvent } from "../../swarm/events.js";
import type { AskUserResponse } from "../../swarm/host.js";

export interface FakeHostOpts {
  /** Override what handle.wait() resolves with. */
  readonly waitResult?: AgentResult;
  /** Override task records returned by get/create. */
  readonly taskRecords?: Map<string, TaskRecord>;
  /**
   * Override what `host.askUser` returns. Defaults to a canned
   * `{status: "answered", answer: "fake-answer"}`; tests configure per-case.
   */
  readonly askUserResponse?: AskUserResponse;
}

export function makeFakeHost(opts: FakeHostOpts = {}): {
  host: SwarmHost;
  calls: {
    taskCreate: Array<Omit<TaskPacket, "id">>;
    taskUpdate: Array<{ id: string; patch: unknown }>;
    taskGet: string[];
    taskList: TaskFilter[];
    spawn: SpawnRequest[];
    waitResolved: number;
    askUser: Array<{ question: string; options?: readonly string[] }>;
  };
} {
  const calls = {
    taskCreate: [] as Array<Omit<TaskPacket, "id">>,
    taskUpdate: [] as Array<{ id: string; patch: unknown }>,
    taskGet: [] as string[],
    taskList: [] as TaskFilter[],
    spawn: [] as SpawnRequest[],
    waitResolved: 0,
    askUser: [] as Array<{ question: string; options?: readonly string[] }>,
  };

  const records =
    opts.taskRecords ?? new Map<string, TaskRecord>();
  let counter = 0;

  const task: TaskAPI = {
    async create(packet) {
      calls.taskCreate.push(packet);
      const id = `fake-task-${++counter}`;
      const now = Date.now();
      const record: TaskRecord = {
        ...packet,
        id,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        scope: "swarm:default",
      };
      records.set(id, record);
      return record;
    },
    async get(id) {
      calls.taskGet.push(id);
      return records.get(id);
    },
    async list(filter) {
      calls.taskList.push(filter ?? {});
      let out = Array.from(records.values());
      if (filter?.status !== undefined) {
        out = out.filter((r) => r.status === filter.status);
      }
      if (filter?.owner !== undefined) {
        out = out.filter((r) => r.owner === filter.owner);
      }
      return out;
    },
    async update(id, patch) {
      calls.taskUpdate.push({ id, patch });
      const existing = records.get(id);
      if (!existing) {
        throw new Error(`unknown task id: ${id}`);
      }
      records.set(id, { ...existing, ...patch, updatedAt: Date.now() });
    },
    async stop(id: string, by?: AgentId | "orchestrator") {
      const existing = records.get(id);
      if (!existing) throw new Error(`unknown task id: ${id}`);
      records.set(id, {
        ...existing,
        status: "stopped",
        updatedAt: Date.now(),
        stoppedBy: by ?? "orchestrator",
      });
    },
    async ownerOf(taskId: string) {
      return records.get(taskId)?.owner;
    },
    appendOutput(id: string, chunk: string) {
      const existing = records.get(id);
      if (!existing) return;
      records.set(id, {
        ...existing,
        output: (existing.output ?? "") + chunk,
        updatedAt: Date.now(),
      });
    },
    async *output(id: string) {
      const record = records.get(id);
      if (record?.output) yield record.output;
    },
    async pullNext(scope, claimerId) {
      // v0.5 stage 5C: minimal in-memory claim semantics for tests.
      for (const r of records.values()) {
        if (r.scope !== scope) continue;
        if (r.status !== "pending") continue;
        if (r.owner !== undefined) continue;
        const claimed: TaskRecord = {
          ...r,
          owner: claimerId,
          status: "running",
          updatedAt: Date.now(),
        };
        records.set(r.id, claimed);
        return claimed;
      }
      return null;
    },
  };

  const waitResult: AgentResult =
    opts.waitResult ?? {
      status: "success",
      output: "fake sub-agent output",
      usage: { inputTokens: 10, outputTokens: 20 },
      wallClockMs: 50,
    };

  const spawn = vi.fn(async (req: SpawnRequest): Promise<AgentHandle> => {
    calls.spawn.push(req);
    const handle: AgentHandle = {
      agentId: `fake-child-${calls.spawn.length}` as AgentId,
      sessionId: `fake-session-${calls.spawn.length}` as SessionId,
      async wait() {
        calls.waitResolved++;
        return waitResult;
      },
      async kill() {
        return;
      },
      async *events(): AsyncIterable<LaneEvent> {
        return;
      },
      async runMore() {
        throw new Error("runMore not supported in fake host");
      },
      async drain() {
        return;
      },
    };
    return handle;
  });

  const host: SwarmHost = {
    mode: "standalone",
    kind: "standalone",
    agentId: "fake-agent" as AgentId,
    depth: 0,
    permissionMode: "workspace-write",
    emit: vi.fn(),
    spawn,
    async isAncestorOf(_ancestor: AgentId, _descendant: AgentId): Promise<boolean> {
      // Default fake: always return true (permissive for unit tests).
      return true;
    },
    send(_to: AgentId | "*" | `role:${string}`, _message: AgentMessage): Promise<SendResult> {
      throw new Error("send not implemented in fake host");
    },
    async *inbox(): AsyncIterable<InboxEvent> {
      return;
    },
    async drainInbox(_max: number): Promise<AgentMessage[]> {
      return [];
    },
    async readThread(_threadId: string): Promise<AgentMessage[]> {
      return [];
    },
    async listAgents(): Promise<readonly AgentId[]> {
      return [];
    },
    askUser: vi.fn(
      async (
        question: string,
        options?: readonly string[],
      ): Promise<AskUserResponse> => {
        calls.askUser.push({
          question,
          ...(options !== undefined && { options }),
        });
        return (
          opts.askUserResponse ?? {
            status: "answered",
            answer: "fake-answer",
          }
        );
      },
    ),
    task,
  };

  return { host, calls };
}
