import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "../core/types.js";
import type { FrameworkChoice } from "../cli/argv.js";

/**
 * Default worker entry path resolved by walking up from THIS module's
 * location until we find `dist/cli.js`. Works for both:
 *
 *   - Compiled mode (`dist/swarm/subprocess-spawner.js`): walks
 *     `dist/swarm` → `dist` → finds the install root → `dist/cli.js`.
 *   - Source mode (`src/swarm/subprocess-spawner.ts` under vitest):
 *     walks `src/swarm` → `src` → repo root → `dist/cli.js`.
 *
 * Pre-fix, `path.resolve(process.cwd(), "dist/cli.js")` only worked when
 * the user invoked `swarm run` from the install dir; v0.1 smoke pass
 * caught the regression when running from `/tmp`.
 */
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
function findDefaultCliPath(): string {
  let dir = SCRIPT_DIR;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "dist", "cli.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: fall back to the pre-fix behavior so callers in unusual
  // setups still get a path (which they can override via `cliJsPath`).
  return path.resolve(process.cwd(), "dist/cli.js");
}
const DEFAULT_CLI_PATH = findDefaultCliPath();

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
  /**
   * Team scope for this worker (v0.4 stage 4A.3). Propagated via
   * `SWARM_HARNESS_TEAM_SCOPE` only when non-default; the worker side will
   * consume this in stage 4D when long-lived workers ship.
   */
  readonly teamScope?: string;
  /**
   * v0.4 stage 4D: opt the worker into long-lived mode. When set, the
   * spawner exports `SWARM_HARNESS_LONG_LIVED=1` so the worker entry point
   * loops on `run_more` / `drain` instead of exiting after the initial task.
   */
  readonly longLived?: boolean;
  /**
   * v0.4 stage 4D: idle timeout in ms for long-lived workers. Plumbed via
   * `SWARM_HARNESS_IDLE_TIMEOUT_MS`. Ignored when `longLived` is unset.
   */
  readonly idleTimeoutMs?: number;
}

export function spawnWorker(args: SpawnWorkerArgs): ChildProcess {
  const cliPath = args.cliJsPath ?? DEFAULT_CLI_PATH;
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
  // Only emit the team scope env when the team is non-default — keeps the
  // env footprint clean for legacy single-team runs (v0.4 stage 4A.3).
  if (args.teamScope !== undefined && args.teamScope !== "swarm:default") {
    env.SWARM_HARNESS_TEAM_SCOPE = args.teamScope;
  }
  // v0.4 stage 4D: opt-in long-lived worker mode. Worker entry checks
  // SWARM_HARNESS_LONG_LIVED === "1" and loops on run_more/drain instead
  // of exiting after the initial task.
  if (args.longLived === true) {
    env.SWARM_HARNESS_LONG_LIVED = "1";
  }
  if (args.idleTimeoutMs !== undefined) {
    env.SWARM_HARNESS_IDLE_TIMEOUT_MS = String(args.idleTimeoutMs);
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
