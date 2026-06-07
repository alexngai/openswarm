/**
 * tool-chip.tsx — single-line chip header with expandable body.
 *
 * Renders a tool call as:
 *   ● Using bash  $ deploy.sh        (pending)
 *   ✓ Used bash  $ deploy.sh  exit:0 (success)
 *   ✗ Used bash  $ deploy.sh  exit:1 (error)
 *
 * Ctrl+O toggles body visibility via globalExpand in state.
 *
 * Inspired by Kimi Code's tool-call.ts chip pattern: header stays static,
 * body rebuilds on expand/collapse.
 */

import { Show, For } from "solid-js";
import type { ToolCallState } from "../../repl/state.js";
import { getRenderer } from "../tools/registry.js";
import { theme } from "../theme.js";

export interface ToolChipProps {
  readonly tc: ToolCallState;
  readonly expanded: boolean;
}

export function ToolChip(props: ToolChipProps) {
  const renderer = () => getRenderer(props.tc.name);

  const bullet = () => {
    if (props.tc.pending) return "●";
    if (props.tc.isError) return "✗";
    return "✓";
  };

  const bulletColor = () => {
    if (props.tc.pending) return theme.bulletPending;
    if (props.tc.isError) return theme.bulletError;
    return theme.bulletSuccess;
  };

  const verb = () => (props.tc.pending ? "Using" : "Used");

  const chip = () => renderer().chip(props.tc);
  const keyArg = () => renderer().keyArg(props.tc);
  const bodyLines = () => renderer().bodyLines(props.tc);

  const headerText = () => {
    const parts = [verb(), props.tc.name];
    const ka = keyArg();
    if (ka.length > 0) parts.push(ka);
    const ch = chip();
    if (ch.length > 0) parts.push(` ${ch}`);
    return parts.join("  ");
  };

  return (
    <box flexDirection="column">
      <box>
        <text fg={bulletColor()}>{bullet()} </text>
        <text fg={theme.text}>{headerText()}</text>
      </box>
      <Show when={props.expanded && !props.tc.pending && bodyLines().length > 0}>
        <box flexDirection="column" paddingLeft={3}>
          <For each={bodyLines() as string[]}>
            {(line) => {
              const fg =
                line.startsWith("+ ") ? theme.diffAdd
                : line.startsWith("- ") ? theme.diffRemove
                : theme.muted;
              return <text fg={fg}>{line}</text>;
            }}
          </For>
        </box>
      </Show>
    </box>
  );
}
