/**
 * Tier 2 tool unit tests — each tool exercised with a fake SwarmHost.
 * Consolidated to one file to keep the swarm tests cohesive; ≥3 tests per
 * tool per plan §Phase 2.4.
 */

import { describe, it, expect } from "vitest";
import type { ToolExecutionContext } from "../types.js";
import { makeFakeHost } from "./_fake-host.js";
import { taskCreateTool } from "./task_create.js";
import { taskUpdateTool } from "./task_update.js";
import { taskGetTool } from "./task_get.js";
import { taskListTool } from "./task_list.js";
import { agentTool } from "./agent.js";
import { buildTier2Tools } from "./index.js";
import type { AgentId } from "../../core/types.js";
import type { TaskPacket } from "../../swarm/host.js";

// TODO M3a Phase 2: replace these legacy-string policy stubs with discriminated-union shapes.
function legacyPolicies(): Pick<TaskPacket, "branchPolicy" | "commitPolicy" | "escalationPolicy"> {
  return {
    branchPolicy: "main" as unknown as TaskPacket["branchPolicy"],
    commitPolicy: "never" as unknown as TaskPacket["commitPolicy"],
    escalationPolicy: "abort-on-error" as unknown as TaskPacket["escalationPolicy"],
  };
}

// ---------------------------------------------------------------------------
// task_create
// ---------------------------------------------------------------------------

describe("task_create", () => {
  it("happy path: creates a task and returns id + status", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await taskCreateTool.execute(
      {
        prompt: "do something",
        ...legacyPolicies(),
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const body = JSON.parse(result.output) as { id: string; status: string };
      expect(body.id).toBe("fake-task-1");
      expect(body.status).toBe("pending");
    }
    expect(calls.taskCreate).toHaveLength(1);
    expect(calls.taskCreate[0]?.prompt).toBe("do something");
  });

  it("rejects invalid policy values via zod", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await taskCreateTool.execute(
      {
        prompt: "x",
        branchPolicy: "bogus",
        commitPolicy: "never",
        escalationPolicy: "abort-on-error",
      },
      ctx,
    );
    expect(result.status).toBe("error");
  });

  it("throws when host is missing", async () => {
    const ctx: ToolExecutionContext = { cwd: "/tmp" };
    await expect(
      taskCreateTool.execute(
        {
          prompt: "x",
          branchPolicy: "main",
          commitPolicy: "never",
          escalationPolicy: "abort-on-error",
        },
        ctx,
      ),
    ).rejects.toThrow(/task_create requires SwarmHost/);
  });
});

// ---------------------------------------------------------------------------
// task_update
// ---------------------------------------------------------------------------

describe("task_update", () => {
  it("happy path: applies status patch", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };

    // Seed a task first.
    await host.task.create({
      prompt: "x",
      ...legacyPolicies(),
    });

    const result = await taskUpdateTool.execute(
      { id: "fake-task-1", status: "running" },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(calls.taskUpdate).toHaveLength(1);
    expect(calls.taskUpdate[0]).toEqual({
      id: "fake-task-1",
      patch: { status: "running" },
    });
  });

  it("rejects empty patch", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await taskUpdateTool.execute({ id: "t-1" }, ctx);
    expect(result.status).toBe("error");
  });

  it("surfaces registry throw on unknown id", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    await expect(
      taskUpdateTool.execute({ id: "no-such-task", status: "failed" }, ctx),
    ).rejects.toThrow(/unknown task id/);
  });
});

// ---------------------------------------------------------------------------
// task_get
// ---------------------------------------------------------------------------

describe("task_get", () => {
  it("returns the record as JSON when present", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const created = await host.task.create({
      prompt: "hello",
      ...legacyPolicies(),
    });
    const result = await taskGetTool.execute({ id: created.id }, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.output) as { id: string };
      expect(parsed.id).toBe(created.id);
    }
  });

  it("returns 'null' when the id is unknown", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await taskGetTool.execute({ id: "nope" }, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("null");
    }
  });

  it("validates input: missing id → error", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await taskGetTool.execute({} as unknown, ctx);
    expect(result.status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// task_list
// ---------------------------------------------------------------------------

describe("task_list", () => {
  it("returns all tasks when no filter", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    await host.task.create({
      prompt: "a",
      ...legacyPolicies(),
    });
    await host.task.create({
      prompt: "b",
      ...legacyPolicies(),
    });
    const result = await taskListTool.execute({}, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.output) as Array<{ id: string }>;
      expect(parsed).toHaveLength(2);
    }
  });

  it("filters by status", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const t1 = await host.task.create({
      prompt: "a",
      ...legacyPolicies(),
    });
    await host.task.create({
      prompt: "b",
      ...legacyPolicies(),
    });
    await host.task.update(t1.id, { status: "succeeded" });

    const result = await taskListTool.execute({ status: "succeeded" }, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.output) as Array<{
        id: string;
        status: string;
      }>;
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.status).toBe("succeeded");
    }
  });

  it("truncates long prompts to 100 chars with ellipsis", async () => {
    const { host } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const longPrompt = "x".repeat(250);
    await host.task.create({
      prompt: longPrompt,
      ...legacyPolicies(),
    });
    const result = await taskListTool.execute({}, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const parsed = JSON.parse(result.output) as Array<{ prompt: string }>;
      expect(parsed[0]?.prompt.length).toBeLessThanOrEqual(101);
      expect(parsed[0]?.prompt).toMatch(/…$/);
    }
  });
});

// ---------------------------------------------------------------------------
// agent
// ---------------------------------------------------------------------------

describe("agent", () => {
  it("wait=true (default): spawns and returns sub-agent result", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await agentTool.execute({ prompt: "do x" }, ctx);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toBe("fake sub-agent output");
    }
    expect(calls.taskCreate).toHaveLength(1);
    expect(calls.spawn).toHaveLength(1);
    expect(calls.waitResolved).toBe(1);
  });

  it("wait=false: returns agentId + taskId without blocking", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await agentTool.execute(
      { prompt: "do x", wait: false },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const body = JSON.parse(result.output) as {
        agentId: string;
        taskId: string;
      };
      expect(body.agentId).toBe("fake-child-1");
      expect(body.taskId).toBe("fake-task-1");
    }
    expect(calls.waitResolved).toBe(0);
  });

  it("permissionMode defaults to workspace-write when unspecified", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    await agentTool.execute({ prompt: "x" }, ctx);
    expect(calls.spawn[0]?.permissionMode).toBe("workspace-write");
  });

  it("propagates toolUseId as parentToolUseId on the SpawnRequest", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = {
      cwd: "/tmp",
      host,
      toolUseId: "toolu_abc123",
    };
    await agentTool.execute({ prompt: "x" }, ctx);
    expect(calls.spawn[0]?.parentToolUseId).toBe("toolu_abc123");
  });

  it("does NOT set depth on the SpawnRequest (authoritative enforcement)", async () => {
    const { host, calls } = makeFakeHost();
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    await agentTool.execute({ prompt: "x" }, ctx);
    expect(calls.spawn[0]?.depth).toBeUndefined();
  });

  it("translates sub-agent failure into a ToolResult error", async () => {
    const { host } = makeFakeHost({
      waitResult: {
        status: "failure",
        error: "boom",
        wallClockMs: 10,
      },
    });
    const ctx: ToolExecutionContext = { cwd: "/tmp", host };
    const result = await agentTool.execute({ prompt: "x" }, ctx);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("boom");
    }
  });
});

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

describe("buildTier2Tools", () => {
  it("returns all nine tools in a stable order", () => {
    const tools = buildTier2Tools();
    expect(tools.map((t) => t.spec.name)).toEqual([
      "task_create",
      "task_update",
      "task_get",
      "task_list",
      "agent",
      "send_message",
      "check_inbox",
      "task_stop",
      "task_output",
    ]);
  });

  it("every tool is tier 2 with a zod schema", () => {
    for (const tool of buildTier2Tools()) {
      expect(tool.spec.tier).toBe(2);
      expect(tool.zodSchema).toBeDefined();
    }
  });
});

// Keep the AgentId import used (cast helper pattern check).
const _unused: AgentId | undefined = undefined;
void _unused;
