import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { PermissionMode } from "../core/types.js";
import type { FrameworkChoice } from "../cli/argv.js";

export interface SpawnWorkerArgs {
  readonly agentId: string;
  readonly depth: number;
  readonly parentPid: number;
  readonly orchestratorPid: number;
  readonly parentToolUseId?: string;
  readonly permissionMode?: PermissionMode;
  readonly testScript?: string; // optional path to ScriptedTestEngine fixture
  readonly cwd?: string;        // default process.cwd()
  readonly nodeExecPath?: string; // default process.execPath
  readonly cliJsPath?: string;    // default <repoRoot>/dist/cli.js
  /**
   * Role name applied to this worker (M3a Phase 6). Worker entry looks it
   * up in its RoleRegistry to overlay systemPrompt + allowedTools.
   */
  readonly role?: string;
  /**
   * Explicit tool allowlist for this worker (M3a Phase 6). Serialised as
   * JSON in `SWARM_HARNESS_ALLOWED_TOOLS`. Overrides any role-derived list
   * on the worker side when both are provided.
   */
  readonly allowedTools?: readonly string[];
  /**
   * Engine/framework selection propagated from the orchestrator.
   * Written to `SWARM_HARNESS_FRAMEWORK`. Default: "auto".
   */
  readonly framework?: FrameworkChoice;
}

export function spawnWorker(args: SpawnWorkerArgs): ChildProcess {
  const cliPath =
    args.cliJsPath ?? path.resolve(process.cwd(), "dist/cli.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SWARM_HARNESS_AGENT_ID: args.agentId,
    SWARM_HARNESS_PARENT_PID: String(args.parentPid),
    SWARM_HARNESS_ORCHESTRATOR_PID: String(args.orchestratorPid),
    SWARM_HARNESS_DEPTH: String(args.depth),
  };
  if (args.parentToolUseId !== undefined) {
    env.SWARM_HARNESS_PARENT_TOOL_USE_ID = args.parentToolUseId;
  }
  if (args.permissionMode !== undefined) {
    env.SWARM_HARNESS_PERMISSION_MODE = args.permissionMode;
  }
  if (args.testScript !== undefined) {
    env.SWARM_HARNESS_TEST_SCRIPT = args.testScript;
  }
  if (args.role !== undefined) {
    env.SWARM_HARNESS_ROLE = args.role;
  }
  if (args.allowedTools !== undefined) {
    env.SWARM_HARNESS_ALLOWED_TOOLS = JSON.stringify(args.allowedTools);
  }
  if (args.framework !== undefined) {
    env.SWARM_HARNESS_FRAMEWORK = args.framework;
  }
  // Intentionally NOT setting SWARM_HARNESS_SESSION_ID — resume is out of M1.

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
