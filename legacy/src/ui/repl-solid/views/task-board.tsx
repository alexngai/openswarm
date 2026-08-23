/**
 * task-board.tsx — Task list display for multi-agent runs.
 *
 * Phase 5: shows tasks with status icons, titles, and assignees.
 * Supports j/k navigation with a selected index.
 */

import { createMemo, For } from "solid-js";
import type { TaskState } from "../../repl/state.js";
import { theme } from "../theme.js";

export interface TaskBoardProps {
  readonly tasks: Readonly<Record<string, TaskState>>;
  readonly selectedIndex?: number;
}

const statusIcon: Record<string, string> = {
  pending: "◌",
  active: "↻",
  done: "✓",
  failed: "✗",
};

const statusColor: Record<string, string> = {
  pending: theme.muted,
  active: theme.accent,
  done: theme.bulletSuccess,
  failed: theme.bulletError,
};

export function TaskBoard(props: TaskBoardProps) {
  const taskList = createMemo(() => Object.values(props.tasks));

  return (
    <box flexDirection="column" flexGrow={1}>
      <text fg={theme.accent} bold>Tasks</text>
      <For each={taskList()}>
        {(task, idx) => {
          const icon = statusIcon[task.status] ?? "?";
          const color = statusColor[task.status] ?? theme.text;
          const selected = () => idx() === (props.selectedIndex ?? -1);
          const assignee = task.assignee ? ` → ${task.assignee}` : "";

          return (
            <text
              fg={selected() ? theme.accent : color}
              bold={selected()}
            >
              {icon} {task.title}{assignee}
            </text>
          );
        }}
      </For>
    </box>
  );
}
