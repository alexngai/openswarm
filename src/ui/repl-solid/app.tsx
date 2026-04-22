/**
 * app.tsx — Solid root for the OpenTUI REPL.
 *
 * Composes Transcript, Input, Status, Spinner, Dropdown. Drives the store
 * from engine events; handles SIGINT → shutdown; routes slash-prefixed
 * submits through the existing `dispatchSlashLine` pipeline and applies
 * the resulting `SlashCommandResult` back into the store.
 *
 * Phase 0c.5 change: slash-command dispatch + dropdown wiring landed.
 * Dropdown shows filtered candidates when input starts with "/". Enter
 * submits the current input as-is (no tab-autocomplete yet; that can
 * come later).
 */

import { Show, onMount, onCleanup, createEffect, createMemo } from "solid-js";
import { createReplStore } from "./store.js";
import { Transcript } from "./transcript.js";
import { Input } from "./input.js";
import { Status } from "./status.js";
import { Spinner } from "./spinner.js";
import { Dropdown } from "./dropdown.js";
import { dispatchSlashLine } from "../../cli/slash/dispatcher.js";
import type {
  SlashCommandResult,
  SlashCommandRegistry,
} from "../../cli/slash/index.js";
import type { NormalizedEvent } from "../../core/types.js";
import type { ReplEvent } from "../repl/state.js";
import type { AppProps } from "./types.js";

export type { AppProps };

let slashSeq = 0;

export function App(props: AppProps) {
  const { state, dispatch } = createReplStore({
    permissionMode: props.permissionMode,
  });

  // Engine event pump.
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
        // Engine errors arrive via the `error` NormalizedEvent and are
        // translated above; iterator-level throws are rare.
      }
    };
    void pump();
    onCleanup(() => {
      cancelled = true;
    });
  });

  // SIGINT → shutdown.
  onMount(() => {
    const onSigInt = (): void => {
      dispatch({ type: "shutdown" });
    };
    process.once("SIGINT", onSigInt);
    onCleanup(() => {
      process.off("SIGINT", onSigInt);
    });
  });

  // Shutdown watcher.
  createEffect(() => {
    if (state.name === "shutdown") {
      props.onExit?.();
    }
  });

  const handleSubmit = (line: string): void => {
    if (line.length === 0) return;
    if (line.startsWith("/") && props.registry !== undefined) {
      const registry = props.registry;
      void (async () => {
        const result = await dispatchSlashLine(
          line,
          state,
          registry,
          props.slashDeps ?? {},
        );
        applySlashResult(result, dispatch, props.onSubmit, props.onSessionId);
      })();
      return;
    }
    dispatch({ type: "submit", text: line });
    props.onSubmit?.(line);
  };

  const getTokens = (): number => props.getTokens?.() ?? 0;

  // Dropdown candidates — non-empty and visible only when input starts with
  // "/" and a registry is available. Filter registry entries by the prefix
  // after "/".
  const dropdownCandidates = createMemo<
    ReadonlyArray<{ name: string; description: string }>
  >(() => {
    const registry = props.registry;
    if (registry === undefined) return [];
    const value = state.input.value;
    if (!value.startsWith("/")) return [];
    const prefix = value.slice(1).toLowerCase();
    return registry
      .list()
      .filter((c) => c.name.toLowerCase().startsWith(prefix));
  });

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
      <Show when={dropdownCandidates().length > 1}>
        <Dropdown candidates={dropdownCandidates()} selectedIndex={0} />
      </Show>
      <Status state={state} model={props.model} getTokens={getTokens} />
    </box>
  );
}

// ---------------------------------------------------------------------------
// Slash result → store dispatch
// ---------------------------------------------------------------------------

/**
 * Port of `applySlashResult` from src/ui/repl/app.tsx. Translates a
 * SlashCommandResult into store dispatches + optional onSubmit/onSessionId
 * callbacks. No Ink-specific API (no `ink.exit()` — shutdown propagates via
 * the reducer-event variant and App's onExit effect).
 */
function applySlashResult(
  result: SlashCommandResult,
  dispatch: (e: ReplEvent) => void,
  onSubmit?: (line: string) => void,
  onSessionId?: (sessionId: string) => void,
): void {
  slashSeq += 1;
  switch (result.kind) {
    case "message":
      dispatch({
        type: "system-entry",
        id: `slash-msg-${slashSeq}`,
        text: result.text,
      });
      return;
    case "error":
      dispatch({
        type: "system-entry",
        id: `slash-err-${slashSeq}`,
        text: `error: ${result.message}`,
      });
      return;
    case "reducer-event":
      dispatch(result.event);
      if (result.event.type === "session-id") {
        onSessionId?.(result.event.sessionId);
      }
      // /exit → reducer-event: { type: "shutdown" }. App's effect on
      // state.name === "shutdown" calls props.onExit, so no explicit call
      // needed here.
      return;
    case "engine-hint":
      dispatch({ type: "submit", text: result.prompt });
      onSubmit?.(result.prompt);
      return;
    case "ok":
      return;
  }
}

// ---------------------------------------------------------------------------
// Engine event → reducer actions
// ---------------------------------------------------------------------------

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

// Avoid unused-import errors when SlashCommandRegistry isn't referenced at
// runtime (it's only used as a type via AppProps).
export type { SlashCommandRegistry };
