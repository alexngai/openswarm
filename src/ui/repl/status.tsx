/**
 * status.tsx — bottom status bar.
 *
 * Shows the current REPL state, permission mode, short session id, and a
 * cumulative token count. The token count is retrieved via a caller-supplied
 * getter — Phase 5 wires this up to the real ClaudeAgentSdkEngine usage
 * accumulator; Phase 2 passes a stub that returns 0.
 */

import React from "react";
import { Box, Text } from "ink";
import type { ReplState } from "./state.js";
import { Spinner } from "./spinner.js";

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

function stateColor(name: ReplState["name"]): string {
  switch (name) {
    case "idle":
      return "green";
    case "streaming":
      return "cyan";
    case "awaiting-permission":
      return "yellow";
    case "compact":
      return "magenta";
    case "shutdown":
      return "gray";
  }
}

export function Status(props: StatusProps): React.ReactElement {
  const { state, model, getTokens } = props;
  const showSpinner = state.name === "streaming" || state.name === "compact";
  const pending = state.pendingPermission;
  return (
    <Box flexDirection="column" marginTop={1}>
      {pending !== undefined ? (
        <Box>
          <Text color="yellow">
            permission: {pending.toolName} — /approve or /deny
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color={stateColor(state.name)}>[{state.name}]</Text>
        <Text> </Text>
        <Text dimColor>
          {model} · {state.permissionMode} · session {shortSession(state.sessionId)} ·{" "}
          tokens {getTokens()}
        </Text>
        {showSpinner ? (
          <Box marginLeft={1}>
            <Spinner active={true} />
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
