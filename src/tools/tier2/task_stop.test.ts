/**
 * Tests for task_stop tool — M3a Phase 4.
 */

import { describe, it, expect } from "vitest";
import { taskStopTool } from "./task_stop.js";
import { makeFakeHost } from "./_fake-host.js";
import type { TaskRecord } from "../../swarm/host.js";
import type { AgentId } from "../../core/types.js";

const CTX_CWD = process.cwd();

function makeRunningRecord(id: string, owner?: AgentId): TaskRecord {
  const now = Date.now();
  return {
    id,
    prompt: "test task",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    status: "running",
    owner,
    createdAt: now,
    updatedAt: now,
    scope: "swarm:default",
  };
}

describe("task_stop tool", () => {
  it("stops a known task from orchestrator (standalone) host unconditionally", async () => {
    const taskId = "task-123";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRunningRecord(taskId, "owner-agent" as AgentId)],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskStopTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    expect((result as { status: "ok"; output: string }).output).toContain(taskId);

    // Verify registry was updated to "stopped".
    const updated = await host.task.get(taskId);
    expect(updated?.status).toBe("stopped");
    // Regression: ensure stoppedBy is persisted on the record so the
    // orchestrator's results.jsonl carries the cancelling caller's id.
    expect(updated?.stoppedBy).toBe("orchestrator");
  });

  it("returns error for unknown taskId", async () => {
    const { host } = makeFakeHost();

    const result = await taskStopTool.execute(
      { taskId: "nonexistent" },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toMatch(
      /unknown task/i,
    );
  });

  it("throws when no host is provided (engine catches this as a tool error)", async () => {
    await expect(
      taskStopTool.execute({ taskId: "any" }, { cwd: CTX_CWD }),
    ).rejects.toThrow("requires SwarmHost");
  });

  it("returns error for invalid input schema", async () => {
    const { host } = makeFakeHost();
    const result = await taskStopTool.execute(
      { taskId: 42 }, // wrong type
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("error");
  });

  it("worker host with SWARM_HARNESS_ALLOW_PEER_TASK_STOP=1 bypasses ancestry check", async () => {
    const taskId = "task-peer";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRunningRecord(taskId, "other-agent" as AgentId)],
    ]);
    // Simulate a worker-kind host
    const { host: baseHost } = makeFakeHost({ taskRecords: records });
    const workerHost = {
      ...baseHost,
      kind: "worker" as const,
      mode: "worker" as const,
    };

    const original = process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
    process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP = "1";
    try {
      const result = await taskStopTool.execute(
        { taskId },
        { cwd: CTX_CWD, host: workerHost },
      );
      expect(result.status).toBe("ok");
    } finally {
      if (original === undefined) {
        delete process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
      } else {
        process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP = original;
      }
    }
  });

  it("worker host without allow-peer-stop rejects when not ancestor", async () => {
    const taskId = "task-sibling";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRunningRecord(taskId, "other-agent" as AgentId)],
    ]);
    const { host: baseHost } = makeFakeHost({ taskRecords: records });
    // Override kind to "worker" and isAncestorOf to return false.
    const workerHost = {
      ...baseHost,
      kind: "worker" as const,
      mode: "worker" as const,
      isAncestorOf: async () => false,
    };

    const original = process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
    delete process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
    try {
      const result = await taskStopTool.execute(
        { taskId },
        { cwd: CTX_CWD, host: workerHost },
      );
      expect(result.status).toBe("error");
      expect((result as { status: "error"; message: string }).message).toContain(
        "permission denied",
      );
    } finally {
      if (original !== undefined) {
        process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP = original;
      }
    }
  });

  it("worker host with ancestor check passing can stop the task", async () => {
    const taskId = "task-child";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRunningRecord(taskId, "child-agent" as AgentId)],
    ]);
    const { host: baseHost } = makeFakeHost({ taskRecords: records });
    // Override kind to "worker" and isAncestorOf to return true (caller is ancestor).
    const workerHost = {
      ...baseHost,
      kind: "worker" as const,
      mode: "worker" as const,
      isAncestorOf: async () => true,
    };

    const original = process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
    delete process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP;
    try {
      const result = await taskStopTool.execute(
        { taskId },
        { cwd: CTX_CWD, host: workerHost },
      );
      expect(result.status).toBe("ok");
      const updated = await baseHost.task.get(taskId);
      expect(updated?.status).toBe("stopped");
    } finally {
      if (original !== undefined) {
        process.env.SWARM_HARNESS_ALLOW_PEER_TASK_STOP = original;
      }
    }
  });
});
