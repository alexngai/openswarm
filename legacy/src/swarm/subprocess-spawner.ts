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
  readonly model?: string; // optional model id or alias for this worker
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
   * JSON in `OPENSWARM_ALLOWED_TOOLS`. Overrides any role-derived list
   * on the worker side when both are provided.
   */
  readonly allowedTools?: readonly string[];
  /**
   * Engine/framework selection propagated from the orchestrator.
   * Written to `OPENSWARM_FRAMEWORK`. Default: "auto".
   */
  readonly framework?: FrameworkChoice;
  /**
   * Team scope for this worker (v0.4 stage 4A.3). Propagated via
   * `OPENSWARM_TEAM_SCOPE` only when non-default; the worker side will
   * consume this in stage 4D when long-lived workers ship.
   */
  readonly teamScope?: string;
  /**
   * v0.4 stage 4D: opt the worker into long-lived mode. When set, the
   * spawner exports `OPENSWARM_LONG_LIVED=1` so the worker entry point
   * loops on `run_more` / `drain` instead of exiting after the initial task.
   */
  readonly longLived?: boolean;
  /**
   * v0.4 stage 4D: idle timeout in ms for long-lived workers. Plumbed via
   * `OPENSWARM_IDLE_TIMEOUT_MS`. Ignored when `longLived` is unset.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Stage B (ACP teams): route this worker's mode-denied tool calls back to the
   * orchestrator (which forwards them to an operator) instead of denying them
   * outright. Exported via `OPENSWARM_PERMISSION_ESCALATION=1`. The host
   * sets this when it holds an `interactionHandler`, so escalation is scoped to
   * the worker's env rather than mutating the orchestrator's process.env.
   */
  readonly permissionEscalation?: boolean;
  /**
   * Stage B1.4: path to a session sidecar this worker writes its engine session
   * id to (and reads on its first turn to resume across processes). Only the
   * coordinator root gets one (threaded from the ACP layer). Exported via
   * `OPENSWARM_SESSION_SIDECAR`.
   */
  readonly sessionSidecarPath?: string;
  /**
   * Scratchpad root for this worker, exported via `OPENSWARM_SCRATCHPAD_DIR`.
   * Usually unnecessary — the orchestrator's own scratchpad env is inherited
   * through the `process.env` spread and the worker carves a per-agent subdir
   * (see engine/scratchpad.ts). Set to point a worker at a different root.
   */
  readonly scratchpadDir?: string;
}

export function spawnWorker(args: SpawnWorkerArgs): ChildProcess {
  const cliPath = args.cliJsPath ?? DEFAULT_CLI_PATH;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSWARM_AGENT_ID: args.agentId,
    OPENSWARM_PARENT_PID: String(args.parentPid),
    OPENSWARM_ORCHESTRATOR_PID: String(args.orchestratorPid),
    OPENSWARM_DEPTH: String(args.depth),
  };
  if (args.parentToolUseId !== undefined) {
    env.OPENSWARM_PARENT_TOOL_USE_ID = args.parentToolUseId;
  }
  if (args.permissionMode !== undefined) {
    env.OPENSWARM_PERMISSION_MODE = args.permissionMode;
  }
  if (args.testScript !== undefined) {
    env.OPENSWARM_TEST_SCRIPT = args.testScript;
  }
  if (args.model !== undefined) {
    env.OPENSWARM_MODEL = args.model;
  }
  if (args.role !== undefined) {
    env.OPENSWARM_ROLE = args.role;
  }
  if (args.allowedTools !== undefined) {
    env.OPENSWARM_ALLOWED_TOOLS = JSON.stringify(args.allowedTools);
  }
  if (args.framework !== undefined) {
    env.OPENSWARM_FRAMEWORK = args.framework;
  }
  // Only emit the team scope env when the team is non-default — keeps the
  // env footprint clean for legacy single-team runs (v0.4 stage 4A.3).
  if (args.teamScope !== undefined && args.teamScope !== "swarm:default") {
    env.OPENSWARM_TEAM_SCOPE = args.teamScope;
  }
  // v0.4 stage 4D: opt-in long-lived worker mode. Worker entry checks
  // OPENSWARM_LONG_LIVED === "1" and loops on run_more/drain instead
  // of exiting after the initial task.
  if (args.longLived === true) {
    env.OPENSWARM_LONG_LIVED = "1";
  }
  if (args.idleTimeoutMs !== undefined) {
    env.OPENSWARM_IDLE_TIMEOUT_MS = String(args.idleTimeoutMs);
  }
  if (args.permissionEscalation === true) {
    env.OPENSWARM_PERMISSION_ESCALATION = "1";
  }
  if (args.sessionSidecarPath !== undefined) {
    env.OPENSWARM_SESSION_SIDECAR = args.sessionSidecarPath;
  }
  if (args.scratchpadDir !== undefined) {
    env.OPENSWARM_SCRATCHPAD_DIR = args.scratchpadDir;
  }
  // Per-worker prompt-cache routing key is derived inside worker-entry from
  // OPENSWARM_AGENT_ID. We don't propagate the parent's session id here:
  // workers share a backend by virtue of routing, not by sharing keys, so
  // each worker gets its own stable key from its own unique agentId.

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
