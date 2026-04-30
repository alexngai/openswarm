/**
 * transcript.tsx — OpenTUI/Solid port of src/ui/repl/transcript.tsx.
 *
 * Renders the transcript array from the REPL state. Each entry is rendered
 * as a <box> inside a <scrollbox> so overflow scrolls.
 *
 * Assistant entries use <markdown> from @opentui/core (doc 17 Phase 3
 * design lock, P3.Q1): the dedicated markdown renderer parses with `marked`,
 * conceals syntax markers, lays out tables natively, and delegates fenced
 * code blocks to an internal CodeRenderable per block (P3.Q2). Plain
 * `<code filetype="markdown">` would treat markdown as highlighted source
 * and leak `#` / `**` / `` ``` `` markers — wrong primitive for our goal.
 *
 * `syntaxStyle` is a required OpenTUI prop ([Markdown.d.ts:53](
 * node_modules/@opentui/core/renderables/Markdown.d.ts)). We resolve it via
 * `SyntaxStyle.fromTheme(...)` against [theme.ts](./theme.ts) so headings /
 * strong / em / inline-code colors stay coherent with the rest of the REPL
 * (doc 17 P3.Q3). Construction is lazy: the first assistant entry mounts
 * the FFI-backed style; tests that never render assistant content never
 * touch the native layer.
 */

import { For, Show } from "solid-js";
import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";
import type { TranscriptEntry } from "../repl/state.js";
import { entryColor, theme } from "./theme.js";

/**
 * Markdown scope → palette mapping. Scope names are the ones OpenTUI's
 * <markdown> emits internally for marked tokens (verified against
 * `node_modules/@opentui/core/index-*.js`):
 *   markup.heading, markup.strong, markup.italic, markup.strikethrough,
 *   markup.raw (inline code), markup.raw.block (fenced code),
 *   markup.link / markup.link.label / markup.link.url
 *
 * We register a small set so common markup gets palette-aligned colors.
 * Unmapped scopes fall back to OpenTUI's default — fine for now (doc 17
 * P3.Q3 explicitly defers a per-language Tree-sitter palette to later).
 */
const markdownTheme: ThemeTokenStyle[] = [
  { scope: ["markup.heading"], style: { foreground: theme.accent, bold: true } },
  { scope: ["markup.strong"], style: { foreground: theme.text, bold: true } },
  { scope: ["markup.italic"], style: { foreground: theme.text, italic: true } },
  { scope: ["markup.strikethrough"], style: { foreground: theme.muted, dim: true } },
  { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.success } },
  { scope: ["markup.link", "markup.link.label"], style: { foreground: theme.accent, underline: true } },
  { scope: ["markup.link.url"], style: { foreground: theme.muted, underline: true } },
];

let _markdownSyntaxStyle: SyntaxStyle | null = null;
function markdownSyntaxStyle(): SyntaxStyle {
  if (_markdownSyntaxStyle === null) {
    _markdownSyntaxStyle = SyntaxStyle.fromTheme(markdownTheme);
  }
  return _markdownSyntaxStyle;
}

export interface TranscriptProps {
  readonly entries: readonly TranscriptEntry[];
  /**
   * Id of the assistant entry currently being streamed into, or undefined
   * when no stream is active. Passed through to the matching entry's
   * `streaming` prop so OpenTUI can finalise trailing-block parsing once
   * streaming completes (doc 17 Phase 3 design lock P3.Q4 — relies on
   * OpenTUI's contract at Markdown.d.ts:62-72; no port of claw's
   * find_stream_safe_boundary needed unless that contract proves leaky).
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
          syntaxStyle={markdownSyntaxStyle()}
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
