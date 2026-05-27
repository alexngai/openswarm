import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { WorkerTransport } from "../../src/swarm/ipc/worker-transport.js";
import type { TaskPacket } from "../../src/swarm/host.js";

export interface HarnessOpts {
  readonly agentId?: string;
  readonly testScript: string; // path to worker script fixture (relative to cwd or absolute)
  readonly permissionMode?: "read-only" | "workspace-write" | "danger-full-access";
  readonly depth?: number;
  readonly heartbeatIntervalMs?: number;
  readonly env?: Record<string, string>;
}

export interface HarnessResult {
  child: ChildProcess;
  transport: WorkerTransport;
  close: () => Promise<void>;
}

export function spawnWorkerProcess(opts: HarnessOpts): HarnessResult {
  const cliPath = path.resolve(process.cwd(), "dist/cli.js");
  const scriptPath = path.isAbsolute(opts.testScript)
    ? opts.testScript
    : path.resolve(process.cwd(), opts.testScript);

  const agentId = opts.agentId ?? "test-agent";

  const child = spawn(
    process.execPath,
    [cliPath, "--worker", `--agent-id=${agentId}`],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SWARM_HARNESS_AGENT_ID: agentId,
        SWARM_HARNESS_PARENT_PID: String(process.pid),
        SWARM_HARNESS_ORCHESTRATOR_PID: String(process.pid),
        SWARM_HARNESS_DEPTH: String(opts.depth ?? 1),
        SWARM_HARNESS_TEST_SCRIPT: scriptPath,
        ...(opts.permissionMode !== undefined && {
          SWARM_HARNESS_PERMISSION_MODE: opts.permissionMode,
        }),
        ...(opts.heartbeatIntervalMs !== undefined && {
          SWARM_HARNESS_HEARTBEAT_MS: String(opts.heartbeatIntervalMs),
        }),
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const transport = new WorkerTransport(child);

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      child.once("close", finish);
      transport.kill("SIGTERM");
      setTimeout(() => {
        if (!done) {
          child.kill("SIGKILL");
        }
        setTimeout(finish, 200);
      }, 2000);
    });

  return { child, transport, close };
}

/** Build a minimal TaskPacket for sending to workers. */
export function makeTaskPacket(prompt = "test task"): TaskPacket {
  return {
    id: `task-${Date.now()}`,
    prompt,
    branchPolicy: { kind: "none" },
    commitPolicy: { kind: "none" },
    escalationPolicy: { kind: "none" },
  };
}

/**
 * Wait for worker_ready then send run request.
 * Resolves with the task_result params.
 */
export function runWorker(
  transport: WorkerTransport,
  task: TaskPacket,
  opts: { timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      reject(new Error(`runWorker timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    transport.once("worker_ready", () => {
      // Send run request.
      transport
        .send("run", task, { timeoutMs: timeoutMs })
        .then(() => {
          // Worker acks; now wait for task_result.
          transport.once("task_result", (result) => {
            clearTimeout(timer);
            resolve(result);
          });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

    // Handle premature close.
    transport.once("close", () => {
      clearTimeout(timer);
      reject(new Error("worker closed before task_result"));
    });
  });
}
