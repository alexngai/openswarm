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

import { Show, onMount, onCleanup, createEffect, createMemo, untrack } from "solid-js";
import { createReplStore } from "./store.js";
import { Transcript } from "./transcript.js";
import { Input } from "./input.js";
import { Status } from "./status.js";
import { Spinner } from "./spinner.js";
import { Dropdown } from "./dropdown.js";
import { PermissionPrompt } from "./permission-prompt.js";
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

  // Phase 2 — attach the permission bridge's dispatch so `canUseTool` can
  // drive the state machine when it needs to prompt. Detach on unmount so
  // the bridge doesn't hold a stale reference to a dead store.
  onMount(() => {
    props.permissionBridge?.attachDispatch(dispatch);
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

  // Dropdown candidates — visible only when input starts with "/" and a
  // registry is available. Filter by the prefix after "/".
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

  // Effective dropdown selection: store index, clamped to the current
  // candidates length. If candidates shrink past the store index, we clamp
  // here so the render is consistent; the next arrow key will catch up.
  const dropdownSelectedIndex = createMemo(() => {
    const len = dropdownCandidates().length;
    if (len === 0) return 0;
    return Math.min(state.dropdownIndex, len - 1);
  });

  // When the dropdown becomes inactive (no "/" prefix or no matches), reset
  // the store index so the next activation starts at 0.
  createEffect(() => {
    if (dropdownCandidates().length === 0) {
      untrack(() => {
        if (state.dropdownIndex !== 0) {
          dispatch({ type: "dropdown-reset" });
        }
      });
    }
  });

  // Phase 2 — when awaiting a permission decision, the prompt owns keystrokes.
  // y / Y              → approve
  // Enter / n / N / Esc → deny (matches claw's default-deny semantics)
  // Ctrl-C             → deny (claw `main.rs:7406-7408` — stdin read error
  //                      becomes Deny; engine continues to the next tool)
  // Everything else is swallowed so the input buffer can't mutate.
  const respondPermission = (allow: boolean): void => {
    const pending = state.pendingPermission;
    const bridge = props.permissionBridge;
    if (pending === undefined || bridge === undefined) return;
    bridge.respond(
      allow
        ? { allow: true }
        : {
            allow: false,
            reason: `user denied ${pending.toolName} via y/N prompt`,
          },
    );
  };

  // Keypress routing: when the dropdown is active, arrow-up/down navigate
  // candidates instead of reaching the reducer's history motion. Tab
  // auto-completes the current selection into the input buffer. All other
  // keys fall through to the reducer (which handles Emacs bindings,
  // history, backspace, etc.).
  const handleKey = (key: import("../repl/state.js").KeyEvent): void => {
    if (state.name === "awaiting-permission") {
      if (key.ctrl === true && key.name === "c") {
        respondPermission(false);
        return;
      }
      if (key.return === true) {
        respondPermission(false);
        return;
      }
      const ch = key.printable ?? "";
      if (ch === "y" || ch === "Y") {
        respondPermission(true);
        return;
      }
      if (ch === "n" || ch === "N" || key.name === "escape") {
        respondPermission(false);
        return;
      }
      // Swallow everything else — input buffer must not mutate during prompt.
      return;
    }
    const candidates = dropdownCandidates();
    const dropdownActive = candidates.length > 0;
    if (dropdownActive) {
      if (key.upArrow === true) {
        dispatch({ type: "dropdown-up" });
        return;
      }
      if (key.downArrow === true) {
        // Clamp to the current candidate length at dispatch time so
        // repeated down-arrow never rolls past the end.
        const nextIdx = state.dropdownIndex + 1;
        if (nextIdx < candidates.length) {
          dispatch({ type: "dropdown-down" });
        }
        return;
      }
      // Tab → accept current selection. Lookup via the clamped index.
      if (key.name === "tab" || key.printable === "\t") {
        const idx = dropdownSelectedIndex();
        const chosen = candidates[idx];
        if (chosen !== undefined) {
          dispatch({ type: "dropdown-accept", value: `/${chosen.name}` });
        }
        return;
      }
    }
    dispatch({ type: "key", key });
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <Transcript entries={state.transcript} />
      <Show when={state.name === "streaming"}>
        <Spinner />
      </Show>
      <Show
        when={
          state.name === "awaiting-permission" &&
          state.pendingPermission !== undefined
        }
      >
        <PermissionPrompt pending={state.pendingPermission!} />
      </Show>
      <Show when={state.name !== "shutdown"}>
        <Input
          value={state.input.value}
          onChange={(value, cursor) =>
            dispatch({ type: "input-changed", value, cursor })
          }
          onSubmit={handleSubmit}
          onKey={handleKey}
          disabled={
            state.name === "compact" || state.name === "awaiting-permission"
          }
        />
      </Show>
      <Show when={dropdownCandidates().length > 1}>
        <Dropdown
          candidates={dropdownCandidates()}
          selectedIndex={dropdownSelectedIndex()}
        />
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
