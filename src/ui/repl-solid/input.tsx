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
 */

import type { Component } from "solid-js";
import type { TextareaRenderable, KeyBinding } from "@opentui/core";
import type { KeyEvent as CoreKeyEvent } from "@opentui/core/lib/KeyHandler";
import type { KeyEvent } from "../repl/state.js";
import { theme } from "./theme.js";

export interface InputProps {
  readonly value: string;
  readonly onChange: (value: string, cursor: number) => void;
  readonly onSubmit: (value: string) => void;
  readonly onKey: (key: KeyEvent) => void;
  readonly disabled: boolean;
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

  // Printable characters.
  if (name.length === 1 && !e.ctrl && !e.meta) {
    return { printable: name };
  }

  // Multi-char names for keys like "return", etc.
  if (name === "return") return { return: true };

  return null;
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
];

export const Input: Component<InputProps> = (props) => {
  let textareaRef: TextareaRenderable | undefined;

  function handleRef(r: TextareaRenderable) {
    textareaRef = r;
    // Focus immediately on mount so key events are routed here.
    r.focus();
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
    if (props.disabled) {
      e.preventDefault();
      return;
    }

    const name = e.name ?? "";

    // Arrow keys: let the textarea do its default cursor movement, but also
    // forward to onKey so the parent can do history navigation.
    if (name === "up" || name === "down" || name === "left" || name === "right") {
      const keyEvent = translateCoreKey(e);
      if (keyEvent) props.onKey(keyEvent);
      // Do NOT preventDefault — let the textarea move the cursor too.
      return;
    }

    // All other keys are handled by the KeyBinding system or textarea natively.
    // We don't need to forward them here as the reducer-side is driven by
    // onContentChange (which fires after the buffer updates).
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
