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
import { Footer } from "./footer.js";
import { Spinner } from "./spinner.js";
import { Dropdown } from "./dropdown.js";
import { ApprovalPanel } from "./approval-panel.js";
import { MessageQueue } from "./message-queue.js";
import { AgentTree } from "./views/agent-tree.js";
import { TaskBoard } from "./views/task-board.js";
import { extractMentionPrefix, getFileCandidates, applyMention } from "./file-mention.js";
import { dispatchSlashLine } from "../../cli/slash/dispatcher.js";
import { loadHistory, appendHistoryEntry } from "../history.js";
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

  // Stage A — load persistent history from disk and hydrate the store.
  // Guard against empty results: dispatching {history: []} into the initial
  // empty-state forces a no-op re-render that breaks downstream e2e tests
  // by shifting render timing. Skip the dispatch when there's nothing new.
  // (Specific regression: e2e.test.tsx "assistant markdown renders" — Phase
  // 3 markdown e2e dropped the assistant entry from the captured frame when
  // an empty hydrate-history landed between submit and text_delta.)
  onMount(() => {
    try {
      const loaded = loadHistory();
      if (loaded.length > 0) {
        dispatch({ type: "hydrate-history", history: loaded });
      }
    } catch (err) {
      process.stderr.write(`swarm-harness: failed to load history: ${err}\n`);
    }
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

  // Phase 3 — auto-dequeue: when state returns to idle with queued messages,
  // pop the first message and submit it as the next turn.
  createEffect(() => {
    if (state.name === "idle" && state.messageQueue.length > 0) {
      const next = state.messageQueue[0];
      untrack(() => {
        dispatch({ type: "dequeue-message" });
        dispatch({ type: "submit", text: next });
        props.onSubmit?.(next);
      });
    }
  });

  const handleSubmit = (line: string): void => {
    if (line.length === 0) return;
    // Phase 3: if still streaming, queue instead of submitting now.
    if (state.name === "streaming") {
      dispatch({ type: "queue-message", text: line });
      return;
    }
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
    // Persist before dispatch — history is durable even if dispatch errors.
    try {
      appendHistoryEntry(line);
    } catch (err) {
      process.stderr.write(`swarm-harness: failed to persist history: ${err}\n`);
    }
    dispatch({ type: "submit", text: line });
    props.onSubmit?.(line);
  };

  const getTokens = (): number => props.getTokens?.() ?? 0;

  // Dropdown mode: "slash" for /commands, "mention" for @file mentions, "none" otherwise.
  const dropdownMode = createMemo<"slash" | "mention" | "none">(() => {
    const value = state.input.value;
    if (value.startsWith("/") && props.registry !== undefined) return "slash";
    const mentionPrefix = extractMentionPrefix(value, state.input.cursor);
    if (mentionPrefix !== undefined) return "mention";
    return "none";
  });

  const dropdownCandidates = createMemo<
    ReadonlyArray<{ name: string; description: string }>
  >(() => {
    const mode = dropdownMode();
    if (mode === "slash") {
      const registry = props.registry!;
      const prefix = state.input.value.slice(1).toLowerCase();
      return registry
        .list()
        .filter((c) => c.name.toLowerCase().startsWith(prefix));
    }
    if (mode === "mention") {
      const prefix = extractMentionPrefix(state.input.value, state.input.cursor) ?? "";
      return getFileCandidates(prefix);
    }
    return [];
  });

  const dropdownSelectedIndex = createMemo(() => {
    const len = dropdownCandidates().length;
    if (len === 0) return 0;
    return Math.min(state.dropdownIndex, len - 1);
  });

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
    // Ctrl-S "steering": send the current input as a follow-up message
    // without aborting the current turn. The wrapping runRepl loop queues
    // it for the next turn boundary; the reducer adds a visible
    // "(steered)" transcript entry now so the user sees their input was
    // captured. Only meaningful while a turn is in flight.
    if (
      key.ctrl === true &&
      key.name === "s" &&
      state.name === "streaming"
    ) {
      const text = state.input.value;
      if (text.length > 0) {
        dispatch({ type: "steer", text });
        props.onSubmit?.(text);
      }
      return;
    }
    // Ctrl+O: toggle tool output expand/collapse.
    if (key.ctrl === true && key.name === "o") {
      dispatch({ type: "toggle-expand" });
      return;
    }
    // Shift+Tab: toggle plan mode.
    if (key.shift === true && (key.name === "tab" || key.printable === "\t")) {
      dispatch({ type: "toggle-plan-mode" });
      return;
    }
    // Phase 5 view switching: Ctrl+A → agents, Ctrl+T → tasks, Esc → transcript.
    if (key.name === "escape" && state.activeView !== "transcript") {
      dispatch({ type: "set-view", view: "transcript" });
      return;
    }
    if (key.ctrl === true && key.name === "a") {
      dispatch({ type: "set-view", view: "agents" });
      return;
    }
    if (key.ctrl === true && key.name === "t") {
      dispatch({ type: "set-view", view: "tasks" });
      return;
    }
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
      // Tab → accept current selection.
      if (key.name === "tab" || key.printable === "\t") {
        const idx = dropdownSelectedIndex();
        const chosen = candidates[idx];
        if (chosen !== undefined) {
          const mode = dropdownMode();
          if (mode === "mention") {
            const result = applyMention(state.input.value, state.input.cursor, chosen.name);
            dispatch({ type: "input-changed", value: result.value, cursor: result.cursor });
            dispatch({ type: "add-mentioned-file", filePath: chosen.name });
          } else {
            dispatch({ type: "dropdown-accept", value: `/${chosen.name}` });
          }
        }
        return;
      }
    }
    dispatch({ type: "key", key });
  };

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexGrow={1} height={state.activeView === "transcript" ? undefined : 0}>
        {state.activeView === "transcript" ? (
          <Transcript
            entries={state.transcript}
            streamingEntryId={state.streamingEntryId}
            toolCalls={state.toolCalls}
            globalExpand={state.globalExpand}
          />
        ) : <text />}
      </box>
      <box flexGrow={1} height={state.activeView === "agents" ? undefined : 0}>
        {state.activeView === "agents" ? (
          <AgentTree agents={state.agents} />
        ) : <text />}
      </box>
      <box flexGrow={1} height={state.activeView === "tasks" ? undefined : 0}>
        {state.activeView === "tasks" ? (
          <TaskBoard tasks={state.tasks} />
        ) : <text />}
      </box>
      <Show when={state.name === "streaming"}>
        <Spinner />
      </Show>
      <Show
        when={
          state.name === "awaiting-permission" &&
          state.pendingPermission !== undefined
        }
      >
        <ApprovalPanel pending={state.pendingPermission!} />
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
      <Show when={state.messageQueue.length > 0}>
        <MessageQueue messages={state.messageQueue} />
      </Show>
      <Show when={dropdownCandidates().length > 1}>
        <Dropdown
          candidates={dropdownCandidates()}
          selectedIndex={dropdownSelectedIndex()}
        />
      </Show>
      <Footer state={state} model={props.model} getTokens={getTokens} />
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
      return [{ type: "tool-start", id: evt.id, name: evt.name }];
    case "tool_use_input":
      return [{ type: "tool-args-delta", id: evt.id, jsonDelta: evt.jsonDelta }];
    case "tool_use_end":
      return [];
    case "tool_result":
      return [
        {
          type: "tool-result",
          id: evt.toolUseId,
          content: evt.content,
          isError: evt.isError,
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
    case "info":
      return [];
    case "retry":
      return [
        {
          type: "system-entry",
          id: `retry-${Date.now()}`,
          text: `retrying (${evt.attempt}/${evt.maxRetries})…`,
        },
      ];
    case "agent_spawned":
      return [
        {
          type: "agent-spawned",
          id: evt.agentId,
          name: evt.name,
          role: evt.role,
          parentId: evt.parentId,
        },
      ];
    case "agent_status":
      return [
        {
          type: "agent-status",
          id: evt.agentId,
          phase: evt.phase,
          toolCount: evt.toolCount,
          tokenUsage: evt.tokenUsage,
        },
      ];
    case "task_update":
      return [
        {
          type: "task-update",
          id: evt.taskId,
          title: evt.title,
          status: evt.status,
          assignee: evt.assignee,
        },
      ];
  }
}

// Avoid unused-import errors when SlashCommandRegistry isn't referenced at
// runtime (it's only used as a type via AppProps).
export type { SlashCommandRegistry };
