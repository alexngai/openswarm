/**
 * transcript.tsx — OpenTUI/Solid port of src/ui/repl/transcript.tsx.
 *
 * Renders the transcript array from the REPL state. Each entry is rendered
 * as a <box> inside a <scrollbox> so overflow scrolls.
 *
 * Assistant entries use <markdown> from @opentui/core (Phase 3 stage B,
 * doc 17 P3.Q2): the dedicated markdown renderer supports native table
 * rendering, inline link/blockquote handling, and delegates fenced code
 * blocks to internal CodeRenderable instances. Plain `<code
 * filetype="markdown">` treats markdown as highlighted source; <markdown>
 * treats it as structured markup.
 *
 * Phase 3 stage A: `syntaxStyle` is a required OpenTUI prop on both <code>
 * and <markdown>. We lazy-initialise one shared default SyntaxStyle on first
 * access so test runs that never mount an assistant entry don't touch the
 * native FFI layer. Theme-tuned styles land in a later pass (doc 17 P3.Q3).
 */

import { For, Show } from "solid-js";
import { SyntaxStyle } from "@opentui/core";
import type { TranscriptEntry } from "../repl/state.js";
import { entryColor } from "./theme.js";

let _defaultSyntaxStyle: SyntaxStyle | null = null;
function defaultSyntaxStyle(): SyntaxStyle {
  if (_defaultSyntaxStyle === null) {
    _defaultSyntaxStyle = SyntaxStyle.create();
  }
  return _defaultSyntaxStyle;
}

export interface TranscriptProps {
  readonly entries: readonly TranscriptEntry[];
  /**
   * Id of the assistant entry currently being streamed into, or undefined
   * when no stream is active. Passed through to the matching entry's
   * `streaming` prop so OpenTUI can finalise trailing-block parsing once
   * streaming completes (doc 17 P3.Q4 / Markdown.d.ts:67-72).
   */
  readonly streamingEntryId?: string | undefined;
}

function UserEntry(props: { text: string }) {
  return (
    <box>
      <text fg={entryColor.user}>&gt; {props.text}</text>
    </box>
  );
}

function AssistantEntry(props: { text: string; streaming: boolean }) {
  return (
    <Show when={props.text.length > 0}>
      <box flexDirection="column">
        <markdown
          content={props.text}
          streaming={props.streaming}
          syntaxStyle={defaultSyntaxStyle()}
        />
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
              return (
                <AssistantEntry
                  text={entry.text}
                  streaming={entry.id === props.streamingEntryId}
                />
              );
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
