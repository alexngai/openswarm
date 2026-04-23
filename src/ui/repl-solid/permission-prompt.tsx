/**
 * permission-prompt.tsx — inline y/N approval prompt.
 *
 * Phase 2 design lock (doc 17): rendered as an inline transcript entry when
 * state.name === "awaiting-permission". Content matches claw
 * (`main.rs:7379-7388`): tool name, input JSON, current mode, required
 * permission, optional reason. Suffix: `Approve this tool call? [y/N]: `.
 *
 * Key handling lives in app.tsx (routed via state name) — this component
 * only renders. Keeps the component dumb and testable.
 */

import type { PendingPermission } from "../repl/state.js";
import { theme } from "./theme.js";

// Match claw's input truncation behaviour — keep the prompt scannable.
const INPUT_MAX_CHARS = 500;

export interface PermissionPromptProps {
  readonly pending: PendingPermission;
}

function formatInput(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input, null, 2);
  } catch {
    text = String(input);
  }
  if (text.length > INPUT_MAX_CHARS) {
    return text.slice(0, INPUT_MAX_CHARS) + "\n…(truncated)";
  }
  return text;
}

export function PermissionPrompt(props: PermissionPromptProps) {
  return (
    <box
      flexDirection="column"
      padding={1}
      borderStyle="single"
      borderColor={theme.warning}
    >
      <text fg={theme.warning}>Approval required</text>
      <text>tool: {props.pending.toolName}</text>
      <text>input:</text>
      <text>{formatInput(props.pending.input)}</text>
      <text>current mode: {props.pending.currentMode}</text>
      <text>required permission: {props.pending.requiredPermission}</text>
      {props.pending.reason !== undefined && props.pending.reason.length > 0 ? (
        <text>reason: {props.pending.reason}</text>
      ) : null}
      <text fg={theme.warning}>Approve this tool call? [y/N]: </text>
    </box>
  );
}
