/**
 * Persistent shell tools (F11 + F12): shell_exec, shell_write, shell_list.
 *
 * These expose ShellSessionManager to the model as three tool surfaces:
 *
 *   shell_exec  — create a new session OR run a command in an existing one
 *   shell_write — send stdin/signals to a running session + read new output
 *   shell_list  — list/inspect/close sessions
 *
 * The session manager is a singleton per process (shared across all tool
 * invocations). The bash tool remains the primary tool for one-shot commands;
 * these tools are for interactive workflows (REPLs, servers, debuggers).
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ShellSessionManager } from "./shell-session.js";
import { headTailTruncate } from "./internal.js";

// ---------------------------------------------------------------------------
// Singleton session manager
// ---------------------------------------------------------------------------

let _manager: ShellSessionManager | undefined;

export function getSessionManager(): ShellSessionManager {
  if (!_manager) {
    _manager = new ShellSessionManager();
  }
  return _manager;
}

export function resetSessionManager(): void {
  if (_manager) {
    _manager.closeAll();
    _manager = undefined;
  }
}

// ---------------------------------------------------------------------------
// shell_exec — create session or exec in existing
// ---------------------------------------------------------------------------

const shellExecSchema = z.object({
  command: z.string().describe("Command to execute in the shell session."),
  session_id: z
    .string()
    .optional()
    .describe(
      "ID of an existing session to reuse. Omit to create a new session.",
    ),
  timeout: z
    .number()
    .positive()
    .optional()
    .describe(
      "Max milliseconds to wait for output after sending the command. Default 10000.",
    ),
});

type ShellExecInput = z.infer<typeof shellExecSchema>;

const SHELL_EXEC_DEFAULT_TIMEOUT = 10_000;
const OUTPUT_SETTLE_MS = 300;

const shellExecSpec: ToolSpec = {
  name: "shell_exec",
  description:
    "Execute a command in a persistent shell session. " +
    "Unlike `bash`, the session survives across tool calls — use it for interactive " +
    "workflows (dev servers, REPLs, debuggers, long-running builds). " +
    "Omit `session_id` to create a new session; provide it to reuse an existing one. " +
    "Returns the session ID, new stdout/stderr, and whether the process has exited.",
  inputSchema: z.toJSONSchema(shellExecSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 0,
};

async function shellExecExecute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = shellExecSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const input: ShellExecInput = parsed.data;
  const mgr = getSessionManager();

  let sessionId: string;

  if (input.session_id) {
    const existing = mgr.get(input.session_id);
    if (!existing) {
      return {
        status: "error",
        message: `session ${input.session_id} not found`,
      };
    }
    if (existing.exited) {
      return {
        status: "error",
        message: `session ${input.session_id} has exited (code ${existing.exitCode})`,
      };
    }
    sessionId = input.session_id;
    // Drain any stale output before sending the new command.
    mgr.readOutput(sessionId);
    mgr.writeStdin(sessionId, input.command + "\n");
  } else {
    const session = mgr.create(ctx.cwd, input.command);
    sessionId = session.id;
  }

  const timeoutMs = input.timeout ?? SHELL_EXEC_DEFAULT_TIMEOUT;
  const output = await waitForOutput(mgr, sessionId, timeoutMs, ctx.abort);

  return { status: "ok", output: formatSessionOutput(sessionId, output) };
}

export const shellExecTool: ToolImpl = {
  spec: shellExecSpec,
  execute: shellExecExecute,
  zodSchema: shellExecSchema,
};

// ---------------------------------------------------------------------------
// shell_write — send stdin/signals to a running session
// ---------------------------------------------------------------------------

const shellWriteSchema = z.object({
  session_id: z.string().describe("ID of the session to interact with."),
  input: z
    .string()
    .optional()
    .describe("Text to write to stdin. Newline is NOT auto-appended."),
  signal: z
    .enum(["SIGINT", "SIGTERM", "SIGKILL", "SIGTSTP", "SIGCONT"])
    .optional()
    .describe("Signal to send to the process (e.g. SIGINT for Ctrl-C)."),
  timeout: z
    .number()
    .positive()
    .optional()
    .describe("Max milliseconds to wait for output after write. Default 5000."),
});

type ShellWriteInput = z.infer<typeof shellWriteSchema>;

const SHELL_WRITE_DEFAULT_TIMEOUT = 5_000;

const shellWriteSpec: ToolSpec = {
  name: "shell_write",
  description:
    "Send input or signals to a running shell session and read new output. " +
    "Use this to interact with REPLs, respond to prompts, send Ctrl-C (SIGINT), " +
    "or poll for new output from a long-running process. " +
    "Provide `input` for text, `signal` for signals, or both.",
  inputSchema: z.toJSONSchema(shellWriteSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 0,
};

async function shellWriteExecute(
  raw: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = shellWriteSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const { session_id, input: text, signal, timeout } = parsed.data;
  const mgr = getSessionManager();

  const session = mgr.get(session_id);
  if (!session) {
    return { status: "error", message: `session ${session_id} not found` };
  }

  // Drain stale output first.
  mgr.readOutput(session_id);

  if (signal) {
    mgr.signal(session_id, signal);
  }
  if (text !== undefined) {
    const ok = mgr.writeStdin(session_id, text);
    if (!ok) {
      return {
        status: "error",
        message: `failed to write to session ${session_id} (exited)`,
      };
    }
  }

  const timeoutMs = timeout ?? SHELL_WRITE_DEFAULT_TIMEOUT;
  const output = await waitForOutput(mgr, session_id, timeoutMs, ctx.abort);

  return { status: "ok", output: formatSessionOutput(session_id, output) };
}

export const shellWriteTool: ToolImpl = {
  spec: shellWriteSpec,
  execute: shellWriteExecute,
  zodSchema: shellWriteSchema,
};

// ---------------------------------------------------------------------------
// shell_list — list/inspect/close sessions
// ---------------------------------------------------------------------------

const shellListSchema = z.object({
  action: z
    .enum(["list", "inspect", "close"])
    .optional()
    .describe("Action to take. Default: list."),
  session_id: z
    .string()
    .optional()
    .describe("Required for inspect/close."),
});

type ShellListInput = z.infer<typeof shellListSchema>;

const shellListSpec: ToolSpec = {
  name: "shell_list",
  description:
    "Manage persistent shell sessions. " +
    "`list` — show all active sessions with PID, cwd, uptime. " +
    "`inspect` — show detailed info for one session. " +
    "`close` — kill and remove a session.",
  inputSchema: z.toJSONSchema(shellListSchema) as JsonSchema,
  requiredPermission: "exec",
  tier: 0,
};

async function shellListExecute(
  raw: unknown,
  _ctx: ToolExecutionContext,
): Promise<ToolResult> {
  const parsed = shellListSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", message: parsed.error.message };
  }
  const { action = "list", session_id } = parsed.data;
  const mgr = getSessionManager();

  switch (action) {
    case "list": {
      const sessions = mgr.list();
      if (sessions.length === 0) {
        return { status: "ok", output: "No active sessions." };
      }
      const lines = sessions.map((s) => {
        const uptime = Math.round((Date.now() - s.startedAt) / 1000);
        const status = s.exited ? `exited(${s.exitCode})` : "running";
        return `${s.id}  pid=${s.pid}  cwd=${s.cwd}  uptime=${uptime}s  ${status}`;
      });
      return { status: "ok", output: lines.join("\n") };
    }

    case "inspect": {
      if (!session_id) {
        return { status: "error", message: "session_id required for inspect" };
      }
      const session = mgr.get(session_id);
      if (!session) {
        return {
          status: "error",
          message: `session ${session_id} not found`,
        };
      }
      const output = mgr.readOutput(session_id);
      const uptime = Math.round((Date.now() - session.startedAt) / 1000);
      const info = [
        `id: ${session.id}`,
        `pid: ${session.pid}`,
        `cwd: ${session.cwd}`,
        `uptime: ${uptime}s`,
        `status: ${session.exited ? `exited(${session.exitCode})` : "running"}`,
      ];
      if (output && (output.stdout || output.stderr)) {
        info.push("--- pending output ---");
        if (output.stdout) info.push(`STDOUT:\n${output.stdout}`);
        if (output.stderr) info.push(`STDERR:\n${output.stderr}`);
      }
      return { status: "ok", output: info.join("\n") };
    }

    case "close": {
      if (!session_id) {
        return { status: "error", message: "session_id required for close" };
      }
      const closed = mgr.close(session_id);
      if (!closed) {
        return {
          status: "error",
          message: `session ${session_id} not found`,
        };
      }
      return { status: "ok", output: `session ${session_id} closed` };
    }
  }
}

export const shellListTool: ToolImpl = {
  spec: shellListSpec,
  execute: shellListExecute,
  zodSchema: shellListSchema,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WaitOutput {
  stdout: string;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

async function waitForOutput(
  mgr: ShellSessionManager,
  sessionId: string,
  timeoutMs: number,
  abort?: AbortSignal,
): Promise<WaitOutput> {
  const deadline = Date.now() + timeoutMs;
  let combinedStdout = "";
  let combinedStderr = "";

  // Poll for output until timeout or process exits.
  while (Date.now() < deadline) {
    if (abort?.aborted) break;

    await sleep(OUTPUT_SETTLE_MS);

    const out = mgr.readOutput(sessionId);
    if (!out) break;

    combinedStdout += out.stdout;
    combinedStderr += out.stderr;

    if (out.exited) {
      return {
        stdout: combinedStdout,
        stderr: combinedStderr,
        exited: true,
        exitCode: out.exitCode,
        timedOut: false,
      };
    }

    // If we got output, wait a bit more for it to settle, then return.
    if (out.stdout || out.stderr) {
      await sleep(OUTPUT_SETTLE_MS);
      const more = mgr.readOutput(sessionId);
      if (more) {
        combinedStdout += more.stdout;
        combinedStderr += more.stderr;
        if (more.exited) {
          return {
            stdout: combinedStdout,
            stderr: combinedStderr,
            exited: true,
            exitCode: more.exitCode,
            timedOut: false,
          };
        }
        // If still producing output, keep polling.
        if (more.stdout || more.stderr) continue;
      }
      // Output settled — return what we have.
      break;
    }
  }

  const session = mgr.get(sessionId);
  return {
    stdout: combinedStdout,
    stderr: combinedStderr,
    exited: session?.exited ?? false,
    exitCode: session?.exitCode ?? null,
    timedOut: Date.now() >= deadline && !combinedStdout && !combinedStderr,
  };
}

function formatSessionOutput(sessionId: string, output: WaitOutput): string {
  const parts: string[] = [`[session: ${sessionId}]`];

  if (output.stdout) {
    parts.push(output.stdout);
  }
  if (output.stderr) {
    parts.push(`---\nSTDERR:\n${output.stderr}`);
  }

  if (output.exited) {
    parts.push(`[exited: ${output.exitCode}]`);
  } else if (output.timedOut) {
    parts.push("[waiting for output timed out — process still running]");
  } else {
    parts.push("[still running]");
  }

  return parts.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
