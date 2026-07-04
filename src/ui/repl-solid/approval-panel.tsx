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
import { computeDiff, compactDiff, toUnifiedDiff } from "./diff/compute.js";
import { theme } from "./theme.js";
import { codeSyntaxStyle, filetypeFromPath, treeSitterClient } from "./syntax.js";
import { validateDestructive } from "../../tools/tier0/bash-validation/destructive.js";

export interface ApprovalPanelProps {
  readonly pending: PendingPermission;
  /** Show full diff / uncapped preview (Ctrl+E, doc 49 Phase D2). */
  readonly expanded?: boolean;
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
  const filePath = getInputField(input, "file_path") ?? getInputField(input, "path") ?? "";
  if (filePath) result.push(`+${diff.added} -${diff.removed} ${filePath}`);
  for (const dl of compacted) {
    const prefix = dl.kind === "add" ? "+ " : dl.kind === "delete" ? "- " : "  ";
    result.push(`${prefix}${dl.text}`);
  }
  return { lines: result, hasHidden: hiddenChanges > 0 };
}

function renderWritePreview(input: unknown, expanded: boolean): string[] {
  const filePath = getInputField(input, "file_path") ?? getInputField(input, "path") ?? "";
  const content = getInputField(input, "content") ?? "";
  const lines: string[] = [];
  if (filePath) lines.push(`new file: ${filePath}`);
  const contentLines = content.split("\n");
  const cap = expanded ? contentLines.length : 10;
  const preview = contentLines.slice(0, cap);
  lines.push(...preview.map((l) => `+ ${l}`));
  if (contentLines.length > cap) {
    lines.push(`  … ${contentLines.length - cap} more lines`);
  }
  return lines;
}

function renderGenericPreview(
  toolName: string,
  input: unknown,
  expanded: boolean,
): string[] {
  const lines: string[] = [];
  if (input !== null && typeof input === "object") {
    const entries = Object.entries(input as Record<string, unknown>);
    const cap = expanded ? entries.length : 3;
    for (const [key, val] of entries.slice(0, cap)) {
      const valStr = typeof val === "string" ? val : JSON.stringify(val);
      const limit = expanded ? 400 : 80;
      const truncated = valStr.length > limit ? valStr.slice(0, limit) + "…" : valStr;
      lines.push(`${key}: ${truncated}`);
    }
    if (entries.length > cap) {
      lines.push(`… ${entries.length - cap} more fields`);
    }
  }
  return lines;
}

export function ApprovalPanel(props: ApprovalPanelProps) {
  const toolName = () => props.pending.toolName;
  const input = () => props.pending.input;
  const expanded = () => props.expanded ?? false;
  const isEdit = () => toolName() === "edit_file" || toolName() === "multi_edit";

  // Full unified diff for the expanded edit view (doc 49 Phase D2), rendered
  // via <diff> for line numbers + syntax highlighting.
  const editDiff = (): string | undefined => {
    if (!isEdit()) return undefined;
    const oldStr =
      getInputField(input(), "old_string") ?? getInputField(input(), "old_str") ?? "";
    const newStr =
      getInputField(input(), "new_string") ?? getInputField(input(), "new_str") ?? "";
    if (oldStr.length === 0 && newStr.length === 0) return undefined;
    const path = getInputField(input(), "file_path") ?? getInputField(input(), "path");
    return toUnifiedDiff(oldStr, newStr, path);
  };
  const editFiletype = () =>
    filetypeFromPath(
      getInputField(input(), "file_path") ?? getInputField(input(), "path"),
    );
  const tsClient = treeSitterClient();
  const useDiff = () => expanded() && isEdit() && (editDiff()?.length ?? 0) > 0;

  const previewLines = (): string[] => {
    const name = toolName();
    if (name === "bash" || name === "shell_exec") {
      return renderBashPreview(input());
    }
    if (name === "edit_file" || name === "multi_edit") {
      return renderEditPreview(input()).lines;
    }
    if (name === "write_file") {
      return renderWritePreview(input(), expanded());
    }
    return renderGenericPreview(name, input(), expanded());
  };

  const hasHiddenChanges = (): boolean => {
    const name = toolName();
    if (name === "edit_file" || name === "multi_edit") {
      return renderEditPreview(input()).hasHidden;
    }
    return false;
  };

  // Ctrl+E is offered whenever there is more to show (hidden edit changes) or
  // an edit that can render as a full diff; and always shown while expanded so
  // the user can collapse again.
  const offersExpand = () => hasHiddenChanges() || isEdit();

  // Destructive-command warning for bash approvals (doc 49 Phase D5), reusing
  // the bash gate's always-warn classifier so the label matches enforcement.
  const bashDanger = (): string | undefined => {
    const name = toolName();
    if (name !== "bash" && name !== "shell_exec") return undefined;
    const cmd = getInputField(input(), "command");
    if (cmd === undefined) return undefined;
    const result = validateDestructive(cmd);
    return result.kind === "warn" ? result.message : undefined;
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
            getInputField(input(), "path") ??
            getInputField(input(), "command")?.split("\n")[0]?.slice(0, 40) ??
            ""}
        </text>
      </box>
      <Show when={bashDanger() !== undefined}>
        <text fg={theme.warning} bold>⚠ destructive · {bashDanger()}</text>
      </Show>
      <text />
      <Show
        when={useDiff()}
        fallback={
          <>
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
            <Show when={hasHiddenChanges() && !expanded()}>
              <text fg={theme.subtle}>  … more changes (ctrl+e to expand)</text>
            </Show>
          </>
        }
      >
        <box flexDirection="column">
          <diff
            diff={editDiff()!}
            view="unified"
            showLineNumbers={true}
            syntaxStyle={codeSyntaxStyle()}
            addedSignColor={theme.diffAdd}
            removedSignColor={theme.diffRemove}
            {...(editFiletype() !== undefined ? { filetype: editFiletype()! } : {})}
            {...(tsClient !== undefined ? { treeSitterClient: tsClient } : {})}
          />
        </box>
      </Show>
      <text />
      <text fg={theme.muted}>mode: {props.pending.currentMode}</text>
      <Show when={props.pending.reason !== undefined && props.pending.reason!.length > 0}>
        <text fg={theme.subtle}>reason: {props.pending.reason}</text>
      </Show>
      <text fg={theme.warning}>[y] approve  [a] always (session)  [n] deny{offersExpand() ? (expanded() ? "  [ctrl+e] collapse" : "  [ctrl+e] full diff") : ""}</text>
    </box>
  );
}
