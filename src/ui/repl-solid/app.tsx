/**
 * app.tsx — Solid root for the OpenTUI REPL.
 *
 * Phase 0b composition: wires Transcript, Input, Status, Spinner together,
 * drives the store from engine events, handles SIGINT → shutdown. API shape
 * mirrors the Ink `App` in ../repl/app.tsx so src/cli.ts can swap the mount
 * point in Phase 0c with a minimal change.
 *
 * Intentionally scoped: slash-command dispatch + dropdown wiring are deferred
 * to Phase 0c when cli.ts integration decides the slash pipeline shape. The
 * Dropdown component exists and is tested; it's just not composed here yet.
 */

import { Show, onMount, onCleanup, createEffect } from "solid-js";
import { createReplStore } from "./store.js";
import { Transcript } from "./transcript.js";
import { Input } from "./input.js";
import { Status } from "./status.js";
import { Spinner } from "./spinner.js";
import type { NormalizedEvent, PermissionMode } from "../../core/types.js";
import type { ReplEvent } from "../repl/state.js";

export interface AppProps {
  readonly events: AsyncIterable<NormalizedEvent>;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly getTokens?: () => number;
  /** Called when the REPL transitions to shutdown (e.g. SIGINT, /exit). */
  readonly onExit?: () => void;
  /** Called when the user submits a non-slash prompt — triggers the next engine turn. */
  readonly onSubmit?: (line: string) => void;
}

export function App(props: AppProps) {
  const { state, dispatch } = createReplStore({
    permissionMode: props.permissionMode,
  });

  // Engine event pump — drains the async iterable and translates events into
  // reducer actions. Runs once on mount; cancels on unmount.
  onMount(() => {
    let cancelled = false;
    const pump = async (): Promise<void> => {
      try {
        for await (const evt of props.events) {
          if (cancelled) break;
          for (const action of translateEngineEvent(evt)) {
            dispatch(action);
          }
        }
      } catch {
        // Iterator-level throws are rare; engine errors surface via the
        // `error` NormalizedEvent and are translated above.
      }
    };
    void pump();
    onCleanup(() => {
      cancelled = true;
    });
  });

  // SIGINT → shutdown. Dispatch the state transition; caller's onExit runs
  // when state.name settles on "shutdown" (effect below).
  onMount(() => {
    const onSigInt = (): void => {
      dispatch({ type: "shutdown" });
    };
    process.once("SIGINT", onSigInt);
    onCleanup(() => {
      process.off("SIGINT", onSigInt);
    });
  });

  // Shutdown watcher — notify the outer caller once the state machine
  // reaches terminal. Caller is responsible for tearing down the renderer.
  createEffect(() => {
    if (state.name === "shutdown") {
      props.onExit?.();
    }
  });

  const handleSubmit = (line: string): void => {
    if (line.length === 0) return;
    dispatch({ type: "submit", text: line });
    props.onSubmit?.(line);
  };

  const getTokens = (): number => props.getTokens?.() ?? 0;

  return (
    <box flexDirection="column" flexGrow={1}>
      <Transcript entries={state.transcript} />
      <Show when={state.name === "streaming"}>
        <Spinner />
      </Show>
      <Show when={state.name !== "shutdown"}>
        <Input
          value={state.input.value}
          onChange={(value, cursor) =>
            dispatch({ type: "input-changed", value, cursor })
          }
          onSubmit={handleSubmit}
          onKey={(key) => dispatch({ type: "key", key })}
          disabled={state.name === "compact"}
        />
      </Show>
      <Status state={state} model={props.model} getTokens={getTokens} />
    </box>
  );
}

// ---------------------------------------------------------------------------
// Engine event → reducer actions
// ---------------------------------------------------------------------------

/**
 * Port of translateEngineEvent from src/ui/repl/app.tsx. Kept in sync with
 * the Ink version until Phase 0d removes Ink; then the canonical path is
 * this file and the Ink one is deleted.
 */
export function translateEngineEvent(evt: NormalizedEvent): ReplEvent[] {
  switch (evt.type) {
    case "text_delta":
      return [{ type: "stream-delta", text: evt.text }];
    case "tool_use_start":
      return [{ type: "tool-entry", id: evt.id, name: evt.name }];
    case "tool_use_input":
    case "tool_use_end":
      return [];
    case "tool_result":
      return [
        {
          type: "system-entry",
          id: `tr-${evt.toolUseId}`,
          text: evt.isError
            ? `tool error: ${evt.content.slice(0, 120)}`
            : `tool ok: ${evt.content.slice(0, 120).split("\n")[0] ?? ""}`,
        },
      ];
    case "message_stop":
      return [{ type: "stream-end" }];
    case "error":
      return [
        {
          type: "system-entry",
          id: `err-${Date.now()}`,
          text: `error: ${evt.error.message}`,
        },
        { type: "stream-end" },
      ];
    case "hook_event":
      return [
        {
          type: "system-entry",
          id: `hook-${evt.payload.hookId}-${evt.payload.subtype}`,
          text: `hook ${evt.payload.hookName} (${evt.payload.event}) ${evt.payload.subtype}`,
        },
      ];
    case "compaction": {
      const actions: ReplEvent[] = [];
      if (evt.payload.phase === "begin") {
        actions.push({
          type: "system-entry",
          id: `compaction-${Date.now()}`,
          text: `[compaction: ${evt.payload.trigger}]`,
        });
        actions.push({ type: "compact-begin" });
      } else {
        actions.push({ type: "compact-end" });
      }
      return actions;
    }
    case "cache_hit":
    case "cache_miss":
      return [];
  }
}
