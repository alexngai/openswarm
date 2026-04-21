/**
 * dropdown.tsx — slash-command tab-completion dropdown.
 *
 * Rendering-only. The parent `<Input>` owns the selection index and keyboard
 * handling; this component simply paints the filtered candidate list and
 * reverse-highlights the selected row.
 */

import React from "react";
import { Box, Text } from "ink";
import type { SlashCommandRegistry } from "./state.js";

export interface DropdownProps {
  readonly registry: SlashCommandRegistry;
  readonly query: string; // prefix after the leading `/`
  readonly selectedIndex: number;
  readonly maxRows?: number;
}

/** Returns the candidate list matching `query` (pure, reusable for input.tsx). */
export function filterCandidates(
  registry: SlashCommandRegistry,
  query: string,
): ReadonlyArray<{ readonly name: string; readonly description: string }> {
  const q = query.toLowerCase();
  return registry.list().filter((c) => c.name.toLowerCase().startsWith(q));
}

export function Dropdown(props: DropdownProps): React.ReactElement | null {
  const candidates = filterCandidates(props.registry, props.query);
  if (candidates.length === 0) return null;
  const maxRows = props.maxRows ?? 6;
  const shown = candidates.slice(0, maxRows);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((c, i) => {
        const selected = i === props.selectedIndex;
        return (
          <Box key={c.name}>
            <Text color={selected ? "black" : "white"} backgroundColor={selected ? "cyan" : undefined}>
              /{c.name}
            </Text>
            <Text dimColor> — {c.description}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
