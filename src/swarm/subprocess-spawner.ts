import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export interface SpawnWorkerArgs {
  readonly agentId: string;
  readonly depth: number;
  readonly parentPid: number;
  readonly orchestratorPid: number;
  readonly parentToolUseId?: string;
  readonly testScript?: string; // optional path to ScriptedTestEngine fixture
  readonly cwd?: string;        // default process.cwd()
  readonly nodeExecPath?: string; // default process.execPath
  readonly cliJsPath?: string;    // default <repoRoot>/dist/cli.js
}

export function spawnWorker(args: SpawnWorkerArgs): ChildProcess {
  const cliPath =
    args.cliJsPath ?? path.resolve(process.cwd(), "dist/cli.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SWARM_CODER_AGENT_ID: args.agentId,
    SWARM_CODER_PARENT_PID: String(args.parentPid),
    SWARM_CODER_ORCHESTRATOR_PID: String(args.orchestratorPid),
    SWARM_CODER_DEPTH: String(args.depth),
  };
  if (args.parentToolUseId !== undefined) {
    env.SWARM_CODER_PARENT_TOOL_USE_ID = args.parentToolUseId;
  }
  if (args.testScript !== undefined) {
    env.SWARM_CODER_TEST_SCRIPT = args.testScript;
  }
  // Intentionally NOT setting SWARM_CODER_SESSION_ID — resume is out of M1.

  return spawn(
    args.nodeExecPath ?? process.execPath,
    [cliPath, "--worker", `--agent-id=${args.agentId}`],
    {
      cwd: args.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "inherit"],
      detached: false,
    },
  );
}
