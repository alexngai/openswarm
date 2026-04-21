/**
 * index.ts — ink REPL entry point.
 *
 * Public surface:
 *   - `runRepl(config)` — mount the <App> against a TTY and resolve when the
 *     user exits the REPL (via /exit, SIGINT, or engine error).
 *   - Re-exports state / types for downstream phases (slash dispatcher, tests).
 *
 * ink / ink-markdown are imported dynamically inside `runRepl` so the non-TTY
 * path (`swarm-coder prompt` with piped stdin → JSONL headless) doesn't pay
 * the cost of loading them. `src/cli/main.ts` preserves this by
 * `await import()`-ing this module only on TTY.
 */

import type { AgentEngine, RunConfig } from "../../engine/index.js";
import type { NormalizedEvent, PermissionMode } from "../../core/types.js";
import type { SlashCommandRegistry } from "./state.js";
import type { TokenGetter } from "./status.js";

export {
  createInitialState,
  reduce,
  slashCommandAllowedInState,
  createStubSlashRegistry,
  historyPrev,
  historyNext,
  type ReplState,
  type ReplEvent,
  type TranscriptEntry,
  type PendingPermission,
  type InputBuffer,
  type KeyEvent,
  type SlashCommandRegistry,
} from "./state.js";

export interface RunReplConfig {
  readonly engine: AgentEngine;
  readonly buildRunConfig: (prompt: string) => RunConfig;
  readonly initialPrompt?: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly registry?: SlashCommandRegistry;
  readonly getTokens?: TokenGetter;
}

/**
 * Mount the ink REPL against the current TTY. Resolves once the REPL
 * unmounts (user-initiated exit or engine error).
 */
export async function runRepl(config: RunReplConfig): Promise<void> {
  // Dynamic imports keep ink out of non-TTY paths.
  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("./app.js");

  let unmountResolve: (() => void) | undefined;
  const unmounted = new Promise<void>((resolve) => {
    unmountResolve = resolve;
  });

  // Queue of prompts the user submits. Each prompt drives one engine turn.
  const promptQueue: string[] = [];
  let resolveNext: ((value: string | null) => void) | undefined;

  function enqueuePrompt(line: string): void {
    if (resolveNext !== undefined) {
      const r = resolveNext;
      resolveNext = undefined;
      r(line);
    } else {
      promptQueue.push(line);
    }
  }

  function closeQueue(): void {
    if (resolveNext !== undefined) {
      const r = resolveNext;
      resolveNext = undefined;
      r(null);
    }
  }

  async function nextPrompt(): Promise<string | null> {
    const pending = promptQueue.shift();
    if (pending !== undefined) return pending;
    return new Promise((resolve) => {
      resolveNext = resolve;
    });
  }

  // Multi-turn event loop: each user prompt spawns an engine run, the
  // resulting NormalizedEvent stream is flushed through the UI, then we
  // await the next prompt.
  async function* multiTurnEvents(): AsyncGenerator<NormalizedEvent> {
    if (config.initialPrompt !== undefined && config.initialPrompt.length > 0) {
      const turn = config.engine.run(config.buildRunConfig(config.initialPrompt));
      yield* turn;
    }
    while (true) {
      const prompt = await nextPrompt();
      if (prompt === null) return;
      const turn = config.engine.run(config.buildRunConfig(prompt));
      yield* turn;
    }
  }

  const events = multiTurnEvents();

  const instance = render(
    React.createElement(App, {
      events,
      model: config.model,
      permissionMode: config.permissionMode,
      registry: config.registry,
      getTokens: config.getTokens,
      onExit: () => {
        closeQueue();
        unmountResolve?.();
      },
      onSubmit: (line) => {
        enqueuePrompt(line);
      },
    }),
  );

  // Ink's waitUntilExit resolves when `ink.exit()` is called.
  await Promise.race([instance.waitUntilExit(), unmounted]);
  closeQueue();
}
