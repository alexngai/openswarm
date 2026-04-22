/**
 * transcript.tsx — renders past turns.
 *
 * Assistant text renders as plain `<Text>` — ink-markdown was removed
 * because it is a CJS module whose `require("ink")` fails against
 * ink@5's ESM graph (yoga-wasm-web contains top-level await;
 * `ERR_REQUIRE_ASYNC_MODULE` on every TTY invocation, all Node
 * versions — the limitation is "CJS require cannot satisfy ESM+TLA"
 * and is not tied to any Node release). Markdown styling in the TUI
 * is a follow-up when we adopt an ESM-native renderer.
 *
 * Full rendering of tool input / output is out of scope — tool rows
 * show name + summary only.
 */

import React from "react";
import { Box, Text } from "ink";
import type { TranscriptEntry } from "./state.js";

export interface TranscriptProps {
  readonly entries: readonly TranscriptEntry[];
}

function UserEntry(props: { text: string }): React.ReactElement {
  return (
    <Box>
      <Text color="cyan">&gt; {props.text}</Text>
    </Box>
  );
}

function AssistantEntry(props: { text: string }): React.ReactElement {
  if (props.text.length === 0) return <Box />;
  return (
    <Box flexDirection="column">
      <Text>{props.text}</Text>
    </Box>
  );
}

function ToolEntry(props: {
  name: string;
  summary?: string;
}): React.ReactElement {
  const detail = props.summary !== undefined && props.summary.length > 0 ? ` — ${props.summary}` : "";
  return (
    <Box>
      <Text color="yellow">[{props.name}]</Text>
      <Text dimColor>{detail}</Text>
    </Box>
  );
}

function SystemEntry(props: { text: string }): React.ReactElement {
  return (
    <Box>
      <Text dimColor italic>
        {props.text}
      </Text>
    </Box>
  );
}

export function Transcript(props: TranscriptProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {props.entries.map((entry) => {
        switch (entry.kind) {
          case "user":
            return <UserEntry key={entry.id} text={entry.text} />;
          case "assistant":
            return <AssistantEntry key={entry.id} text={entry.text} />;
          case "tool":
            return (
              <ToolEntry
                key={entry.id}
                name={entry.tool?.name ?? "tool"}
                summary={entry.tool?.summary ?? entry.text}
              />
            );
          case "system":
            return <SystemEntry key={entry.id} text={entry.text} />;
        }
      })}
    </Box>
  );
}
