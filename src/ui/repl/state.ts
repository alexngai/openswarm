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

import type { PermissionMode, RequiredPermission, AgentPhase, TaskStatus } from "../../core/types.js";

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
  /** Links to toolCalls record for rich rendering (Phase 1a). */
  readonly toolCallId?: string;
}

/**
 * Rich tool call state, tracked separately from transcript entries so the
 * chip renderer can access structured data (args, result, streaming state)
 * without parsing text.
 */
export interface ToolCallState {
  readonly id: string;
  readonly name: string;
  /** Accumulated JSON argument deltas — concatenated raw fragments. */
  readonly streamingArgs: string;
  /** Parsed args (set when tool_use_end arrives or from result context). */
  readonly args: unknown;
  /** Tool result content (set on tool-result event). */
  readonly result: string | undefined;
  readonly isError: boolean;
  /** Whether the tool call is still in flight (no result yet). */
  readonly pending: boolean;
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

export interface AgentState {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly parentId?: string;
  readonly phase: AgentPhase;
  readonly toolCount: number;
  readonly tokenUsage: number;
}

export interface TaskState {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly assignee?: string;
}

export type ActiveView = "transcript" | "agents" | "tasks";

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
  /** Rich tool call state keyed by tool use ID (Phase 1a). */
  readonly toolCalls: Readonly<Record<string, ToolCallState>>;
  /** When true, all tool chips show expanded body. Toggled by Ctrl+O. */
  readonly globalExpand: boolean;
  /** Messages queued during streaming, auto-submitted when the turn ends (Phase 3). */
  readonly messageQueue: readonly string[];
  /** Multi-agent state keyed by agent id (Phase 5). */
  readonly agents: Readonly<Record<string, AgentState>>;
  /** Task board state keyed by task id (Phase 5). */
  readonly tasks: Readonly<Record<string, TaskState>>;
  /** Which view is currently active (Phase 5). */
  readonly activeView: ActiveView;
  /** When true, agent generates a plan before executing (Phase 6). */
  readonly planMode: boolean;
  /** Files mentioned via @ in the input, attached as context (Phase 6). */
  readonly mentionedFiles: readonly string[];
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
  // Steering — user-typed message captured mid-turn while the model is
  // streaming. Visually echoes a `(steered)` user entry; the actual send
  // to the engine is the outer wrapper's job (it enqueues for the next
  // turn boundary). Valid only when name === "streaming".
  | { readonly type: "steer"; readonly text: string }
  // Permission
  | { readonly type: "permission-request"; readonly request: PendingPermission }
  | {
      readonly type: "permission-response";
      readonly decision: "approve" | "deny";
    }
  // Compaction
  | { readonly type: "compact-begin" }
  | { readonly type: "compact-end" }
  // Tool use (legacy flat entry — kept for backward compat, no longer emitted by translateEngineEvent)
  | {
      readonly type: "tool-entry";
      readonly id: string;
      readonly name: string;
      readonly summary?: string;
    }
  // Rich tool call lifecycle (Phase 1a — replaces tool-entry in translateEngineEvent)
  | { readonly type: "tool-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-args-delta"; readonly id: string; readonly jsonDelta: string }
  | { readonly type: "tool-result"; readonly id: string; readonly content: string; readonly isError: boolean }
  // Expand/collapse tool output (Phase 1a)
  | { readonly type: "toggle-expand" }
  // Message queue — messages typed during streaming, auto-submitted on turn end (Phase 3)
  | { readonly type: "queue-message"; readonly text: string }
  | { readonly type: "dequeue-message" }
  // Multi-agent events (Phase 5)
  | { readonly type: "agent-spawned"; readonly id: string; readonly name: string; readonly role: string; readonly parentId?: string }
  | { readonly type: "agent-status"; readonly id: string; readonly phase: AgentPhase; readonly toolCount?: number; readonly tokenUsage?: number }
  | { readonly type: "task-update"; readonly id: string; readonly title: string; readonly status: TaskStatus; readonly assignee?: string }
  | { readonly type: "set-view"; readonly view: ActiveView }
  // Input enhancements (Phase 6)
  | { readonly type: "toggle-plan-mode" }
  | { readonly type: "add-mentioned-file"; readonly filePath: string }
  | { readonly type: "clear-mentioned-files" }
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
  | { readonly type: "session-id"; readonly sessionId: string }
  // Init — replaces state.history on mount from persistent storage.
  // Only valid in `idle`; no-op otherwise.
  | { readonly type: "hydrate-history"; readonly history: readonly string[] };

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
    toolCalls: {},
    globalExpand: false,
    messageQueue: [],
    agents: {},
    tasks: {},
    activeView: "transcript",
    planMode: false,
    mentionedFiles: [],
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

    case "hydrate-history": {
      if (state.name !== "idle") return state;
      return { ...state, history: event.history };
    }

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
        mentionedFiles: [],
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

    case "steer": {
      // Steering is only meaningful while a turn is in flight. From idle the
      // normal "submit" path applies; from awaiting-permission / compact the
      // user must resolve the blocking prompt first.
      if (state.name !== "streaming") return state;
      const text = event.text;
      if (text.length === 0) return state;
      const entryId = `s-${state.transcript.length}`;
      return {
        ...state,
        transcript: [
          ...state.transcript,
          { id: entryId, kind: "user", text: `(steered) ${text}` },
        ],
        input: { value: "", cursor: 0, killBuffer: state.input.killBuffer },
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

    case "tool-start": {
      const tc: ToolCallState = {
        id: event.id,
        name: event.name,
        streamingArgs: "",
        args: undefined,
        result: undefined,
        isError: false,
        pending: true,
      };
      return {
        ...state,
        toolCalls: { ...state.toolCalls, [event.id]: tc },
        transcript: [
          ...state.transcript,
          {
            id: event.id,
            kind: "tool" as const,
            text: "",
            tool: { name: event.name },
            toolCallId: event.id,
          },
        ],
      };
    }

    case "tool-args-delta": {
      const existing = state.toolCalls[event.id];
      if (existing === undefined) return state;
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [event.id]: {
            ...existing,
            streamingArgs: existing.streamingArgs + event.jsonDelta,
          },
        },
      };
    }

    case "tool-result": {
      const existing = state.toolCalls[event.id];
      if (existing === undefined) return state;
      let args = existing.args;
      if (args === undefined && existing.streamingArgs.length > 0) {
        try {
          args = JSON.parse(existing.streamingArgs);
        } catch {
          args = undefined;
        }
      }
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [event.id]: {
            ...existing,
            result: event.content,
            isError: event.isError,
            pending: false,
            args,
          },
        },
      };
    }

    case "toggle-expand": {
      return { ...state, globalExpand: !state.globalExpand };
    }

    case "queue-message": {
      if (state.name !== "streaming") return state;
      if (event.text.length === 0) return state;
      return {
        ...state,
        messageQueue: [...state.messageQueue, event.text],
        input: { value: "", cursor: 0, killBuffer: state.input.killBuffer },
      };
    }

    case "dequeue-message": {
      if (state.messageQueue.length === 0) return state;
      return {
        ...state,
        messageQueue: state.messageQueue.slice(1),
      };
    }

    case "agent-spawned": {
      const agent: AgentState = {
        id: event.id,
        name: event.name,
        role: event.role,
        parentId: event.parentId,
        phase: "spawning",
        toolCount: 0,
        tokenUsage: 0,
      };
      return {
        ...state,
        agents: { ...state.agents, [event.id]: agent },
      };
    }

    case "agent-status": {
      const existing = state.agents[event.id];
      if (existing === undefined) return state;
      return {
        ...state,
        agents: {
          ...state.agents,
          [event.id]: {
            ...existing,
            phase: event.phase,
            toolCount: event.toolCount ?? existing.toolCount,
            tokenUsage: event.tokenUsage ?? existing.tokenUsage,
          },
        },
      };
    }

    case "task-update": {
      const existingTask = state.tasks[event.id];
      const task: TaskState = {
        id: event.id,
        title: event.title,
        status: event.status,
        assignee: event.assignee ?? existingTask?.assignee,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [event.id]: task },
      };
    }

    case "set-view": {
      return { ...state, activeView: event.view };
    }

    case "toggle-plan-mode": {
      return { ...state, planMode: !state.planMode };
    }

    case "add-mentioned-file": {
      if (state.mentionedFiles.includes(event.filePath)) return state;
      return {
        ...state,
        mentionedFiles: [...state.mentionedFiles, event.filePath],
      };
    }

    case "clear-mentioned-files": {
      if (state.mentionedFiles.length === 0) return state;
      return { ...state, mentionedFiles: [] };
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
        toolCalls: {},
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
  if (key.ctrl && key.name === "y" && buf.killBuffer.length > 0) {
    return replaceInput(state, {
      ...buf,
      value: buf.value.slice(0, buf.cursor) + buf.killBuffer + buf.value.slice(buf.cursor),
      cursor: buf.cursor + buf.killBuffer.length,
    });
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
