/**
 * status.tsx — bottom status bar (OpenTUI/Solid port).
 *
 * Shows the current REPL state name, model, permission mode, short session id,
 * token count, and — when a permission is pending — an inline alert.
 * Mirrors src/ui/repl/status.tsx responsibilities using OpenTUI primitives.
 */

import { createMemo, Show } from "solid-js";
import type { ReplState } from "../repl/state.js";
import { stateColor, theme } from "./theme.js";

export type TokenGetter = () => number;

export interface StatusProps {
  readonly state: ReplState;
  readonly model: string;
  readonly getTokens: TokenGetter;
}

function shortSession(id: string | undefined): string {
  if (id === undefined || id.length === 0) return "—";
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function Status(props: StatusProps) {
  const color = createMemo(() => stateColor[props.state.name]);

  const infoLine = createMemo(
    () =>
      `[${props.state.name}] ${props.model} · ${props.state.permissionMode} · session ${shortSession(props.state.sessionId)} · tokens ${props.getTokens()}`,
  );

  const permissionLine = createMemo(() => {
    const p = props.state.pendingPermission;
    if (!p) return "";
    // Phase 2: y/N prompt owns the interaction — no slash fallback.
    return `permission: ${p.toolName} — awaiting y/N`;
  });

  return (
    <box>
      <Show when={props.state.pendingPermission}>
        <text fg={theme.warning}>{permissionLine()}</text>
      </Show>
      <text fg={color()}>{infoLine()}</text>
    </box>
  );
}
