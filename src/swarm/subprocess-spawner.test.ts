import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We spy on spawn via a module-level mock.
vi.mock("node:child_process", () => {
  const spawnMock = vi.fn();
  return { spawn: spawnMock };
});

import { spawnWorker } from "./subprocess-spawner.js";
import { spawn } from "node:child_process";

const spawnMocked = vi.mocked(spawn);

// Minimal fake ChildProcess returned by the mock.
function fakeChild() {
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    pid: 99999,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  } as unknown as import("node:child_process").ChildProcess;
}

beforeEach(() => {
  spawnMocked.mockReset();
  spawnMocked.mockReturnValue(fakeChild());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("spawnWorker", () => {
  it("sets required env vars on the child process", () => {
    spawnWorker({
      agentId: "agent-abc",
      depth: 2,
      parentPid: 1000,
      orchestratorPid: 1001,
    });

    expect(spawnMocked).toHaveBeenCalledOnce();
    const [_exec, _argv, opts] = spawnMocked.mock.calls[0]!;
    const env = (opts as { env: NodeJS.ProcessEnv }).env;

    expect(env.SWARM_HARNESS_AGENT_ID).toBe("agent-abc");
    expect(env.SWARM_HARNESS_DEPTH).toBe("2");
    expect(env.SWARM_HARNESS_PARENT_PID).toBe("1000");
    expect(env.SWARM_HARNESS_ORCHESTRATOR_PID).toBe("1001");
  });

  it("sets SWARM_HARNESS_PARENT_TOOL_USE_ID when provided", () => {
    spawnWorker({
      agentId: "agent-xyz",
      depth: 1,
      parentPid: 200,
      orchestratorPid: 200,
      parentToolUseId: "tool-use-123",
    });

    const [_exec, _argv, opts] = spawnMocked.mock.calls[0]!;
    const env = (opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.SWARM_HARNESS_PARENT_TOOL_USE_ID).toBe("tool-use-123");
  });

  it("sets SWARM_HARNESS_MODEL when provided", () => {
    spawnWorker({
      agentId: "agent-model",
      depth: 1,
      parentPid: 200,
      orchestratorPid: 200,
      model: "litellm/qwen3.6-35b-a3b",
    });

    const [_exec, _argv, opts] = spawnMocked.mock.calls[0]!;
    const env = (opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.SWARM_HARNESS_MODEL).toBe("litellm/qwen3.6-35b-a3b");
  });

  it("does NOT set SWARM_HARNESS_PARENT_TOOL_USE_ID when not provided", () => {
    spawnWorker({
      agentId: "agent-xyz",
      depth: 1,
      parentPid: 200,
      orchestratorPid: 200,
    });

    const [_exec, _argv, opts] = spawnMocked.mock.calls[0]!;
    const env = (opts as { env: NodeJS.ProcessEnv }).env;
    expect(env.SWARM_HARNESS_PARENT_TOOL_USE_ID).toBeUndefined();
  });

  it("sets SWARM_HARNESS_SESSION_SIDECAR only when sessionSidecarPath is provided (B1.4)", () => {
    spawnWorker({ agentId: "a", depth: 1, parentPid: 1, orchestratorPid: 1 });
    let env = (spawnMocked.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.SWARM_HARNESS_SESSION_SIDECAR).toBeUndefined();

    spawnMocked.mockClear();
    spawnWorker({
      agentId: "a",
      depth: 1,
      parentPid: 1,
      orchestratorPid: 1,
      sessionSidecarPath: "/tmp/s/lead-session.json",
    });
    env = (spawnMocked.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env;
    expect(env.SWARM_HARNESS_SESSION_SIDECAR).toBe("/tmp/s/lead-session.json");
  });

  it("passes --worker and --agent-id flags in argv", () => {
    spawnWorker({
      agentId: "agent-def",
      depth: 0,
      parentPid: 300,
      orchestratorPid: 300,
      nodeExecPath: "/usr/bin/node",
    });

    const [_exec, argv] = spawnMocked.mock.calls[0]!;
    const args = argv as string[];
    expect(args).toContain("--worker");
    expect(args.some((a) => a.startsWith("--agent-id="))).toBe(true);
    expect(args.some((a) => a === "--agent-id=agent-def")).toBe(true);
  });

  it("uses nodeExecPath override instead of process.execPath", () => {
    spawnWorker({
      agentId: "agent-ghi",
      depth: 1,
      parentPid: 400,
      orchestratorPid: 400,
      nodeExecPath: "/custom/node",
    });

    const [exec] = spawnMocked.mock.calls[0]!;
    expect(exec).toBe("/custom/node");
  });

  it("configures stdio as pipe/pipe/inherit", () => {
    spawnWorker({
      agentId: "agent-jkl",
      depth: 0,
      parentPid: 500,
      orchestratorPid: 500,
    });

    const [_exec, _argv, opts] = spawnMocked.mock.calls[0]!;
    expect((opts as { stdio: unknown }).stdio).toEqual(["pipe", "pipe", "inherit"]);
  });
});
