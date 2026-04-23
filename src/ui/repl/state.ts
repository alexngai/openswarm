/**
 * state.ts — pure reducer for the ink REPL state machine.
 *
 * No React imports. This file is intentionally decoupled from ink / React so
 * we can unit-test every transition without spinning up a renderer.
 *
 * Transition table (authoritative — docs/10-m2-plan.md Phase 2):
 *
 *   idle                --(input-changed)-----> idle
 *   idle                --(submit)-------------> streaming
 *   streaming           --(stream-delta)-------> streaming
 *   streaming           --(stream-end)---------> idle
 *   streaming           --(permission-request)-> awaiting-permission
 *   awaiting-permission --(permission-response)-> streaming
 *   streaming           --(compact-begin)------> compact
 *   compact             --(compact-end)--------> streaming
 *   any                 --(shutdown)-----------> shutdown
 *   idle                --(clear)--------------> idle   (transcript purged)
 *
 * Per-state slash-command validity (see `slashCommandAllowedInState`):
 *   idle                : all commands
 *   streaming           : only /stop
 *   awaiting-permission : only /stop — y/N decision is a keypress, not a slash
 *                         (doc 17 P2.Q5: `/approve` + `/deny` removed in Phase 2)
 *   compact             : none
 *   shutdown            : none
 */

import type { PermissionMode, RequiredPermission } from "../../core/types.js";

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type ReplStateName =
  | "idle"
  | "streaming"
  | "awaiting-permission"
  | "compact"
  | "shutdown";

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: "user" | "assistant" | "tool" | "system";
  /** Plain text for user/tool/system; streaming-accumulated markdown for assistant. */
  readonly text: string;
  /** Optional tool descriptor for kind === "tool". */
  readonly tool?: { readonly name: string; readonly summary?: string };
}

/**
 * PendingPermission — the payload shown to the user when a tool call needs
 * approval. Phase 2 design lock (doc 17 P2.Q3): no `toolUseId` — claw doesn't
 * capture one and the SDK's CanUseTool callback doesn't pass one. One prompt
 * at a time; there is no concurrent queue to correlate.
 */
export interface PendingPermission {
  readonly toolName: string;
  readonly input: unknown;
  /** The user's active permission mode (what the CLI is running as). */
  readonly currentMode: PermissionMode;
  /** The permission level the tool declared it needs (`read`/`write`/`exec`/`network`). */
  readonly requiredPermission: RequiredPermission;
  /** Reason surfaced by PermissionEngine.check when mode denied (optional). */
  readonly reason?: string;
}

export interface InputBuffer {
  readonly value: string;
  readonly cursor: number;
  /** Emacs kill-ring (most-recent at index 0). */
  readonly killBuffer: string;
}

export interface ReplState {
  readonly name: ReplStateName;
  readonly transcript: readonly TranscriptEntry[];
  readonly input: InputBuffer;
  /** Command history (most-recent-last). */
  readonly history: readonly string[];
  /** Index into history when user is navigating (-1 means "not navigating"). */
  readonly historyIndex: number;
  /** Draft buffer preserved while navigating history. */
  readonly historyDraft: string;
  readonly permissionMode: PermissionMode;
  readonly sessionId: string | undefined;
  readonly pendingPermission: PendingPermission | undefined;
  /** Id of the assistant transcript entry currently being streamed into. */
  readonly streamingEntryId: string | undefined;
  /**
   * Selected candidate index when the slash-command dropdown is visible
   * (input starts with "/"). The Solid app clamps this against the
   * current candidates list at render time — visibility is driven by the
   * candidates count, not this value.
   */
  readonly dropdownIndex: number;
}

// ---------------------------------------------------------------------------
// Event union
// ---------------------------------------------------------------------------

export type ReplEvent =
  // Input editing
  | { readonly type: "input-changed"; readonly value: string; readonly cursor: number }
  | { readonly type: "key"; readonly key: KeyEvent }
  // Turn lifecycle
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "stream-delta"; readonly text: string }
  | { readonly type: "stream-end" }
  // Permission
  | { readonly type: "permission-request"; readonly request: PendingPermission }
  | {
      readonly type: "permission-response";
      readonly decision: "approve" | "deny";
    }
  // Compaction
  | { readonly type: "compact-begin" }
  | { readonly type: "compact-end" }
  // Tool use (added to transcript)
  | {
      readonly type: "tool-entry";
      readonly id: string;
      readonly name: string;
      readonly summary?: string;
    }
  // System / hook message
  | { readonly type: "system-entry"; readonly id: string; readonly text: string }
  // Dropdown navigation (slash-command autocomplete)
  | { readonly type: "dropdown-up" }
  | { readonly type: "dropdown-down" }
  | { readonly type: "dropdown-reset" }
  | { readonly type: "dropdown-accept"; readonly value: string }
  // Misc controls
  | { readonly type: "clear" }
  | { readonly type: "shutdown" }
  | { readonly type: "session-id"; readonly sessionId: string };

/**
 * Key event shape — mirrors ink's `useInput` callback arguments so the
 * app layer can funnel ink keypresses straight into the reducer.
 */
export interface KeyEvent {
  readonly name?: string; // "a", "e", "k", "u", "w", "left", "right", ...
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly printable?: string;
  readonly home?: boolean;
  readonly end?: boolean;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export interface InitialStateOptions {
  readonly permissionMode?: PermissionMode;
  readonly sessionId?: string;
}

export function createInitialState(opts?: InitialStateOptions): ReplState {
  return {
    name: "idle",
    transcript: [],
    input: { value: "", cursor: 0, killBuffer: "" },
    history: [],
    historyIndex: -1,
    historyDraft: "",
    permissionMode: opts?.permissionMode ?? "workspace-write",
    sessionId: opts?.sessionId,
    pendingPermission: undefined,
    streamingEntryId: undefined,
    dropdownIndex: 0,
  };
}

// ---------------------------------------------------------------------------
// Slash command registry (stub)
// ---------------------------------------------------------------------------

/**
 * Canonical registry type lives in `src/cli/slash/index.ts`. We re-export
 * it as a type here so state.ts consumers don't need to cross-module the
 * slash layer directly. The cycle is type-only (erased at runtime).
 */
export type SlashCommandRegistry =
  import("../../cli/slash/index.js").SlashCommandRegistry;

interface StubCommand {
  readonly name: string;
  readonly description: string;
  readonly execute: () => { readonly kind: "ok" };
}

const STUB_COMMANDS: ReadonlyArray<StubCommand> = [
  { name: "help", description: "Show available commands", execute: () => ({ kind: "ok" }) },
  { name: "exit", description: "Exit the REPL", execute: () => ({ kind: "ok" }) },
  { name: "clear", description: "Clear the transcript", execute: () => ({ kind: "ok" }) },
  { name: "status", description: "Show session status", execute: () => ({ kind: "ok" }) },
];

/**
 * Minimal fallback registry. The canonical path is
 * `buildDefaultRegistry(deps)` from `src/cli/slash/index.ts`, which returns
 * the full 14-command registry. This stub is kept only so tests and the
 * REPL can render without wiring the full dependency graph.
 */
export function createStubSlashRegistry(): SlashCommandRegistry {
  return {
    list: () =>
      STUB_COMMANDS.map((c) => ({ name: c.name, description: c.description })),
    get: (name: string) => STUB_COMMANDS.find((c) => c.name === name),
  };
}

/**
 * Per-state slash-command validity. Commands are looked up by their bare name
 * (no leading slash). Reducer never calls this directly — the dispatcher does.
 */
export function slashCommandAllowedInState(
  state: ReplState,
  command: string,
): boolean {
  switch (state.name) {
    case "idle":
      return true;
    case "streaming":
      return command === "stop";
    case "awaiting-permission":
      // Phase 2: approve/deny are keypresses (y/Enter), not slash commands.
      // /stop still needed to cancel mid-prompt.
      return command === "stop";
    case "compact":
      return false;
    case "shutdown":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function reduce(state: ReplState, event: ReplEvent): ReplState {
  // Terminal: shutdown absorbs everything.
  if (state.name === "shutdown") {
    return state;
  }

  switch (event.type) {
    case "shutdown":
      return { ...state, name: "shutdown" };

    case "session-id":
      return { ...state, sessionId: event.sessionId };

    case "input-changed":
      return {
        ...state,
        input: { ...state.input, value: event.value, cursor: event.cursor },
      };

    case "key":
      return applyKey(state, event.key);

    case "submit": {
      // Only valid from idle (or re-submit during awaiting-permission is
      // intentionally blocked — user must answer the y/N prompt or /stop).
      if (state.name !== "idle") return state;
      const text = event.text;
      const entryId = `u-${state.transcript.length}`;
      const assistantId = `a-${state.transcript.length + 1}`;
      const nextHistory = text.length > 0 ? [...state.history, text] : state.history;
      return {
        ...state,
        name: "streaming",
        transcript: [
          ...state.transcript,
          { id: entryId, kind: "user", text },
        ],
        input: { value: "", cursor: 0, killBuffer: state.input.killBuffer },
        history: nextHistory,
        historyIndex: -1,
        historyDraft: "",
        streamingEntryId: assistantId,
      };
    }

    case "stream-delta": {
      if (state.name !== "streaming") return state;
      const streamingId = state.streamingEntryId;
      // First delta of a turn: allocate the assistant transcript entry.
      if (streamingId === undefined) return state;
      const existing = state.transcript.find((t) => t.id === streamingId);
      if (existing === undefined) {
        return {
          ...state,
          transcript: [
            ...state.transcript,
            { id: streamingId, kind: "assistant", text: event.text },
          ],
        };
      }
      return {
        ...state,
        transcript: state.transcript.map((t) =>
          t.id === streamingId ? { ...t, text: t.text + event.text } : t,
        ),
      };
    }

    case "stream-end": {
      if (state.name !== "streaming") return state;
      return {
        ...state,
        name: "idle",
        streamingEntryId: undefined,
      };
    }

    case "permission-request": {
      if (state.name !== "streaming") return state;
      return {
        ...state,
        name: "awaiting-permission",
        pendingPermission: event.request,
      };
    }

    case "permission-response": {
      if (state.name !== "awaiting-permission") return state;
      return {
        ...state,
        name: "streaming",
        pendingPermission: undefined,
      };
    }

    case "compact-begin": {
      if (state.name !== "streaming") return state;
      return { ...state, name: "compact" };
    }

    case "compact-end": {
      if (state.name !== "compact") return state;
      return { ...state, name: "streaming" };
    }

    case "tool-entry": {
      return {
        ...state,
        transcript: [
          ...state.transcript,
          {
            id: event.id,
            kind: "tool",
            text: event.summary ?? "",
            tool: { name: event.name, summary: event.summary },
          },
        ],
      };
    }

    case "system-entry": {
      return {
        ...state,
        transcript: [
          ...state.transcript,
          { id: event.id, kind: "system", text: event.text },
        ],
      };
    }

    case "clear": {
      if (state.name !== "idle") return state;
      return {
        ...state,
        transcript: [],
      };
    }

    case "dropdown-up":
      return {
        ...state,
        dropdownIndex: Math.max(0, state.dropdownIndex - 1),
      };

    case "dropdown-down":
      // Upper bound clamp happens at the UI layer against the current
      // candidates list; here we just monotonically increment.
      return {
        ...state,
        dropdownIndex: state.dropdownIndex + 1,
      };

    case "dropdown-reset":
      return { ...state, dropdownIndex: 0 };

    case "dropdown-accept":
      return {
        ...state,
        input: {
          ...state.input,
          value: event.value,
          cursor: event.value.length,
        },
        dropdownIndex: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Emacs keybinding helpers
// ---------------------------------------------------------------------------

function applyKey(state: ReplState, key: KeyEvent): ReplState {
  const buf = state.input;

  // ---- Ctrl-based emacs bindings ---------------------------------------
  if (key.ctrl && key.name === "a") {
    return replaceInput(state, { ...buf, cursor: 0 });
  }
  if (key.ctrl && key.name === "e") {
    return replaceInput(state, { ...buf, cursor: buf.value.length });
  }
  if (key.ctrl && key.name === "k") {
    const killed = buf.value.slice(buf.cursor);
    return replaceInput(state, {
      value: buf.value.slice(0, buf.cursor),
      cursor: buf.cursor,
      killBuffer: killed,
    });
  }
  if (key.ctrl && key.name === "u") {
    const killed = buf.value.slice(0, buf.cursor);
    return replaceInput(state, {
      value: buf.value.slice(buf.cursor),
      cursor: 0,
      killBuffer: killed,
    });
  }
  if (key.ctrl && key.name === "w") {
    // Kill previous word (space-delimited). Skip trailing spaces, then find
    // the next space boundary.
    const left = buf.value.slice(0, buf.cursor);
    const right = buf.value.slice(buf.cursor);
    const trimmed = left.replace(/\s+$/, "");
    const lastSpace = trimmed.search(/\s\S*$/);
    const wordStart = lastSpace === -1 ? 0 : lastSpace + 1;
    const killed = buf.value.slice(wordStart, buf.cursor);
    return replaceInput(state, {
      value: buf.value.slice(0, wordStart) + right,
      cursor: wordStart,
      killBuffer: killed,
    });
  }
  if (key.ctrl && key.name === "p") {
    return historyPrev(state);
  }
  if (key.ctrl && key.name === "n") {
    return historyNext(state);
  }

  // ---- Arrow / navigation ---------------------------------------------
  if (key.leftArrow) {
    return replaceInput(state, {
      ...buf,
      cursor: Math.max(0, buf.cursor - 1),
    });
  }
  if (key.rightArrow) {
    return replaceInput(state, {
      ...buf,
      cursor: Math.min(buf.value.length, buf.cursor + 1),
    });
  }
  if (key.upArrow) {
    return historyPrev(state);
  }
  if (key.downArrow) {
    return historyNext(state);
  }
  if (key.home) {
    return replaceInput(state, { ...buf, cursor: 0 });
  }
  if (key.end) {
    return replaceInput(state, { ...buf, cursor: buf.value.length });
  }

  // ---- Backspace / delete ---------------------------------------------
  if (key.backspace) {
    if (buf.cursor === 0) return state;
    return replaceInput(state, {
      ...buf,
      value: buf.value.slice(0, buf.cursor - 1) + buf.value.slice(buf.cursor),
      cursor: buf.cursor - 1,
    });
  }
  if (key.delete) {
    if (buf.cursor === buf.value.length) return state;
    return replaceInput(state, {
      ...buf,
      value: buf.value.slice(0, buf.cursor) + buf.value.slice(buf.cursor + 1),
    });
  }

  // ---- Printable insert (default fallthrough) -------------------------
  if (key.printable !== undefined && key.printable.length > 0 && !key.ctrl) {
    const inserted = key.printable;
    return replaceInput(state, {
      ...buf,
      value: buf.value.slice(0, buf.cursor) + inserted + buf.value.slice(buf.cursor),
      cursor: buf.cursor + inserted.length,
    });
  }

  return state;
}

function replaceInput(state: ReplState, input: InputBuffer): ReplState {
  return { ...state, input };
}

// ---------------------------------------------------------------------------
// History navigation
// ---------------------------------------------------------------------------

export function historyPrev(state: ReplState): ReplState {
  if (state.history.length === 0) return state;
  const draft = state.historyIndex === -1 ? state.input.value : state.historyDraft;
  const nextIdx =
    state.historyIndex === -1 ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
  const value = state.history[nextIdx] ?? "";
  return {
    ...state,
    historyIndex: nextIdx,
    historyDraft: draft,
    input: { ...state.input, value, cursor: value.length },
  };
}

export function historyNext(state: ReplState): ReplState {
  if (state.historyIndex === -1) return state;
  const nextIdx = state.historyIndex + 1;
  if (nextIdx >= state.history.length) {
    // Restore draft
    return {
      ...state,
      historyIndex: -1,
      input: {
        ...state.input,
        value: state.historyDraft,
        cursor: state.historyDraft.length,
      },
      historyDraft: "",
    };
  }
  const value = state.history[nextIdx] ?? "";
  return {
    ...state,
    historyIndex: nextIdx,
    input: { ...state.input, value, cursor: value.length },
  };
}
