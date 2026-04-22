/**
 * transcript.tsx — OpenTUI/Solid port of src/ui/repl/transcript.tsx.
 *
 * Renders the transcript array from the REPL state. Each entry is rendered
 * as a <box> inside a <scrollbox> so overflow scrolls.
 *
 * Assistant entries use <code filetype="markdown" streaming={true}> from
 * @opentui/core for automatic markdown rendering and streaming support.
 * All other kinds render as plain <text>.
 */

import { For, Show } from "solid-js";
import type { TranscriptEntry } from "../repl/state.js";
import { entryColor } from "./theme.js";

export interface TranscriptProps {
  readonly entries: readonly TranscriptEntry[];
}

function UserEntry(props: { text: string }) {
  return (
    <box>
      <text fg={entryColor.user}>&gt; {props.text}</text>
    </box>
  );
}

function AssistantEntry(props: { text: string }) {
  return (
    <Show when={props.text.length > 0}>
      <box flexDirection="column">
        <code filetype="markdown" streaming={true} content={props.text} />
      </box>
    </Show>
  );
}

function ToolEntry(props: { name: string; summary?: string }) {
  const detail = () =>
    props.summary !== undefined && props.summary.length > 0
      ? ` — ${props.summary}`
      : "";
  return (
    <box>
      <text fg={entryColor.tool}>[{props.name}]{detail()}</text>
    </box>
  );
}

function SystemEntry(props: { text: string }) {
  return (
    <box>
      <text fg={entryColor.system}>{props.text}</text>
    </box>
  );
}

export function Transcript(props: TranscriptProps) {
  return (
    <scrollbox flexGrow={1}>
      <For each={props.entries as TranscriptEntry[]}>
        {(entry) => {
          switch (entry.kind) {
            case "user":
              return <UserEntry text={entry.text} />;
            case "assistant":
              return <AssistantEntry text={entry.text} />;
            case "tool":
              return (
                <ToolEntry
                  name={entry.tool?.name ?? "tool"}
                  summary={entry.tool?.summary ?? entry.text}
                />
              );
            case "system":
              return <SystemEntry text={entry.text} />;
          }
        }}
      </For>
    </scrollbox>
  );
}
