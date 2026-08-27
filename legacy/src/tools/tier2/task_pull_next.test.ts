/**
 * task_pull_next.test.ts — v0.5 stage 5C.
 */

import { describe, it, expect } from "vitest";
import { taskPullNextTool } from "./task_pull_next.js";
import { makeFakeHost } from "./_fake-host.js";
import type { AgentId } from "../../core/types.js";
import type { TaskRecord } from "../../swarm/host.js";

const CTX_CWD = process.cwd();

function plantTask(
  records: Map<string, TaskRecord>,
  id: string,
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const now = Date.now();
  const record: TaskRecord = {
    id,
    prompt: "do work",
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
    status: "pending",
    createdAt: now,
    updatedAt: now,
    scope: "swarm:default",
    ...overrides,
  };
  records.set(id, record);
  return record;
}

describe("task_pull_next tool", () => {
  it("returns 'null' when no claimable task is available", async () => {
    const { host } = makeFakeHost();
    const result = await taskPullNextTool.execute(
      { scope: "swarm:default" },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.output).toBe("null");
  });

  it("claims the first pending task in the requested scope", async () => {
    const records = new Map<string, TaskRecord>();
    plantTask(records, "t1", { scope: "swarm:default" });
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskPullNextTool.execute(
      { scope: "swarm:default" },
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const claimed = JSON.parse(result.output) as TaskRecord;
    expect(claimed.id).toBe("t1");
    expect(claimed.status).toBe("running");
    expect(claimed.owner).toBe(host.agentId);
  });

  it("does not claim tasks owned by another agent", async () => {
    const records = new Map<string, TaskRecord>();
    plantTask(records, "t1", { owner: "agent-other" as AgentId });
    plantTask(records, "t2", { scope: "swarm:default" });
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskPullNextTool.execute(
      {},
      { cwd: CTX_CWD, host },
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const claimed = JSON.parse(result.output) as TaskRecord;
    expect(claimed.id).toBe("t2");
  });

  it("does not cross team scope boundaries", async () => {
    const records = new Map<string, TaskRecord>();
    plantTask(records, "t1", { scope: "swarm:alpha" });
    plantTask(records, "t2", { scope: "swarm:beta" });
    const { host } = makeFakeHost({ taskRecords: records });

    const result = await taskPullNextTool.execute(
      { scope: "swarm:beta" },
      { cwd: CTX_CWD, host },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    const claimed = JSON.parse(result.output) as TaskRecord;
    expect(claimed.id).toBe("t2");
    expect(claimed.scope).toBe("swarm:beta");
  });

  it("two pulls in succession claim two different tasks (atomicity)", async () => {
    const records = new Map<string, TaskRecord>();
    plantTask(records, "t1");
    plantTask(records, "t2");
    const { host } = makeFakeHost({ taskRecords: records });

    const r1 = await taskPullNextTool.execute({}, { cwd: CTX_CWD, host });
    const r2 = await taskPullNextTool.execute({}, { cwd: CTX_CWD, host });
    if (r1.status !== "ok" || r2.status !== "ok") throw new Error("expected ok");
    const c1 = JSON.parse(r1.output) as TaskRecord;
    const c2 = JSON.parse(r2.output) as TaskRecord;
    expect(c1.id).not.toBe(c2.id);
  });

  it("scope omitted falls back to host.scopeOf(host.agentId)", async () => {
    const records = new Map<string, TaskRecord>();
    plantTask(records, "t-team", { scope: "swarm:gsd" });
    const { host } = makeFakeHost({ taskRecords: records });
    // The fake host registers under "swarm:default" by default; pin a custom
    // scopeOf so the tool resolves to "swarm:gsd".
    (host as unknown as { scopeOf: (id: AgentId) => string }).scopeOf = () =>
      "swarm:gsd";

    const result = await taskPullNextTool.execute(
      {},
      { cwd: CTX_CWD, host },
    );
    if (result.status !== "ok") throw new Error("expected ok");
    const claimed = JSON.parse(result.output) as TaskRecord;
    expect(claimed.scope).toBe("swarm:gsd");
  });
});
