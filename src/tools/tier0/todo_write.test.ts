import { describe, it, expect, beforeEach } from "vitest";
import { todoWriteTool, getCurrentTodos, _resetTodos } from "./todo_write.js";
import type { ToolExecutionContext } from "../types.js";

const ctx: ToolExecutionContext = { cwd: "/tmp" };

beforeEach(() => {
  _resetTodos();
});

describe("todo_write — basic writes", () => {
  it("replaces empty state with a list", async () => {
    const result = await todoWriteTool.execute(
      {
        todos: [
          { id: "t1", content: "Write tests", status: "pending" },
          { id: "t2", content: "Implement feature", status: "in_progress" },
          { id: "t3", content: "Deploy", status: "completed" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toContain("☐ pending: t1 - Write tests");
    expect(result.output).toContain("▶ in_progress: t2 - Implement feature");
    expect(result.output).toContain("✓ completed: t3 - Deploy");
  });

  it("clears the list when given an empty array", async () => {
    // First populate
    await todoWriteTool.execute(
      { todos: [{ id: "x", content: "Something", status: "pending" }] },
      ctx,
    );
    // Then clear
    const result = await todoWriteTool.execute({ todos: [] }, ctx);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.output).toBe("(no todos)");
    expect(getCurrentTodos()).toHaveLength(0);
  });
});

describe("todo_write — in_progress invariant", () => {
  it("rejects more than one in_progress item", async () => {
    const result = await todoWriteTool.execute(
      {
        todos: [
          { id: "a", content: "Task A", status: "in_progress" },
          { id: "b", content: "Task B", status: "in_progress" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("only one todo may be in_progress");
    expect(result.message).toContain("2");
  });

  it("does not mutate state when invariant is violated", async () => {
    // Pre-populate with valid state
    await todoWriteTool.execute(
      { todos: [{ id: "orig", content: "Original", status: "pending" }] },
      ctx,
    );
    // Attempt invalid write
    await todoWriteTool.execute(
      {
        todos: [
          { id: "x", content: "X", status: "in_progress" },
          { id: "y", content: "Y", status: "in_progress" },
        ],
      },
      ctx,
    );
    // State should still be the original
    const todos = getCurrentTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].id).toBe("orig");
  });

  it("allows exactly one in_progress item", async () => {
    const result = await todoWriteTool.execute(
      {
        todos: [
          { id: "a", content: "Task A", status: "pending" },
          { id: "b", content: "Task B", status: "in_progress" },
          { id: "c", content: "Task C", status: "completed" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("ok");
  });
});

describe("todo_write — getCurrentTodos", () => {
  it("reflects the latest written state", async () => {
    await todoWriteTool.execute(
      {
        todos: [
          { id: "p1", content: "Phase 1", status: "completed" },
          { id: "p2", content: "Phase 2", status: "in_progress" },
        ],
      },
      ctx,
    );
    const todos = getCurrentTodos();
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({ id: "p1", status: "completed" });
    expect(todos[1]).toMatchObject({ id: "p2", status: "in_progress" });
  });

  it("returns empty array after _resetTodos", () => {
    // _resetTodos called in beforeEach — should already be empty
    expect(getCurrentTodos()).toHaveLength(0);
  });
});

describe("todo_write — status transitions", () => {
  it("handles pending → in_progress → completed", async () => {
    // Start pending
    await todoWriteTool.execute(
      { todos: [{ id: "task", content: "My task", status: "pending" }] },
      ctx,
    );
    expect(getCurrentTodos()[0].status).toBe("pending");

    // Move to in_progress
    await todoWriteTool.execute(
      { todos: [{ id: "task", content: "My task", status: "in_progress" }] },
      ctx,
    );
    expect(getCurrentTodos()[0].status).toBe("in_progress");

    // Move to completed
    const result = await todoWriteTool.execute(
      { todos: [{ id: "task", content: "My task", status: "completed" }] },
      ctx,
    );
    expect(result.status).toBe("ok");
    expect(getCurrentTodos()[0].status).toBe("completed");
    if (result.status !== "ok") return;
    expect(result.output).toContain("✓ completed: task - My task");
  });
});

describe("todo_write — input validation", () => {
  it("returns error for invalid input shape", async () => {
    const result = await todoWriteTool.execute({ todos: "not-an-array" }, ctx);
    expect(result.status).toBe("error");
  });

  it("preserves optional activeForm field", async () => {
    const result = await todoWriteTool.execute(
      {
        todos: [
          { id: "t1", content: "With form", status: "pending", activeForm: "edit" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("ok");
    const todos = getCurrentTodos();
    expect(todos[0].activeForm).toBe("edit");
  });
});
