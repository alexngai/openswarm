/**
 * dropdown.tsx — slash-command tab-completion dropdown for OpenTUI/Solid.
 *
 * Rendering-only. The parent component owns selection index and keyboard
 * handling; this component paints the filtered candidate list and highlights
 * the selected row.
 */

import { For, Show } from "solid-js";
import { theme } from "./theme.js";

export interface DropdownCandidate {
  readonly name: string;
  readonly description: string;
}

export interface DropdownProps {
  readonly candidates: DropdownCandidate[];
  readonly selectedIndex: number;
  readonly maxRows?: number;
}

export function Dropdown(props: DropdownProps): any {
  const maxRows = () => props.maxRows ?? 6;
  const visible = () => props.candidates.slice(0, maxRows());

  return (
    <Show when={props.candidates.length > 1}>
      <box borderStyle="rounded" borderColor={theme.border} flexDirection="column">
        <For each={visible()}>
          {(candidate, i) => {
            const selected = () => i() === props.selectedIndex;
            return (
              <box flexDirection="row">
                <text
                  fg={selected() ? theme.accent : theme.text}
                  bold={selected()}
                >
                  /{candidate.name}
                </text>
                <text fg={theme.muted}> — {candidate.description}</text>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
