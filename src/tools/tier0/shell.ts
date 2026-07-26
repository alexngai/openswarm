/**
 * Persistent shell tools (F11–F15): shell_exec, shell_write, shell_list.
 *
 * These expose ShellSessionManager to the model as three tool surfaces:
 *
 *   shell_exec  — create a new session OR run a command in an existing one
 *                 + capture shell state snapshot after each command (F14)
 *   shell_write — send stdin/signals to a running session + read new output
 *   shell_list  — list/inspect/close/reattach/close_all sessions (F15)
 *
 * The session manager is a singleton per process (shared across all tool
 * invocations). The bash tool remains the primary tool for one-shot commands;
 * these tools are for interactive workflows (REPLs, servers, debuggers).
 */

import { z } from "zod";
import type { ToolImpl, ToolExecutionContext, ToolResult } from "../types.js";
import type { ToolSpec, JsonSchema } from "../../core/types.js";
import { ToolAccesses } from "../access.js";
import { ShellSessionManager, type ShellState } from "./shell-session.js";
import { cleanOutput } from "./output-cleanse.js";

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
// shell_exec — create session or exec in existing + state capture (F14)
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
const STATE_PROBE_WAIT_MS = 500;

const shellExecSpec: ToolSpec = {
  name: "shell_exec",
  description:
    "Execute a command in a persistent shell session. " +
    "Unlike `bash`, the session survives across tool calls — use it for interactive " +
    "workflows (dev servers, REPLs, debuggers, long-running builds). " +
    "Omit `session_id` to create a new session; provide it to reuse an existing one. " +
    "Returns the session ID, new stdout/stderr, shell state (cwd, env), and whether the process has exited.",
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
    mgr.readOutput(sessionId);
    mgr.setLastCommand(sessionId, input.command);
    mgr.writeStdin(sessionId, input.command + "\n");
  } else {
    const session = mgr.create(ctx.cwd, input.command);
    sessionId = session.id;
  }

  const timeoutMs = input.timeout ?? SHELL_EXEC_DEFAULT_TIMEOUT;
  const output = await waitForOutput(mgr, sessionId, timeoutMs, ctx.abort);

  // F14: inject state probe after command output settles (only if not exited).
  let stateSnapshot: ShellState | null = null;
  const prevState = mgr.get(sessionId)?.state ?? null;

  if (!output.exited) {
    mgr.injectStateProbe(sessionId);
    await sleep(STATE_PROBE_WAIT_MS);

    const probeOut = mgr.readOutput(sessionId);
    if (probeOut && probeOut.stdout) {
      const { cleaned, state } = mgr.extractState(probeOut.stdout);
      if (state) {
        stateSnapshot = state;
        mgr.updateState(sessionId, state);
      }
      // Append any non-probe output that came with it.
      if (cleaned) {
        output.stdout += cleaned;
      }
    }
  }

  return {
    status: "ok",
    output: formatSessionOutput(sessionId, output, stateSnapshot, prevState, input.command),
  };
}

export const shellExecTool: ToolImpl = {
  spec: shellExecSpec,
  execute: shellExecExecute,
  zodSchema: shellExecSchema,
  // A shell command's side effects cannot be described in terms of files.
  accesses: () => ToolAccesses.all(),
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

  return { status: "ok", output: formatSessionOutput(session_id, output, null, null) };
}

export const shellWriteTool: ToolImpl = {
  spec: shellWriteSpec,
  execute: shellWriteExecute,
  zodSchema: shellWriteSchema,
  // Input sent to a live session runs as a command; same reasoning as above.
  accesses: () => ToolAccesses.all(),
};

// ---------------------------------------------------------------------------
// shell_list — list/inspect/close/reattach/close_all sessions (F15)
// ---------------------------------------------------------------------------

const shellListSchema = z.object({
  action: z
    .enum(["list", "inspect", "close", "reattach", "close_all"])
    .optional()
    .describe("Action to take. Default: list."),
  session_id: z
    .string()
    .optional()
    .describe("Required for inspect/close/reattach."),
});

const shellListSpec: ToolSpec = {
  name: "shell_list",
  description:
    "Manage persistent shell sessions. " +
    "`list` — show all active sessions with PID, cwd, uptime, output size, last command, state. " +
    "`inspect` — show detailed info + pending output + state for one session. " +
    "`close` — kill and remove a session. " +
    "`reattach` — read ALL buffered output from a session (not just new). " +
    "`close_all` — kill and remove all sessions.",
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
        const idle = Math.round((Date.now() - s.lastAccessedAt) / 1000);
        const status = s.exited ? `exited(${s.exitCode})` : "running";
        const outputKB = ((s.totalStdoutBytes + s.totalStderrBytes) / 1024).toFixed(1);
        const cmd = s.lastCommand
          ? s.lastCommand.length > 40
            ? s.lastCommand.slice(0, 37) + "..."
            : s.lastCommand
          : "-";
        const cwd = s.state?.cwd ?? s.cwd;
        return (
          `${s.id}  pid=${s.pid}  cwd=${cwd}  uptime=${uptime}s  idle=${idle}s  ` +
          `output=${outputKB}KB  ${status}  cmd="${cmd}"`
        );
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
      const idle = Math.round((Date.now() - session.lastAccessedAt) / 1000);
      const info = [
        `id: ${session.id}`,
        `pid: ${session.pid}`,
        `cwd: ${session.state?.cwd ?? session.cwd}`,
        `uptime: ${uptime}s`,
        `idle: ${idle}s`,
        `status: ${session.exited ? `exited(${session.exitCode})` : "running"}`,
        `total_output: ${((session.totalStdoutBytes + session.totalStderrBytes) / 1024).toFixed(1)}KB`,
        `last_command: ${session.lastCommand ?? "-"}`,
      ];

      if (session.state) {
        info.push("--- shell state ---");
        info.push(`  cwd: ${session.state.cwd}`);
        const envEntries = Object.entries(session.state.env);
        if (envEntries.length > 0) {
          info.push("  env:");
          for (const [k, v] of envEntries) {
            info.push(`    ${k}=${v}`);
          }
        }
        if (session.state.shellOpts) {
          info.push(`  shell_opts: ${session.state.shellOpts}`);
        }
      }

      if (output && (output.stdout || output.stderr)) {
        info.push("--- pending output ---");
        if (output.stdout) info.push(`STDOUT:\n${output.stdout}`);
        if (output.stderr) info.push(`STDERR:\n${output.stderr}`);
      }
      return { status: "ok", output: info.join("\n") };
    }

    case "reattach": {
      if (!session_id) {
        return { status: "error", message: "session_id required for reattach" };
      }
      const session = mgr.get(session_id);
      if (!session) {
        return {
          status: "error",
          message: `session ${session_id} not found`,
        };
      }
      const allOutput = mgr.readAllOutput(session_id);
      if (!allOutput) {
        return { status: "error", message: `session ${session_id} not found` };
      }
      const parts = [`[reattach: ${session_id}]`];
      const reStdout = cleanOutput(allOutput.stdout).text;
      const reStderr = cleanOutput(allOutput.stderr).text;
      if (reStdout) parts.push(reStdout);
      if (reStderr) parts.push(`---\nSTDERR:\n${reStderr}`);
      if (allOutput.exited) {
        parts.push(`[exited: ${allOutput.exitCode}]`);
      } else {
        parts.push("[still running]");
      }
      return { status: "ok", output: parts.join("\n") };
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

    case "close_all": {
      const count = mgr.size;
      mgr.closeAll();
      return {
        status: "ok",
        output: count > 0 ? `closed ${count} session(s)` : "No sessions to close.",
      };
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
        if (more.stdout || more.stderr) continue;
      }
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

function formatSessionOutput(
  sessionId: string,
  output: WaitOutput,
  state: ShellState | null,
  prevState: ShellState | null,
  command?: string,
): string {
  const parts: string[] = [`[session: ${sessionId}]`];

  // Presentation-layer cleanse: strip ANSI/progress noise, redact secrets, and
  // elide long lines for the model-facing view. Runs here (not in the raw
  // pipeline) so state-probe extraction still sees unmodified output.
  const stdout = cleanOutput(output.stdout, { command }).text;
  const stderr = cleanOutput(output.stderr, { command }).text;

  if (stdout) {
    parts.push(stdout);
  }
  if (stderr) {
    parts.push(`---\nSTDERR:\n${stderr}`);
  }

  if (output.exited) {
    parts.push(`[exited: ${output.exitCode}]`);
  } else if (output.timedOut) {
    parts.push("[waiting for output timed out — process still running]");
  } else {
    parts.push("[still running]");
  }

  // F14: append state diff when available.
  if (state) {
    const stateParts: string[] = [];

    if (!prevState || prevState.cwd !== state.cwd) {
      stateParts.push(`cwd: ${state.cwd}`);
    }

    if (prevState) {
      const envChanges = diffEnv(prevState.env, state.env);
      if (envChanges.length > 0) {
        stateParts.push(...envChanges);
      }
    } else {
      const envEntries = Object.entries(state.env);
      if (envEntries.length > 0) {
        for (const [k, v] of envEntries) {
          stateParts.push(`${k}=${v}`);
        }
      }
    }

    if (stateParts.length > 0) {
      parts.push(`[shell state]\n${stateParts.join("\n")}`);
    }
  }

  return parts.join("\n");
}

function diffEnv(
  prev: Readonly<Record<string, string>>,
  curr: Readonly<Record<string, string>>,
): string[] {
  const changes: string[] = [];
  for (const [k, v] of Object.entries(curr)) {
    if (prev[k] !== v) {
      changes.push(`${k}=${v}`);
    }
  }
  for (const k of Object.keys(prev)) {
    if (!(k in curr)) {
      changes.push(`${k}= (unset)`);
    }
  }
  return changes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
