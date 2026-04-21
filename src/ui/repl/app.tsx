/**
 * app.tsx — root <App> component for the interactive REPL.
 *
 * Responsibilities:
 *   - Own the reducer state (React useReducer).
 *   - Consume engine events (an AsyncIterable of NormalizedEvent) and dispatch
 *     matching reducer actions.
 *   - Render the transcript, input, status bar.
 *   - Handle Ctrl+C / SIGINT → shutdown → unmount.
 *
 * Phase 2 scope: wire text_delta / tool_use / message_stop / hook_event to
 * transcript + state transitions. Permission flow is stubbed: when a pending
 * permission request arrives, the status bar shows it and the user is
 * expected to type `/approve` or `/deny` (dispatcher comes in Phase 3).
 * Compaction hooks into `compact-begin`/`compact-end` reducer events — the
 * engine will emit a compaction variant in a later phase; until then the
 * reducer accepts the events for future wiring.
 */

import React, { useEffect, useReducer, useRef } from "react";
import { Box, useApp } from "ink";
import type { NormalizedEvent } from "../../core/types.js";
import type { PermissionMode } from "../../core/types.js";
import {
  createInitialState,
  reduce,
  createStubSlashRegistry,
  type ReplEvent,
} from "./state.js";
import { Transcript } from "./transcript.js";
import { Input } from "./input.js";
import { Status, type TokenGetter } from "./status.js";
import { dispatchSlashLine } from "../../cli/slash/dispatcher.js";
import type {
  BuildDefaultRegistryDeps,
  SlashCommandRegistry,
} from "../../cli/slash/index.js";

export interface AppProps {
  readonly events: AsyncIterable<NormalizedEvent>;
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly registry?: SlashCommandRegistry;
  readonly getTokens?: TokenGetter;
  /** Deps threaded through the slash dispatcher into each SlashCommandContext. */
  readonly slashDeps?: BuildDefaultRegistryDeps;
  /** Called when the REPL should shut down (e.g. user typed /exit). */
  readonly onExit?: () => void;
  /** Called when the user submits a non-slash prompt — triggers the next engine turn. */
  readonly onSubmit?: (line: string) => void;
}

export function App(props: AppProps): React.ReactElement {
  const registry = props.registry ?? createStubSlashRegistry();
  const getTokens = props.getTokens ?? (() => 0);
  const [state, dispatch] = useReducer(reduce, undefined, () =>
    createInitialState({ permissionMode: props.permissionMode }),
  );
  const ink = useApp();
  const eventsRef = useRef<AsyncIterable<NormalizedEvent>>(props.events);

  // Drive the reducer from engine events.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        for await (const evt of eventsRef.current) {
          if (cancelled) break;
          for (const action of translateEngineEvent(evt)) {
            dispatch(action);
          }
        }
      } catch {
        // Swallow — ClaudeAgentSdkEngine already surfaces errors via the
        // `error` NormalizedEvent. Iterator-level throws are extremely rare
        // and shouldn't crash the REPL.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Handle Ctrl+C / SIGINT → graceful shutdown.
  useEffect(() => {
    const onSigInt = () => {
      dispatch({ type: "shutdown" });
      setTimeout(() => ink.exit(), 50);
    };
    process.once("SIGINT", onSigInt);
    return () => {
      process.off("SIGINT", onSigInt);
    };
  }, [ink]);

  // Unmount once the state machine reaches shutdown.
  useEffect(() => {
    if (state.name === "shutdown") {
      props.onExit?.();
      setTimeout(() => ink.exit(), 20);
    }
  }, [state.name, ink]);

  const stateRef = useRef(state);
  stateRef.current = state;

  const onSubmit = (line: string): void => {
    if (line.length === 0) return;
    if (line.startsWith("/")) {
      // Phase 3: dispatch through the real registry.
      void (async () => {
        const result = await dispatchSlashLine(
          line,
          stateRef.current,
          registry,
          props.slashDeps ?? {},
        );
        applySlashResult(result, dispatch, ink, props.onSubmit);
      })();
      return;
    }
    // Normal prompt — append to transcript and transition to streaming.
    dispatch({ type: "submit", text: line });
    props.onSubmit?.(line);
  };

  return (
    <Box flexDirection="column">
      <Transcript entries={state.transcript} />
      {state.name !== "shutdown" ? (
        <Input
          state={state}
          registry={registry}
          onKey={(key) => dispatch({ type: "key", key })}
          onSubmit={onSubmit}
          disabled={state.name === "compact"}
        />
      ) : null}
      <Status state={state} model={props.model} getTokens={getTokens} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Engine event → reducer actions
// ---------------------------------------------------------------------------

/**
 * Map a single NormalizedEvent to zero-or-more ReplEvents. Exported for
 * testability from state.test.ts (not currently exercised but kept public
 * for future integration tests in Phase 10).
 */
export function translateEngineEvent(evt: NormalizedEvent): ReplEvent[] {
  switch (evt.type) {
    case "text_delta":
      return [{ type: "stream-delta", text: evt.text }];
    case "tool_use_start":
      return [
        {
          type: "tool-entry",
          id: evt.id,
          name: evt.name,
        },
      ];
    case "tool_use_input":
    case "tool_use_end":
      return [];
    case "tool_result":
      // Surface a compact line so the user sees tool completion.
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
  }
}

// ---------------------------------------------------------------------------
// Slash result → reducer event / transcript / engine hint
// ---------------------------------------------------------------------------

let slashSeq = 0;

/**
 * Translate a `SlashCommandResult` into reducer dispatches + optional
 * `onSubmit` callback (for engine-hint prompts). Exported for tests.
 */
export function applySlashResult(
  result: import("../../cli/slash/index.js").SlashCommandResult,
  dispatch: (e: ReplEvent) => void,
  ink: ReturnType<typeof useApp>,
  onSubmit?: (line: string) => void,
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
      // /exit result surfaces as a shutdown reducer event — unmount ink.
      if (result.event.type === "shutdown") {
        setTimeout(() => ink.exit(), 20);
      }
      return;
    case "engine-hint":
      // Inject the hint as if the user had typed it — triggers a turn.
      dispatch({ type: "submit", text: result.prompt });
      onSubmit?.(result.prompt);
      return;
    case "ok":
      return;
  }
}
