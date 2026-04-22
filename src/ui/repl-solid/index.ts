/**
 * index.ts — OpenTUI/Solid REPL entry point.
 *
 * Public surface mirrors `src/ui/repl/index.ts` (Ink version):
 *   - `runRepl(config)` — mount the Solid <App> against a TTY and resolve
 *     when the user exits.
 *
 * Phase 0c wires this into `src/cli/main.ts` behind a runtime check:
 * Bun → Solid, Node → Ink. Phase 0d deletes the Ink path once stable.
 *
 * Kept JSX-free so main tsc can compile it with react-jsx without touching
 * Solid semantics. The JSX call lives in `./mount.tsx`.
 *
 * Deferred (see docs/16-parity-plan.md Phase 0 follow-ups):
 *   - Slash-command registry + dropdown wiring
 *   - onSessionId callback (coupled to /resume)
 *   Those config fields are accepted for API parity but currently no-op.
 */

import type { AgentEngine, RunConfig } from "../../engine/index.js";
import type { NormalizedEvent, PermissionMode } from "../../core/types.js";
import type { SlashCommandRegistry } from "../repl/state.js";
import {
  buildDefaultRegistry,
  type BuildDefaultRegistryDeps,
} from "../../cli/slash/index.js";

/** Getter returning the current session's token count. */
export type TokenGetter = () => number;

export interface RunReplConfig {
  readonly engine: AgentEngine;
  readonly buildRunConfig: (prompt: string) => RunConfig;
  readonly initialPrompt?: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly registry?: SlashCommandRegistry;
  readonly getTokens?: TokenGetter;
  readonly slashDeps?: BuildDefaultRegistryDeps;
  readonly onSessionId?: (sessionId: string) => void;
}

/**
 * Mount the OpenTUI/Solid REPL. Resolves once App transitions to shutdown
 * (user typed /exit, Ctrl-C, or engine error propagated through App).
 */
export async function runRepl(config: RunReplConfig): Promise<void> {
  // Variable-path dynamic import erases tsc's module resolution so main tsc
  // (jsx: "react-jsx") never tries to follow through into Solid JSX files.
  // Bun resolves this at runtime just like a static import.
  const mountPath = "./mount.js";
  const mountModule = (await import(mountPath)) as {
    mountSolidRender: (props: {
      events: AsyncIterable<NormalizedEvent>;
      model: string;
      permissionMode: PermissionMode;
      getTokens?: () => number;
      onExit?: () => void;
      onSubmit?: (line: string) => void;
      registry?: SlashCommandRegistry;
      slashDeps?: BuildDefaultRegistryDeps;
      onSessionId?: (sessionId: string) => void;
    }) => Promise<void>;
  };
  const { mountSolidRender } = mountModule;

  const registry =
    config.registry ?? buildDefaultRegistry(config.slashDeps ?? {});

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

  async function* multiTurnEvents(): AsyncGenerator<NormalizedEvent> {
    if (
      config.initialPrompt !== undefined &&
      config.initialPrompt.length > 0
    ) {
      const turn = config.engine.run(
        config.buildRunConfig(config.initialPrompt),
      );
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

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      closeQueue();
      resolve();
    };
    mountSolidRender({
      events,
      model: config.model,
      permissionMode: config.permissionMode,
      getTokens: config.getTokens,
      onExit: finish,
      onSubmit: (line: string) => enqueuePrompt(line),
      registry,
      slashDeps: config.slashDeps,
      onSessionId: config.onSessionId,
    }).catch((err: unknown) => {
      if (!finished) {
        finished = true;
        closeQueue();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
