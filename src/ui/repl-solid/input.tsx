/**
 * input.tsx — OpenTUI/Solid port of src/ui/repl/input.tsx.
 *
 * Single-line (expandable) input with Emacs keybindings, powered by
 * TextareaRenderable from @opentui/core. Keybinding semantics mirror
 * state.ts applyKey():
 *
 *   Enter            → onSubmit(value)
 *   Shift+Enter      → newline (multiline)
 *   Ctrl+J           → newline (multiline)
 *   Ctrl+A           → line-home (move to start)
 *   Ctrl+E           → line-end  (move to end)
 *   Ctrl+K           → delete-to-line-end
 *   Ctrl+U           → delete-to-line-start
 *   Ctrl+W           → delete-word-backward
 *   Alt+B            → word-backward  (meta = Alt/Option modifier in OpenTUI)
 *   Alt+F            → word-forward
 *   Alt+D            → delete-word-forward
 *   Alt+Backspace    → delete-word-backward
 *   Arrow keys       → forwarded to onKey() for cursor + history nav
 *   Backspace/Delete → forwarded to textarea native handler
 *   printable        → forwarded to textarea native handler
 *
 * Props:
 *   value     — current buffer string (controlled from outside via reducer)
 *   onChange  — called with (value, cursor) after each content change
 *   onSubmit  — called with the buffer string when the user presses Enter
 *   onKey     — called with a KeyEvent for arrow keys / history navigation
 *   disabled  — when true, all input is suppressed
 *
 * P4.Q5 — paste normalization:
 *   OpenTUI's TextareaRenderable.handlePaste preserves all bytes verbatim and
 *   strips only ANSI sequences. It does NOT normalize Windows-style line endings
 *   (\r\n) or bare \r to \n. We wrap handlePaste on the ref so that pasted bytes
 *   are decoded, normalized, and re-encoded before the original handler runs.
 *   See normalizePasteBytes() below.
 */

import type { Component } from "solid-js";
import type { TextareaRenderable, KeyBinding } from "@opentui/core";
import type { KeyEvent as CoreKeyEvent, PasteEvent } from "@opentui/core/lib/KeyHandler";
import type { KeyEvent } from "../repl/state.js";
import { theme } from "./theme.js";

export interface InputProps {
  readonly value: string;
  readonly onChange: (value: string, cursor: number) => void;
  readonly onSubmit: (value: string) => void;
  readonly onKey: (key: KeyEvent) => void;
  readonly disabled: boolean;
  /**
   * When true (awaiting a permission decision), forward ALL keys to onKey and
   * block the textarea from mutating (doc 49 Phase D2/key-forwarding fix). The
   * parent's handleKey consumes y/n/a/Enter/Esc/Ctrl+E/Ctrl+C and swallows the
   * rest, so nothing edits the buffer during a prompt.
   */
  readonly awaitingPermission?: boolean;
  /**
   * When true (a non-transcript view is active), forward j/k to onKey for list
   * navigation instead of typing them (doc 49 Phase D3). Arrows already forward.
   */
  readonly viewActive?: boolean;
  /**
   * Called once with the underlying textarea so the parent can imperatively read
   * / set its content (Ctrl+G external editor, doc 49 Phase E2). The textarea is
   * otherwise uncontrolled — state.input is derived from it via onChange.
   */
  readonly onTextareaReady?: (textarea: TextareaRenderable) => void;
}

/**
 * Normalize paste bytes by converting Windows-style line endings (\r\n) and
 * bare carriage returns (\r) to Unix newlines (\n).
 *
 * Decoder is explicit `{ fatal: false }` (the default): invalid UTF-8 bytes
 * are replaced with U+FFFD rather than throwing. Pasting raw binary into a
 * textarea is already abnormal; lossy substitution is preferable to a
 * thrown exception that would surface as an unhandled paste error.
 *
 * Empty-input round-trip returns an empty Uint8Array.
 *
 * Exported for unit testing. Used by the handlePaste wrap in handleRef().
 */
export function normalizePasteBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const normalized = text.replace(/\r\n?/g, "\n");
  return new TextEncoder().encode(normalized);
}

/**
 * Translate a core KeyEvent (from @opentui/core) into our reducer-friendly
 * KeyEvent shape so the parent can feed it through applyKey().
 */
function translateCoreKey(e: CoreKeyEvent): KeyEvent | null {
  const name = e.name ?? "";

  // Arrow keys — parent handles cursor movement + history navigation.
  if (name === "up") return { upArrow: true };
  if (name === "down") return { downArrow: true };
  if (name === "left") return { leftArrow: true };
  if (name === "right") return { rightArrow: true };

  // Ctrl combos that we DON'T handle via KeyBinding (but pass to reducer).
  // Ctrl+A/E/K/U/W are mapped as KeyBinding actions below; only emit onKey
  // for ones the textarea doesn't swallow so the reducer can stay in sync.
  if (e.ctrl && name.length === 1) {
    return { ctrl: true, name: name.toLowerCase(), shift: e.shift, meta: e.meta };
  }

  // Backspace / Delete.
  if (name === "backspace") return { backspace: true };
  if (name === "delete") return { delete: true };

  // Escape.
  if (name === "escape") return { name: "escape" };

  // Tab / Shift+Tab (plan-mode toggle, dropdown accept).
  if (name === "tab") return { name: "tab", shift: e.shift };

  // Printable characters.
  if (name.length === 1 && !e.ctrl && !e.meta) {
    return { printable: name };
  }

  // Multi-char names for keys like "return", etc.
  if (name === "return") return { return: true };

  return null;
}

/**
 * Global chords the parent's handleKey consumes (and returns on), so forwarding
 * them can't desync the reducer buffer. Excludes textarea editing chords
 * (Ctrl+A/E/K/U/W, meta motions) which the KeyBinding system owns.
 *
 * Ctrl+A doubles as textarea line-home AND the parent's "agents view"; the
 * parent intercepts it, so forwarding is safe (view switch hides the input).
 */
const GLOBAL_CTRL_CHORDS = new Set(["s", "o", "a", "t", "r", "g"]);

function isGlobalChord(e: CoreKeyEvent): boolean {
  const name = (e.name ?? "").toLowerCase();
  if (name === "escape") return true;
  if (name === "tab" && e.shift === true) return true;
  if (e.ctrl === true && e.meta !== true && GLOBAL_CTRL_CHORDS.has(name)) {
    return true;
  }
  return false;
}

/**
 * Keybindings passed to TextareaRenderable.
 * This maps Emacs motions and newline combos to TextareaAction names.
 * Enter → "submit" is handled here; Shift+Enter / Ctrl+J → "newline".
 */
const KEY_BINDINGS: KeyBinding[] = [
  // Submit.
  { name: "return", action: "submit" },
  // Newline (multiline entry).
  { name: "return", shift: true, action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
  // Emacs motions.
  { name: "a", ctrl: true, action: "line-home" },
  { name: "e", ctrl: true, action: "line-end" },
  { name: "k", ctrl: true, action: "delete-to-line-end" },
  { name: "u", ctrl: true, action: "delete-to-line-start" },
  { name: "w", ctrl: true, action: "delete-word-backward" },
  // Word motions (Alt = meta modifier).
  { name: "b", meta: true, action: "word-backward" },
  { name: "f", meta: true, action: "word-forward" },
  { name: "d", meta: true, action: "delete-word-forward" },
  { name: "backspace", meta: true, action: "delete-word-backward" },
];

export const Input: Component<InputProps> = (props) => {
  let textareaRef: TextareaRenderable | undefined;

  function handleRef(r: TextareaRenderable) {
    textareaRef = r;
    // Focus immediately on mount so key events are routed here.
    r.focus();
    props.onTextareaReady?.(r);
    // Wrap handlePaste to normalize CRLF line endings before the default
    // handler runs. OpenTUI preserves bytes verbatim (P4.Q5).
    const originalHandlePaste = r.handlePaste.bind(r);
    r.handlePaste = (event: PasteEvent) => {
      const normalizedBytes = normalizePasteBytes(event.bytes);
      const normalizedEvent = new (event.constructor as typeof PasteEvent)(
        normalizedBytes,
        event.metadata,
      );
      originalHandlePaste(normalizedEvent);
    };
  }

  function handleContentChange() {
    if (!textareaRef) return;
    const value = textareaRef.plainText;
    const cursor = textareaRef.cursorOffset;
    props.onChange(value, cursor);
  }

  function handleSubmit() {
    if (!textareaRef) return;
    const value = textareaRef.plainText;
    props.onSubmit(value);
  }

  function handleKeyDown(e: CoreKeyEvent) {
    // While a permission prompt is up, the parent owns every keystroke: forward
    // all keys and block the textarea from mutating (doc 49 key-forwarding fix).
    if (props.awaitingPermission === true) {
      const keyEvent = translateCoreKey(e);
      if (keyEvent) props.onKey(keyEvent);
      e.preventDefault();
      return;
    }

    if (props.disabled) {
      e.preventDefault();
      return;
    }

    const name = e.name ?? "";

    // While an agent/task view is active, j/k drive list navigation (doc 49
    // Phase D3) — forward and block them from typing into the input.
    if (
      props.viewActive === true &&
      e.ctrl !== true &&
      e.meta !== true &&
      (name === "j" || name === "k")
    ) {
      const keyEvent = translateCoreKey(e);
      if (keyEvent) props.onKey(keyEvent);
      e.preventDefault();
      return;
    }

    // Arrow keys: let the textarea do its default cursor movement, but also
    // forward to onKey so the parent can do history navigation.
    if (name === "up" || name === "down" || name === "left" || name === "right") {
      const keyEvent = translateCoreKey(e);
      if (keyEvent) props.onKey(keyEvent);
      // Do NOT preventDefault — let the textarea move the cursor too.
      return;
    }

    // Global chords (Ctrl+O/S/A/T/R/G, Shift+Tab, Esc): forward to the parent's
    // handleKey and block the textarea so they don't insert text. Every chord
    // here is consumed by handleKey, so the reducer buffer can't desync.
    if (isGlobalChord(e)) {
      const keyEvent = translateCoreKey(e);
      if (keyEvent) props.onKey(keyEvent);
      e.preventDefault();
      return;
    }

    // All other keys are handled by the KeyBinding system or textarea natively;
    // the reducer buffer is kept in sync by onContentChange after the edit.
  }

  return (
    <textarea
      ref={handleRef as (r: unknown) => void}
      textColor={theme.text}
      focusedTextColor={theme.text}
      keyBindings={KEY_BINDINGS}
      onContentChange={handleContentChange}
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown as (e: unknown) => void}
      minHeight={1}
      maxHeight={8}
    />
  );
};
