/**
 * input.tsx — single-line input with emacs keybindings + slash-completion.
 *
 * Deliberately bypasses `ink-text-input` so emacs bindings don't collide with
 * the library's defaults. We consume ink's `useInput` hook directly and
 * funnel keypresses through the pure reducer in `state.ts` — this keeps the
 * keystroke logic unit-testable without React.
 *
 * When the line starts with `/` AND the cursor is at end-of-line, we show
 * the `<Dropdown>` completion menu. Up/Down cycles, Tab or Enter commits,
 * Esc dismisses. Phase 3 will wire the registry to the real slash command
 * dispatcher; Phase 2 ships a stub.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Key as InkKey } from "ink";
import { Dropdown, filterCandidates } from "./dropdown.js";
import type { KeyEvent, ReplState, SlashCommandRegistry } from "./state.js";

export interface InputProps {
  readonly state: ReplState;
  readonly registry: SlashCommandRegistry;
  readonly disabled?: boolean;
  /** Parent drives the input buffer via the reducer. */
  readonly onKey: (key: KeyEvent) => void;
  /** Called with the raw submitted line (no parsing). */
  readonly onSubmit: (line: string) => void;
  /** Called when the user chooses to cancel the dropdown (Esc). */
  readonly onDropdownDismiss?: () => void;
}

/**
 * Translate ink's (input, Key) pair into our reducer-friendly KeyEvent.
 * Exported for unit tests.
 */
export function translateInkKey(input: string, key: InkKey): KeyEvent {
  // Ctrl-letter: ink reports the lowercase letter in `input` with ctrl=true.
  if (key.ctrl && input.length === 1) {
    return {
      ctrl: true,
      name: input.toLowerCase(),
      shift: key.shift,
      meta: key.meta,
    };
  }
  if (key.leftArrow) return { leftArrow: true };
  if (key.rightArrow) return { rightArrow: true };
  if (key.upArrow) return { upArrow: true };
  if (key.downArrow) return { downArrow: true };
  if (key.backspace) return { backspace: true };
  if (key.delete) return { delete: true };
  if (key.return) return { return: true };
  if (key.tab) return { name: "tab", shift: key.shift };
  if (key.escape) return { name: "escape" };
  // Otherwise treat as a printable character (handles regular typing + paste).
  if (input.length > 0 && !key.ctrl && !key.meta) {
    return { printable: input };
  }
  return {};
}

function shouldShowDropdown(state: ReplState): boolean {
  const { value, cursor } = state.input;
  return (
    state.name === "idle" &&
    value.startsWith("/") &&
    cursor === value.length
  );
}

export function Input(props: InputProps): React.ReactElement {
  const { state, registry, disabled } = props;
  const [selectedIdx, setSelectedIdx] = useState(0);

  const showDropdown = shouldShowDropdown(state);
  const query = showDropdown ? state.input.value.slice(1) : "";
  const candidates = showDropdown ? filterCandidates(registry, query) : [];

  useInput(
    (input, key) => {
      if (disabled === true) return;

      // ---- Dropdown-mode handling ---------------------------------------
      if (showDropdown && candidates.length > 0) {
        if (key.upArrow) {
          setSelectedIdx((i) => (i - 1 + candidates.length) % candidates.length);
          return;
        }
        if (key.downArrow || key.tab) {
          setSelectedIdx((i) => (i + 1) % candidates.length);
          return;
        }
        if (key.return) {
          // Commit the selected candidate.
          const picked = candidates[selectedIdx] ?? candidates[0];
          if (picked !== undefined) {
            const line = `/${picked.name}`;
            props.onSubmit(line);
            setSelectedIdx(0);
            return;
          }
        }
        if (key.escape) {
          setSelectedIdx(0);
          props.onDropdownDismiss?.();
          return;
        }
        // Fall through for typing — let the reducer update buffer.
      } else {
        // reset selection when not showing
        if (selectedIdx !== 0) setSelectedIdx(0);
      }

      // ---- Submit on Enter ----------------------------------------------
      if (key.return) {
        const line = state.input.value;
        props.onSubmit(line);
        return;
      }

      // ---- Default: translate and hand to reducer ----------------------
      const translated = translateInkKey(input, key);
      props.onKey(translated);
    },
    { isActive: disabled !== true },
  );

  // Render the line with a visible cursor block.
  const { value, cursor } = state.input;
  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1);
  const after = value.slice(cursor + 1);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">❯ </Text>
        <Text>{before}</Text>
        <Text inverse>{at.length > 0 ? at : " "}</Text>
        <Text>{after}</Text>
      </Box>
      {showDropdown && candidates.length > 0 ? (
        <Dropdown
          registry={registry}
          query={query}
          selectedIndex={selectedIdx % candidates.length}
        />
      ) : null}
    </Box>
  );
}
