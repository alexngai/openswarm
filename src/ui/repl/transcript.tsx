/**
 * transcript.tsx — renders past turns.
 *
 * Assistant text is rendered as streaming markdown via ink-markdown. User,
 * tool, and system entries are plain text. Full rendering of tool input /
 * output is out of scope for Phase 2 — tool rows show name + summary only.
 */

import React from "react";
import { Box, Text } from "ink";
// ink-markdown is built against React 16 types; cast to any to sidestep the
// JSX element-type mismatch with React 19 @types/react (same workaround we
// used before the ink-REPL rewrite).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import MarkdownRaw from "ink-markdown";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Markdown: any = MarkdownRaw;
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
      <Markdown>{props.text}</Markdown>
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
