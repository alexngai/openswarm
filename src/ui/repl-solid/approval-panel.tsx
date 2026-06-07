/**
 * approval-panel.tsx — contextual approval UI replacing raw-JSON permission prompt.
 *
 * Shows tool-specific previews:
 *   - edit_file/multi_edit: compact diff preview
 *   - bash: $ command with danger label
 *   - write_file: file creation preview
 *   - other tools: tool name + key argument
 *
 * Key handling stays in app.tsx (y/N routing unchanged). This component
 * is display-only.
 *
 * Inspired by Kimi Code's approval-panel.ts display block pattern.
 */

import { For, Show } from "solid-js";
import type { PendingPermission } from "../repl/state.js";
import { computeDiff, compactDiff } from "./diff/compute.js";
import { theme } from "./theme.js";

export interface ApprovalPanelProps {
  readonly pending: PendingPermission;
}

function getInputField(input: unknown, key: string): string | undefined {
  if (input !== null && typeof input === "object") {
    const val = (input as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function renderBashPreview(input: unknown): string[] {
  const cmd = getInputField(input, "command");
  if (cmd === undefined) return [];
  const lines = cmd.split("\n");
  return lines.map((l, i) => (i === 0 ? `$ ${l}` : `  ${l}`));
}

function renderEditPreview(input: unknown): { lines: string[]; hasHidden: boolean } {
  const oldStr = getInputField(input, "old_string") ?? getInputField(input, "old_str") ?? "";
  const newStr = getInputField(input, "new_string") ?? getInputField(input, "new_str") ?? "";
  if (!oldStr && !newStr) return { lines: [], hasHidden: false };
  const diff = computeDiff(oldStr, newStr);
  const { lines: compacted, hiddenChanges } = compactDiff(diff, {
    contextLines: 3,
    maxChanges: 8,
  });
  const result: string[] = [];
  const filePath = getInputField(input, "file_path") ?? "";
  if (filePath) result.push(`+${diff.added} -${diff.removed} ${filePath}`);
  for (const dl of compacted) {
    const prefix = dl.kind === "add" ? "+ " : dl.kind === "delete" ? "- " : "  ";
    result.push(`${prefix}${dl.text}`);
  }
  return { lines: result, hasHidden: hiddenChanges > 0 };
}

function renderWritePreview(input: unknown): string[] {
  const filePath = getInputField(input, "file_path") ?? "";
  const content = getInputField(input, "content") ?? "";
  const lines: string[] = [];
  if (filePath) lines.push(`new file: ${filePath}`);
  const contentLines = content.split("\n");
  const preview = contentLines.slice(0, 10);
  lines.push(...preview.map((l) => `+ ${l}`));
  if (contentLines.length > 10) {
    lines.push(`  … ${contentLines.length - 10} more lines`);
  }
  return lines;
}

function renderGenericPreview(toolName: string, input: unknown): string[] {
  const lines: string[] = [];
  if (input !== null && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>);
    for (const [key, val] of entries.slice(0, 3)) {
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      const truncated = valStr.length > 80 ? valStr.slice(0, 80) + "…" : valStr;
      lines.push(`${key}: ${truncated}`);
    }
    if (entries.length > 3) {
      lines.push(`… ${entries.length - 3} more fields`);
    }
  }
  return lines;
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  const toolName = () => props.pending.toolName;
  const input = () => props.pending.input;

  const previewLines = (): string[] => {
    const name = toolName();
    if (name === "bash" || name === "shell_exec") {
      return renderBashPreview(input());
    }
    if (name === "edit_file" || name === "multi_edit") {
      return renderEditPreview(input()).lines;
    }
    if (name === "write_file") {
      return renderWritePreview(input());
    }
    return renderGenericPreview(name, input());
  };

  const hasHiddenChanges = (): boolean => {
    const name = toolName();
    if (name === "edit_file" || name === "multi_edit") {
      return renderEditPreview(input()).hasHidden;
    }
    return false;
  };

  return (
    <box
      flexDirection="column"
      padding={1}
      borderStyle="single"
      borderColor={theme.warning}
    >
      <text fg={theme.warning} bold>Approval Required</text>
      <text />
      <box>
        <text fg={theme.text} bold>{toolName()}</text>
        <text fg={theme.muted}>
          {"  "}
          {getInputField(input(), "file_path") ??
            getInputField(input(), "command")?.split("\n")[0]?.slice(0, 40) ??
            ""}
        </text>
      </box>
      <text />
      <Show when={previewLines().length > 0}>
        <box flexDirection="column">
          <For each={previewLines()}>
            {(line) => {
              const fg =
                line.startsWith("+ ") ? theme.diffAdd
                : line.startsWith("- ") ? theme.diffRemove
                : line.startsWith("$ ") ? theme.accent
                : theme.muted;
              return <text fg={fg}>{line}</text>;
            }}
          </For>
        </box>
      </Show>
      <Show when={hasHiddenChanges()}>
        <text fg={theme.subtle}>  … more changes (ctrl+e to expand)</text>
      </Show>
      <text />
      <text fg={theme.muted}>mode: {props.pending.currentMode}</text>
      <Show when={props.pending.reason !== undefined && props.pending.reason!.length > 0}>
        <text fg={theme.subtle}>reason: {props.pending.reason}</text>
      </Show>
      <text fg={theme.warning}>[y] approve  [n] deny  {hasHiddenChanges() ? " [ctrl+e] full diff" : ""}</text>
    </box>
  );
}
