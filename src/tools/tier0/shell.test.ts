import { describe, it, expect, afterEach } from "vitest";
import {
  shellExecTool,
  shellWriteTool,
  shellListTool,
  resetSessionManager,
} from "./shell.js";
import type { ToolExecutionContext } from "../types.js";

function ctx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return { cwd: "/tmp", ...overrides };
}

describe("shell_exec", () => {
  afterEach(() => {
    resetSessionManager();
  });

  it("creates a new session and runs a command", async () => {
    const result = await shellExecTool.execute(
      { command: "echo hello-exec" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("[session: sh_");
      expect(result.output).toContain("hello-exec");
    }
  });

  it("reuses an existing session", async () => {
    const r1 = await shellExecTool.execute(
      { command: "echo first" },
      ctx(),
    );
    expect(r1.status).toBe("ok");
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    const r2 = await shellExecTool.execute(
      { command: "echo second", session_id: sessionId },
      ctx(),
    );
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.output).toContain(sessionId);
      expect(r2.output).toContain("second");
    }
  });

  it("returns error for nonexistent session", async () => {
    const result = await shellExecTool.execute(
      { command: "echo x", session_id: "sh_999" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("returns error for invalid input", async () => {
    const result = await shellExecTool.execute({}, ctx());
    expect(result.status).toBe("error");
  });
});

describe("shell_write", () => {
  afterEach(() => {
    resetSessionManager();
  });

  it("sends stdin to a running session", async () => {
    const r1 = await shellExecTool.execute(
      { command: "cat" },
      ctx(),
    );
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    const r2 = await shellWriteTool.execute(
      { session_id: sessionId, input: "hello-write\n" },
      ctx(),
    );
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      expect(r2.output).toContain("hello-write");
    }
  });

  it("sends SIGINT signal", async () => {
    const r1 = await shellExecTool.execute(
      { command: "sleep 300" },
      ctx(),
    );
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    const r2 = await shellWriteTool.execute(
      { session_id: sessionId, signal: "SIGINT", timeout: 2000 },
      ctx(),
    );
    expect(r2.status).toBe("ok");
  });

  it("returns error for nonexistent session", async () => {
    const result = await shellWriteTool.execute(
      { session_id: "sh_999", input: "x" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });
});

describe("shell_list", () => {
  afterEach(() => {
    resetSessionManager();
  });

  it("lists all active sessions", async () => {
    await shellExecTool.execute({ command: "echo a" }, ctx());
    await shellExecTool.execute({ command: "echo b" }, ctx());

    const result = await shellListTool.execute({ action: "list" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("sh_1");
      expect(result.output).toContain("sh_2");
      expect(result.output).toContain("pid=");
    }
  });

  it("returns empty message when no sessions", async () => {
    const result = await shellListTool.execute({ action: "list" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No active sessions");
    }
  });

  it("defaults to list action", async () => {
    const result = await shellListTool.execute({}, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No active sessions");
    }
  });

  it("inspects a session", async () => {
    const r1 = await shellExecTool.execute(
      { command: "echo inspect-me" },
      ctx(),
    );
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    const result = await shellListTool.execute(
      { action: "inspect", session_id: sessionId },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain(`id: ${sessionId}`);
      expect(result.output).toContain("pid:");
      expect(result.output).toContain("cwd:");
    }
  });

  it("inspect returns error without session_id", async () => {
    const result = await shellListTool.execute(
      { action: "inspect" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("closes a session", async () => {
    const r1 = await shellExecTool.execute(
      { command: "echo close-me" },
      ctx(),
    );
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    const result = await shellListTool.execute(
      { action: "close", session_id: sessionId },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("closed");
    }

    // Verify it's gone.
    const list = await shellListTool.execute({ action: "list" }, ctx());
    if (list.status === "ok") {
      expect(list.output).toContain("No active sessions");
    }
  });

  it("close returns error for nonexistent session", async () => {
    const result = await shellListTool.execute(
      { action: "close", session_id: "sh_999" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });
});
