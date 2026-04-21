/**
 * Slash command registry — real 14-command registry for the ink REPL.
 *
 * Phase 3 canonical path: `buildDefaultRegistry(deps)` returns a registry
 * pre-populated with all 14 commands. The stub registry in
 * `src/ui/repl/state.ts` (`createStubSlashRegistry`) is a Phase 2 fallback
 * used when tests or the App receive no registry.
 *
 * Each command is a `SlashCommand`; its `execute(ctx)` returns a
 * `SlashCommandResult` that the REPL translates into reducer events and/or
 * transcript entries (see `src/cli/slash/dispatcher.ts`).
 */

import type { PermissionMode, Usage } from "../../core/types.js";
import type { SwarmHost } from "../../swarm/host.js";
import type { ReplState, ReplStateName, ReplEvent } from "../../ui/repl/state.js";

import { helpCommand } from "./commands/help.js";
import { exitCommand } from "./commands/exit.js";
import { clearCommand } from "./commands/clear.js";
import { statusCommand } from "./commands/status.js";
import { costCommand } from "./commands/cost.js";
import { modelCommand } from "./commands/model.js";
import { permissionsCommand } from "./commands/permissions.js";
import { resumeCommand } from "./commands/resume.js";
import { doctorCommand } from "./commands/doctor.js";
import { tasksCommand } from "./commands/tasks.js";
import { approveCommand } from "./commands/approve.js";
import { denyCommand } from "./commands/deny.js";
import { stopCommand } from "./commands/stop.js";
import { compactCommand } from "./commands/compact.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SlashCommandResult =
  /** Print to transcript as system entry. */
  | { readonly kind: "message"; readonly text: string }
  /** Dispatch a reducer event. */
  | { readonly kind: "reducer-event"; readonly event: ReplEvent }
  /** Emit text into the engine as the next user turn. */
  | { readonly kind: "engine-hint"; readonly prompt: string }
  /** No-op; command acted via side effects (e.g. mutating injected state). */
  | { readonly kind: "ok" }
  /** Error (invalid args, invalid state, etc.). Printed to transcript. */
  | { readonly kind: "error"; readonly message: string };

export interface SlashCommandContext {
  readonly state: ReplState;
  readonly args: readonly string[];
  readonly host?: SwarmHost;
  readonly registry: SlashCommandRegistry;
  readonly getUsage: () => Usage;
  readonly getModel: () => string;
  readonly setModel: (m: string) => void;
  readonly getPermissionMode: () => PermissionMode;
  readonly setPermissionMode: (m: PermissionMode) => void;
  readonly abort?: AbortController;
  readonly sessionLogPath?: string;
}

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  /** Per-command override; if omitted, dispatcher falls back to `slashCommandAllowedInState`. */
  readonly allowedInStates?: ReadonlyArray<ReplStateName>;
  readonly execute: (
    ctx: SlashCommandContext,
  ) => Promise<SlashCommandResult> | SlashCommandResult;
}

export interface SlashCommandRegistry {
  list(): ReadonlyArray<{ readonly name: string; readonly description: string }>;
  get(name: string): SlashCommand | undefined;
}

// ---------------------------------------------------------------------------
// buildDefaultRegistry
// ---------------------------------------------------------------------------

export interface BuildDefaultRegistryDeps {
  readonly getUsage?: () => Usage;
  readonly getModel?: () => string;
  readonly setModel?: (m: string) => void;
  readonly getPermissionMode?: () => PermissionMode;
  readonly setPermissionMode?: (m: PermissionMode) => void;
  readonly host?: SwarmHost;
  readonly sessionLogPath?: string;
  readonly abort?: AbortController;
}

const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
};

/**
 * Construct a registry pre-populated with all 14 slash commands.
 * All `deps` fields are optional; omitted ones fall back to safe defaults
 * (zero usage, identity-no-op setters, etc.).
 */
export function buildDefaultRegistry(
  deps: BuildDefaultRegistryDeps = {},
): SlashCommandRegistry {
  const commands: readonly SlashCommand[] = [
    helpCommand,
    exitCommand,
    clearCommand,
    statusCommand,
    costCommand,
    modelCommand,
    permissionsCommand,
    resumeCommand,
    doctorCommand,
    tasksCommand,
    approveCommand,
    denyCommand,
    stopCommand,
    compactCommand,
  ];

  const byName = new Map<string, SlashCommand>();
  for (const cmd of commands) {
    byName.set(cmd.name, cmd);
  }

  // Keep deps as an immutable snapshot for the registry's lifetime. The
  // dispatcher pulls these through when constructing each command's ctx.
  void deps; // captured via closure in the ctx factory; consumers read via helpers below

  return {
    list: () =>
      commands.map((c) => ({ name: c.name, description: c.description })),
    get: (name: string) => byName.get(name),
  };
}

/**
 * Helper: materialize a `SlashCommandContext` from a registry + per-turn
 * deps. Kept as an exported helper so `dispatchSlashLine` and tests share
 * the same fill-in-defaults logic.
 */
export function buildSlashContext(
  registry: SlashCommandRegistry,
  state: ReplState,
  args: readonly string[],
  deps: BuildDefaultRegistryDeps,
): SlashCommandContext {
  return {
    state,
    args,
    registry,
    host: deps.host,
    getUsage: deps.getUsage ?? (() => ZERO_USAGE),
    getModel: deps.getModel ?? (() => "claude-sonnet-4-6"),
    setModel: deps.setModel ?? (() => undefined),
    getPermissionMode:
      deps.getPermissionMode ?? (() => state.permissionMode),
    setPermissionMode: deps.setPermissionMode ?? (() => undefined),
    abort: deps.abort,
    sessionLogPath: deps.sessionLogPath,
  };
}

export { ZERO_USAGE };
