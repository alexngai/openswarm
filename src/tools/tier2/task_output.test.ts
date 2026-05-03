/**
 * Tests for task_output tool — M3a Phase 4.
 */

import { describe, it, expect } from "vitest";
import { taskOutputTool } from "./task_output.js";
import { makeFakeHost } from "./_fake-host.js";
import type { TaskRecord } from "../../swarm/host.js";

const CTX_CWD = process.cwd();

function makeRecord(
  id: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const now = Date.now();
  return {
    id,
    prompt: "test task",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    status: "running",
    createdAt: now,
    updatedAt: now,
    scope: "swarm:default",
    ...overrides,
  };
}

describe("task_output tool", () => {
  it("returns error for unknown taskId", async () => {
    const { host } = makeFakeHost();
    const result = await taskOutputTool.execute(
      { taskId: "nonexistent" },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("error");
    expect((result as { status: "error"; message: string }).message).toContain(
      "unknown taskId",
    );
  });

  it("returns running status with partialOutput for a running task", async () => {
    const taskId = "task-running";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRecord(taskId, { status: "running", output: "partial text" })],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskOutputTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    const parsed = JSON.parse((result as { status: "ok"; output: string }).output);
    expect(parsed.status).toBe("running");
    expect(parsed.partialOutput).toBe("partial text");
    expect(parsed.sizeBytes).toBe("partial text".length);
  });

  it("returns running status with empty partialOutput when no output yet", async () => {
    const taskId = "task-no-output";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRecord(taskId, { status: "running" })],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskOutputTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    const parsed = JSON.parse((result as { status: "ok"; output: string }).output);
    expect(parsed.status).toBe("running");
    expect(parsed.partialOutput).toBe("");
    expect(parsed.sizeBytes).toBe(0);
  });

  it("returns pending status as running (pending is non-terminal)", async () => {
    const taskId = "task-pending";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRecord(taskId, { status: "pending" })],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskOutputTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    const parsed = JSON.parse((result as { status: "ok"; output: string }).output);
    expect(parsed.status).toBe("running");
  });

  it("returns terminal state for a succeeded task with output, usage, wallClockMs", async () => {
    const taskId = "task-succeeded";
    const usage = { inputTokens: 100, outputTokens: 50 };
    const records = new Map<string, TaskRecord>([
      [
        taskId,
        makeRecord(taskId, {
          status: "succeeded",
          output: "final output",
          usage,
          wallClockMs: 1234,
        }),
      ],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskOutputTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    const parsed = JSON.parse((result as { status: "ok"; output: string }).output);
    expect(parsed.status).toBe("succeeded");
    expect(parsed.output).toBe("final output");
    expect(parsed.usage).toEqual(usage);
    expect(parsed.wallClockMs).toBe(1234);
  });

  it("returns terminal state for a failed task", async () => {
    const taskId = "task-failed";
    const records = new Map<string, TaskRecord>([
      [
        taskId,
        makeRecord(taskId, {
          status: "failed",
          error: "something went wrong",
          wallClockMs: 500,
        }),
      ],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskOutputTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    const parsed = JSON.parse((result as { status: "ok"; output: string }).output);
    expect(parsed.status).toBe("failed");
    expect(parsed.wallClockMs).toBe(500);
  });

  it("returns terminal state for a stopped task", async () => {
    const taskId = "task-stopped";
    const records = new Map<string, TaskRecord>([
      [taskId, makeRecord(taskId, { status: "stopped", wallClockMs: 200 })],
    ]);
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskOutputTool.execute(
      { taskId },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    const parsed = JSON.parse((result as { status: "ok"; output: string }).output);
    expect(parsed.status).toBe("stopped");
  });

  it("throws when no host is provided (engine catches this as a tool error)", async () => {
    await expect(
      taskOutputTool.execute({ taskId: "any" }, { cwd: CTX_CWD }),
    ).rejects.toThrow("requires SwarmHost");
  });

  it("returns error for invalid input schema", async () => {
    const { host } = makeFakeHost();
    const result = await taskOutputTool.execute(
      { taskId: 99 }, // wrong type
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("error");
  });
});
