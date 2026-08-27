/**
 * tool-group.tsx — Renders grouped consecutive tool calls as a collapsible
 * summary header with tree-line indented children.
 *
 * Phase 3: reduces transcript noise when the model runs several tools of the
 * same type in a row (e.g., 3 read_file calls → "Read 3 files · 142 lines").
 */

import { createMemo, For } from "solid-js";
import type { ToolCallState } from "../../repl/state.js";
import { ToolChip } from "./tool-chip.js";
import { theme } from "../theme.js";
import { getRenderer } from "../tools/registry.js";

export interface ToolGroupProps {
  readonly toolCalls: readonly ToolCallState[];
  readonly expanded: boolean;
}

function groupSummary(toolCalls: readonly ToolCallState[]): string {
  const name = toolCalls[0]?.name ?? "tool";
  const count = toolCalls.length;
  const allDone = toolCalls.every((tc) => !tc.pending);
  const anyError = toolCalls.some((tc) => tc.isError);

  const renderer = getRenderer(name);
  const keyArgs = toolCalls
    .map((tc) => renderer.keyArg(tc))
    .filter((k) => k.length > 0);

  const verb = allDone ? "Used" : "Using";
  const bullet = anyError ? "✗" : allDone ? "✓" : "●";

  let detail = "";
  if (name === "read_file" || name === "Read") {
    let totalLines = 0;
    for (const tc of toolCalls) {
      const match = tc.result?.match(/(\d+)\s*lines?/i);
      if (match) totalLines += parseInt(match[1], 10);
    }
    detail = totalLines > 0 ? ` · ${totalLines} lines` : "";
  } else if (name === "bash" || name === "Bash") {
    const exitCodes = toolCalls
      .filter((tc) => !tc.pending)
      .map((tc) => {
        const m = tc.result?.match(/exit(?:\s*code)?[:\s]*(\d+)/i);
        return m ? parseInt(m[1], 10) : undefined;
      })
      .filter((c) => c !== undefined);
    const failures = exitCodes.filter((c) => c !== 0).length;
    detail = failures > 0 ? ` · ${failures} failed` : "";
  }

  return `${bullet} ${verb} ${name} ×${count}${detail}  ${keyArgs.slice(0, 3).join(", ")}`;
}

export function ToolGroup(props: ToolGroupProps) {
  const summary = createMemo(() => groupSummary(props.toolCalls));
  const allDone = createMemo(() => props.toolCalls.every((tc) => !tc.pending));
  const anyError = createMemo(() => props.toolCalls.some((tc) => tc.isError));

  const bulletColor = createMemo(() =>
    anyError() ? theme.bulletError : allDone() ? theme.bulletSuccess : theme.bulletPending,
  );

  return (
    <box flexDirection="column">
      <text fg={bulletColor()}>{summary()}</text>
      <box flexDirection="column" height={props.expanded ? undefined : 0}>
        {props.expanded ? (
          <For each={props.toolCalls as ToolCallState[]}>
            {(tc) => (
              <box flexDirection="row">
                <text fg={theme.muted}>  ├ </text>
                <ToolChip tc={tc} expanded={false} />
              </box>
            )}
          </For>
        ) : (
          <text />
        )}
      </box>
    </box>
  );
}
