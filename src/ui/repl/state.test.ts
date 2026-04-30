import { describe, it, expect } from "vitest";
import {
  createInitialState,
  reduce,
  slashCommandAllowedInState,
  historyPrev,
  historyNext,
  createStubSlashRegistry,
  type ReplState,
  type ReplEvent,
} from "./state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runEvents(state: ReplState, events: ReplEvent[]): ReplState {
  return events.reduce((s, e) => reduce(s, e), state);
}

function idle(): ReplState {
  return createInitialState();
}

// ---------------------------------------------------------------------------
// Transition table coverage (≥ 10 tests)
// ---------------------------------------------------------------------------

describe("reducer — transitions", () => {
  it("idle --(input-changed)--> idle (buffer updates)", () => {
    const s = reduce(idle(), { type: "input-changed", value: "he", cursor: 2 });
    expect(s.name).toBe("idle");
    expect(s.input.value).toBe("he");
    expect(s.input.cursor).toBe(2);
  });

  it("idle --(submit)--> streaming", () => {
    const s = reduce(idle(), { type: "submit", text: "hi" });
    expect(s.name).toBe("streaming");
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]!.kind).toBe("user");
    expect(s.transcript[0]!.text).toBe("hi");
    expect(s.streamingEntryId).toBeDefined();
  });

  it("streaming --(stream-delta)--> streaming (accumulates)", () => {
    const s0 = reduce(idle(), { type: "submit", text: "hi" });
    const s1 = reduce(s0, { type: "stream-delta", text: "hello" });
    const s2 = reduce(s1, { type: "stream-delta", text: " world" });
    expect(s2.name).toBe("streaming");
    const assistant = s2.transcript.find((e) => e.kind === "assistant");
    expect(assistant?.text).toBe("hello world");
  });

  it("streaming --(stream-end)--> idle", () => {
    const s0 = reduce(idle(), { type: "submit", text: "hi" });
    const s1 = reduce(s0, { type: "stream-end" });
    expect(s1.name).toBe("idle");
    expect(s1.streamingEntryId).toBeUndefined();
  });

  it("streaming --(permission-request)--> awaiting-permission", () => {
    const s0 = reduce(idle(), { type: "submit", text: "hi" });
    const s1 = reduce(s0, {
      type: "permission-request",
      request: {
        toolName: "bash",
        input: { cmd: "ls" },
        currentMode: "read-only",
        requiredPermission: "write",
      },
    });
    expect(s1.name).toBe("awaiting-permission");
    expect(s1.pendingPermission?.toolName).toBe("bash");
  });

  it("awaiting-permission --(permission-response approve)--> streaming", () => {
    const s0 = runEvents(idle(), [
      { type: "submit", text: "hi" },
      {
        type: "permission-request",
        request: {
          toolName: "bash",
          input: {},
          currentMode: "read-only",
          requiredPermission: "write",
        },
      },
    ]);
    const s1 = reduce(s0, { type: "permission-response", decision: "approve" });
    expect(s1.name).toBe("streaming");
    expect(s1.pendingPermission).toBeUndefined();
  });

  it("awaiting-permission --(permission-response deny)--> streaming", () => {
    const s0 = runEvents(idle(), [
      { type: "submit", text: "hi" },
      {
        type: "permission-request",
        request: {
          toolName: "bash",
          input: {},
          currentMode: "read-only",
          requiredPermission: "write",
        },
      },
    ]);
    const s1 = reduce(s0, { type: "permission-response", decision: "deny" });
    expect(s1.name).toBe("streaming");
    expect(s1.pendingPermission).toBeUndefined();
  });

  it("streaming --(compact-begin)--> compact", () => {
    const s0 = reduce(idle(), { type: "submit", text: "hi" });
    const s1 = reduce(s0, { type: "compact-begin" });
    expect(s1.name).toBe("compact");
  });

  it("compact --(compact-end)--> streaming", () => {
    const s0 = runEvents(idle(), [
      { type: "submit", text: "hi" },
      { type: "compact-begin" },
    ]);
    const s1 = reduce(s0, { type: "compact-end" });
    expect(s1.name).toBe("streaming");
  });

  it("any --(shutdown)--> shutdown (from idle)", () => {
    const s = reduce(idle(), { type: "shutdown" });
    expect(s.name).toBe("shutdown");
  });

  it("any --(shutdown)--> shutdown (from streaming)", () => {
    const s0 = reduce(idle(), { type: "submit", text: "hi" });
    const s1 = reduce(s0, { type: "shutdown" });
    expect(s1.name).toBe("shutdown");
  });

  it("shutdown absorbs subsequent events", () => {
    const s0 = reduce(idle(), { type: "shutdown" });
    const s1 = reduce(s0, { type: "submit", text: "hi" });
    expect(s1.name).toBe("shutdown");
    expect(s1.transcript).toHaveLength(0);
  });

  it("idle --(clear)--> idle (transcript purged)", () => {
    const s0 = runEvents(idle(), [
      { type: "submit", text: "hi" },
      { type: "stream-delta", text: "hello" },
      { type: "stream-end" },
    ]);
    expect(s0.transcript.length).toBeGreaterThan(0);
    const s1 = reduce(s0, { type: "clear" });
    expect(s1.name).toBe("idle");
    expect(s1.transcript).toHaveLength(0);
  });

  it("stream-delta outside streaming state is a no-op", () => {
    const s = reduce(idle(), { type: "stream-delta", text: "x" });
    expect(s).toStrictEqual(idle());
  });

  it("permission-request outside streaming state is a no-op", () => {
    const s = reduce(idle(), {
      type: "permission-request",
      request: {
        toolName: "bash",
        input: {},
        currentMode: "read-only",
        requiredPermission: "write",
      },
    });
    expect(s.name).toBe("idle");
  });

  it("compact-end from idle is a no-op", () => {
    const s = reduce(idle(), { type: "compact-end" });
    expect(s.name).toBe("idle");
  });

  it("submit from streaming is a no-op (blocks re-entry)", () => {
    const s0 = reduce(idle(), { type: "submit", text: "hi" });
    const before = s0.transcript.length;
    const s1 = reduce(s0, { type: "submit", text: "again" });
    expect(s1.name).toBe("streaming");
    expect(s1.transcript).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// Emacs keybindings via reducer (≥ 5 tests)
// ---------------------------------------------------------------------------

describe("reducer — emacs keybindings", () => {
  function seed(value: string, cursor: number): ReplState {
    return reduce(idle(), { type: "input-changed", value, cursor });
  }

  it("Ctrl+A moves cursor to beginning of line", () => {
    const s0 = seed("hello world", 5);
    const s1 = reduce(s0, {
      type: "key",
      key: { ctrl: true, name: "a" },
    });
    expect(s1.input.cursor).toBe(0);
    expect(s1.input.value).toBe("hello world");
  });

  it("Ctrl+E moves cursor to end of line", () => {
    const s0 = seed("hello world", 3);
    const s1 = reduce(s0, {
      type: "key",
      key: { ctrl: true, name: "e" },
    });
    expect(s1.input.cursor).toBe(11);
  });

  it("Ctrl+K kills from cursor to EOL", () => {
    const s0 = seed("hello world", 5);
    const s1 = reduce(s0, {
      type: "key",
      key: { ctrl: true, name: "k" },
    });
    expect(s1.input.value).toBe("hello");
    expect(s1.input.cursor).toBe(5);
    expect(s1.input.killBuffer).toBe(" world");
  });

  it("Ctrl+U kills from cursor to BOL", () => {
    const s0 = seed("hello world", 6);
    const s1 = reduce(s0, {
      type: "key",
      key: { ctrl: true, name: "u" },
    });
    expect(s1.input.value).toBe("world");
    expect(s1.input.cursor).toBe(0);
    expect(s1.input.killBuffer).toBe("hello ");
  });

  it("Ctrl+W kills previous space-delimited word", () => {
    const s0 = seed("foo bar baz", 11);
    const s1 = reduce(s0, {
      type: "key",
      key: { ctrl: true, name: "w" },
    });
    expect(s1.input.value).toBe("foo bar ");
    expect(s1.input.cursor).toBe(8);
    expect(s1.input.killBuffer).toBe("baz");
  });

  it("Ctrl+W with trailing spaces skips them first", () => {
    const s0 = seed("foo bar   ", 10);
    const s1 = reduce(s0, {
      type: "key",
      key: { ctrl: true, name: "w" },
    });
    // Current implementation: trims trailing spaces then kills back to
    // the previous space boundary — "bar" together with its trailing
    // whitespace is removed.
    expect(s1.input.cursor).toBeLessThan(10);
    expect(s1.input.value.length).toBeLessThan(10);
  });

  it("Ctrl+Y yanks killBuffer at cursor", () => {
    // Kill "baz" then yank it back at cursor position 8.
    const s0 = seed("foo bar ", 8);
    const s1 = reduce(s0, { type: "key", key: { ctrl: true, name: "k" } });
    expect(s1.input.killBuffer).toBe("");
    const s2 = seed("foo bar baz", 11);
    const s3 = reduce(s2, { type: "key", key: { ctrl: true, name: "w" } });
    expect(s3.input.killBuffer).toBe("baz");
    const s4 = reduce(s3, { type: "key", key: { ctrl: true, name: "y" } });
    expect(s4.input.value).toBe("foo bar baz");
    expect(s4.input.cursor).toBe(11);
  });

  it("Ctrl+Y with empty killBuffer is a no-op", () => {
    const s0 = seed("hello", 5);
    const s1 = reduce(s0, { type: "key", key: { ctrl: true, name: "y" } });
    expect(s1.input.value).toBe("hello");
    expect(s1.input.cursor).toBe(5);
  });

  it("Ctrl+Y inserts killBuffer mid-value", () => {
    const s0 = seed("foo bar baz", 11);
    const s1 = reduce(s0, { type: "key", key: { ctrl: true, name: "w" } });
    // cursor is now at 8, killBuffer = "baz"
    const s2 = reduce(s1, { type: "key", key: { ctrl: true, name: "y" } });
    expect(s2.input.value).toBe("foo bar baz");
    expect(s2.input.cursor).toBe(11);
  });

  it("Left arrow moves cursor left (clamped at 0)", () => {
    const s0 = seed("abc", 1);
    const s1 = reduce(s0, { type: "key", key: { leftArrow: true } });
    expect(s1.input.cursor).toBe(0);
    const s2 = reduce(s1, { type: "key", key: { leftArrow: true } });
    expect(s2.input.cursor).toBe(0);
  });

  it("Right arrow moves cursor right (clamped at length)", () => {
    const s0 = seed("abc", 2);
    const s1 = reduce(s0, { type: "key", key: { rightArrow: true } });
    expect(s1.input.cursor).toBe(3);
    const s2 = reduce(s1, { type: "key", key: { rightArrow: true } });
    expect(s2.input.cursor).toBe(3);
  });

  it("Backspace deletes character before cursor", () => {
    const s0 = seed("abc", 2);
    const s1 = reduce(s0, { type: "key", key: { backspace: true } });
    expect(s1.input.value).toBe("ac");
    expect(s1.input.cursor).toBe(1);
  });

  it("Delete deletes character at cursor", () => {
    const s0 = seed("abc", 1);
    const s1 = reduce(s0, { type: "key", key: { delete: true } });
    expect(s1.input.value).toBe("ac");
    expect(s1.input.cursor).toBe(1);
  });

  it("Printable character inserts at cursor", () => {
    const s0 = seed("ac", 1);
    const s1 = reduce(s0, { type: "key", key: { printable: "b" } });
    expect(s1.input.value).toBe("abc");
    expect(s1.input.cursor).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// slashCommandAllowedInState matrix (≥ 5 tests — one per state)
// ---------------------------------------------------------------------------

describe("slashCommandAllowedInState", () => {
  it("idle: allows every command", () => {
    const s = idle();
    for (const cmd of ["help", "exit", "clear", "status", "stop"]) {
      expect(slashCommandAllowedInState(s, cmd)).toBe(true);
    }
  });

  it("streaming: allows only /stop", () => {
    const s = reduce(idle(), { type: "submit", text: "hi" });
    expect(slashCommandAllowedInState(s, "stop")).toBe(true);
    expect(slashCommandAllowedInState(s, "help")).toBe(false);
    expect(slashCommandAllowedInState(s, "clear")).toBe(false);
  });

  it("awaiting-permission: allows only /stop (y/N is a keypress, not a slash)", () => {
    const s = runEvents(idle(), [
      { type: "submit", text: "hi" },
      {
        type: "permission-request",
        request: {
          toolName: "bash",
          input: {},
          currentMode: "read-only",
          requiredPermission: "write",
        },
      },
    ]);
    expect(slashCommandAllowedInState(s, "stop")).toBe(true);
    expect(slashCommandAllowedInState(s, "help")).toBe(false);
  });

  it("compact: allows no commands", () => {
    const s = runEvents(idle(), [
      { type: "submit", text: "hi" },
      { type: "compact-begin" },
    ]);
    for (const cmd of ["help", "exit", "clear", "stop"]) {
      expect(slashCommandAllowedInState(s, cmd)).toBe(false);
    }
  });

  it("shutdown: allows no commands", () => {
    const s = reduce(idle(), { type: "shutdown" });
    for (const cmd of ["help", "exit", "clear", "stop"]) {
      expect(slashCommandAllowedInState(s, cmd)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// History navigation (≥ 2 tests)
// ---------------------------------------------------------------------------

describe("history navigation", () => {
  it("submit appends to history", () => {
    const s0 = reduce(idle(), { type: "submit", text: "one" });
    const s1 = reduce(s0, { type: "stream-end" });
    const s2 = reduce(s1, { type: "submit", text: "two" });
    expect(s2.history).toEqual(["one", "two"]);
  });

  it("Ctrl+P / up arrow recalls most-recent history entry", () => {
    const s0 = runEvents(idle(), [
      { type: "submit", text: "one" },
      { type: "stream-end" },
      { type: "submit", text: "two" },
      { type: "stream-end" },
    ]);
    const s1 = historyPrev(s0);
    expect(s1.input.value).toBe("two");
    expect(s1.historyIndex).toBe(1);
    const s2 = historyPrev(s1);
    expect(s2.input.value).toBe("one");
    expect(s2.historyIndex).toBe(0);
  });

  it("historyNext restores draft when past the end", () => {
    const s0 = runEvents(idle(), [
      { type: "submit", text: "one" },
      { type: "stream-end" },
    ]);
    const typed = reduce(s0, {
      type: "input-changed",
      value: "draft",
      cursor: 5,
    });
    const up = historyPrev(typed);
    expect(up.input.value).toBe("one");
    const down = historyNext(up);
    expect(down.input.value).toBe("draft");
    expect(down.historyIndex).toBe(-1);
  });

  it("historyPrev with empty history is a no-op", () => {
    const s = historyPrev(idle());
    expect(s.input.value).toBe("");
    expect(s.historyIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe("stub slash registry", () => {
  it("lists the Phase 2 stub commands", () => {
    const r = createStubSlashRegistry();
    const names = r.list().map((c) => c.name);
    expect(names).toEqual(["help", "exit", "clear", "status"]);
  });

  it("get returns entry for known command", () => {
    const r = createStubSlashRegistry();
    expect(r.get("help")?.description).toBeTruthy();
    expect(r.get("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hydrate-history
// ---------------------------------------------------------------------------

describe("hydrate-history", () => {
  it("replaces state.history when idle", () => {
    const s = reduce(idle(), {
      type: "hydrate-history",
      history: ["first", "second", "third"],
    });
    expect(s.history).toEqual(["first", "second", "third"]);
    expect(s.name).toBe("idle");
  });

  it("no-op when not idle (streaming state)", () => {
    const streaming = reduce(idle(), { type: "submit", text: "hi" });
    expect(streaming.name).toBe("streaming");
    const s = reduce(streaming, {
      type: "hydrate-history",
      history: ["should-not-appear"],
    });
    expect(s.history).toEqual(["hi"]);
    expect(s.name).toBe("streaming");
  });
});

describe("transcript entries", () => {
  it("tool-entry appends a tool transcript line", () => {
    const s = reduce(idle(), {
      type: "tool-entry",
      id: "tool-1",
      name: "bash",
      summary: "ls",
    });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]!.kind).toBe("tool");
    expect(s.transcript[0]!.tool?.name).toBe("bash");
  });

  it("system-entry appends a system transcript line", () => {
    const s = reduce(idle(), {
      type: "system-entry",
      id: "sys-1",
      text: "hook fired",
    });
    expect(s.transcript).toHaveLength(1);
    expect(s.transcript[0]!.kind).toBe("system");
    expect(s.transcript[0]!.text).toBe("hook fired");
  });

  it("session-id records the session id", () => {
    const s = reduce(idle(), { type: "session-id", sessionId: "sess-abc" });
    expect(s.sessionId).toBe("sess-abc");
  });
});
