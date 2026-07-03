/**
 * index.ts — OpenTUI/Solid REPL entry point (the only interactive TTY path).
 *
 * `runRepl(config)` mounts the Solid <App> against a TTY and resolves when
 * the user exits. Requires Bun; `src/cli/main.ts` falls back to headless
 * mode on plain Node. (The former Ink renderer is deleted; only the shared
 * reducer in `src/ui/repl/state.ts` survives from it.)
 *
 * Kept JSX-free so main tsc can compile it with react-jsx without touching
 * Solid semantics. The JSX call lives in `./mount.tsx`.
 */

import type { AgentEngine, RunConfig } from "../../engine/index.js";
import type { NormalizedEvent, PermissionMode } from "../../core/types.js";
import type { SlashCommandRegistry } from "../repl/state.js";
import {
  buildDefaultRegistry,
  type BuildDefaultRegistryDeps,
} from "../../cli/slash/index.js";
import type { PermissionBridge } from "../../permissions/bridge.js";
import { mergeTurnWithSwarm, type SwarmEventSource } from "./merge-swarm-events.js";

/** Getter returning the current session's token count. */
export type TokenGetter = () => number;

export interface RunReplConfig {
  readonly engine: AgentEngine;
  readonly buildRunConfig: (prompt: string) => RunConfig | Promise<RunConfig>;
  readonly initialPrompt?: string;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly registry?: SlashCommandRegistry;
  readonly getTokens?: TokenGetter;
  readonly slashDeps?: BuildDefaultRegistryDeps;
  readonly onSessionId?: (sessionId: string) => void;
  /** Phase 2 — approval bridge. See PermissionPrompt + canUseTool wiring. */
  readonly permissionBridge?: PermissionBridge;
  /**
   * Phase 3 B1 — per-turn event-stream wrapper. The CLI supplies the memory
   * observer here (tool tracking, onAfterTurn, onCompaction) without the UI
   * layer depending on the memory system. Must yield events unchanged.
   */
  readonly wrapTurnEvents?: (
    turn: AsyncIterable<NormalizedEvent>,
    turnIndex: number,
  ) => AsyncIterable<NormalizedEvent>;
  /**
   * GitHub #15 — optional live swarm event source. When present, each turn's
   * event stream is merged with `agent_spawned` / `agent_status` /
   * `task_update` NormalizedEvents translated from the orchestrator's swarm
   * lane bus (see src/swarm/swarm-view-events.ts), so the AgentTree (Ctrl+A)
   * and TaskBoard (Ctrl+T) views populate live while a team runs. Omitted for
   * runs with no swarm host.
   */
  readonly swarmEvents?: SwarmEventSource;
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
      permissionBridge?: PermissionBridge;
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

  const wrapTurn = config.wrapTurnEvents ?? ((turn) => turn);

  async function* multiTurnEvents(): AsyncGenerator<NormalizedEvent> {
    let turnIndex = 0;
    if (
      config.initialPrompt !== undefined &&
      config.initialPrompt.length > 0
    ) {
      const turn = config.engine.run(
        await config.buildRunConfig(config.initialPrompt),
      );
      yield* wrapTurn(turn, turnIndex++);
    }
    while (true) {
      const prompt = await nextPrompt();
      if (prompt === null) return;
      const turn = config.engine.run(await config.buildRunConfig(prompt));
      yield* wrapTurn(turn, turnIndex++);
    }
  }

  // Merge swarm view events around the WHOLE multi-turn stream (not per-turn),
  // OUTSIDE wrapTurn so the memory observer only sees real engine events, never
  // the synthetic agent_spawned/agent_status/task_update projections.
  //
  // GitHub #23 — a session-level merge (rather than the former per-turn wrap)
  // means the swarm subscription + its stateful SwarmViewTranslator live for
  // the whole session: long-lived members persist across turns in the view, and
  // events keep flowing while the REPL sits idle between turns (essential for
  // the detached-daemon attach path, whose team runs independently of turns).
  const events =
    config.swarmEvents !== undefined
      ? mergeTurnWithSwarm(multiTurnEvents(), config.swarmEvents)
      : multiTurnEvents();

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
      permissionBridge: config.permissionBridge,
    }).catch((err: unknown) => {
      if (!finished) {
        finished = true;
        closeQueue();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
