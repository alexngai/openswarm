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

  it("captures shell state after command (F14)", async () => {
    const result = await shellExecTool.execute(
      { command: "cd /var && echo done" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("done");
      // State probe should capture cwd change.
      expect(result.output).toContain("[shell state]");
      expect(result.output).toMatch(/cwd: \/var/);
    }
  });

  it("shows state diff on subsequent commands (F14)", async () => {
    const r1 = await shellExecTool.execute(
      { command: "echo first" },
      ctx(),
    );
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    const r2 = await shellExecTool.execute(
      { command: "cd /var", session_id: sessionId },
      ctx(),
    );
    expect(r2.status).toBe("ok");
    if (r2.status === "ok") {
      // Should show the cwd change.
      expect(r2.output).toContain("[shell state]");
      expect(r2.output).toMatch(/cwd: \/var/);
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

  it("lists all active sessions with rich metadata (F15)", async () => {
    await shellExecTool.execute({ command: "echo a" }, ctx());
    await shellExecTool.execute({ command: "echo b" }, ctx());

    const result = await shellListTool.execute({ action: "list" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("sh_1");
      expect(result.output).toContain("sh_2");
      expect(result.output).toContain("pid=");
      expect(result.output).toContain("idle=");
      expect(result.output).toContain("output=");
      expect(result.output).toContain('cmd="');
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

  it("inspects a session with state (F14/F15)", async () => {
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
      expect(result.output).toContain("idle:");
      expect(result.output).toContain("total_output:");
      expect(result.output).toContain("last_command:");
      // Should have shell state from the probe.
      expect(result.output).toContain("shell state");
    }
  });

  it("inspect returns error without session_id", async () => {
    const result = await shellListTool.execute(
      { action: "inspect" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("reattaches and reads all buffered output (F15)", async () => {
    const r1 = await shellExecTool.execute(
      { command: "echo reattach-first" },
      ctx(),
    );
    const sessionId = (r1 as { output: string }).output
      .match(/\[session: (sh_\d+)\]/)![1]!;

    // Run another command so there's more buffered output.
    await shellExecTool.execute(
      { command: "echo reattach-second", session_id: sessionId },
      ctx(),
    );

    const result = await shellListTool.execute(
      { action: "reattach", session_id: sessionId },
      ctx(),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("[reattach:");
      // Should contain output from both commands since it reads from the beginning.
      expect(result.output).toContain("reattach-first");
      expect(result.output).toContain("reattach-second");
    }
  });

  it("reattach returns error without session_id", async () => {
    const result = await shellListTool.execute(
      { action: "reattach" },
      ctx(),
    );
    expect(result.status).toBe("error");
  });

  it("reattach returns error for nonexistent session", async () => {
    const result = await shellListTool.execute(
      { action: "reattach", session_id: "sh_999" },
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

  it("close_all removes all sessions (F15)", async () => {
    await shellExecTool.execute({ command: "echo a" }, ctx());
    await shellExecTool.execute({ command: "echo b" }, ctx());
    await shellExecTool.execute({ command: "echo c" }, ctx());

    const result = await shellListTool.execute({ action: "close_all" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("closed 3 session(s)");
    }

    const list = await shellListTool.execute({ action: "list" }, ctx());
    if (list.status === "ok") {
      expect(list.output).toContain("No active sessions");
    }
  });

  it("close_all returns message when no sessions", async () => {
    const result = await shellListTool.execute({ action: "close_all" }, ctx());
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.output).toContain("No sessions to close");
    }
  });
});
