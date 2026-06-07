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
 *
 * Tree-sitter wiring (Phase 3 follow-up, supersedes the design lock's
 * "out of scope" item): OpenTUI ships a `TreeSitterClient` with bundled
 * WASM grammars for typescript, javascript, markdown, markdown_inline,
 * and zig under `node_modules/@opentui/core/assets/`. Passing the client
 * to `<markdown>` enables language-aware highlighting inside fenced code
 * blocks (the markdown grammar's `injectionMapping.infoStringMap` routes
 * fenced info strings → filetype). The client is lazy-init'd, fire-and-
 * forget on `.initialize()`; if init fails we drop back to the
 * single-color `markup.raw.block` palette.
 *
 * Disable via `SWARM_HARNESS_DISABLE_TREE_SITTER=1` if the worker thread
 * causes problems (test isolation, packaging, slow init under load).
 */

import { For, Show, createMemo } from "solid-js";
import {
  SyntaxStyle,
  TreeSitterClient,
  getTreeSitterClient,
  type ThemeTokenStyle,
} from "@opentui/core";
import type { TranscriptEntry, ToolCallState } from "../repl/state.js";
import { entryColor, theme } from "./theme.js";
import { ToolChip } from "./entries/tool-chip.js";
import { ToolGroup } from "./entries/tool-group.js";
import { groupTranscriptEntries, type TranscriptItem } from "./entries/group.js";

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

// `undefined` = not yet attempted; client instance = success or pending init;
// `null` = attempted and failed terminally — don't retry.
let _treeSitterClient: TreeSitterClient | null | undefined = undefined;
function treeSitterClient(): TreeSitterClient | undefined {
  if (process.env.SWARM_HARNESS_DISABLE_TREE_SITTER === "1") return undefined;
  if (_treeSitterClient !== undefined) return _treeSitterClient ?? undefined;
  try {
    const client = getTreeSitterClient();
    // Fire-and-forget: the renderer queues highlight requests against the
    // client and they resolve once init completes. If init throws (worker
    // unavailable, WASM load failure, init timeout), drop to no-highlighting.
    void client.initialize().catch(() => {
      _treeSitterClient = null;
    });
    _treeSitterClient = client;
    return client;
  } catch {
    _treeSitterClient = null;
    return undefined;
  }
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
  /** Rich tool call states for ToolChip rendering (Phase 1a). */
  readonly toolCalls?: Readonly<Record<string, ToolCallState>>;
  /** Global expand flag for tool chips (Phase 1a). */
  readonly globalExpand?: boolean;
}

function UserEntry(props: { text: string }) {
  return (
    <box>
      <text fg={entryColor.user}>&gt; {props.text}</text>
    </box>
  );
}

function AssistantEntry(props: { text: string; streaming: boolean }) {
  const tsClient = treeSitterClient();
  return (
    <Show when={props.text.length > 0}>
      <box flexDirection="column">
        <markdown
          content={props.text}
          streaming={props.streaming}
          syntaxStyle={markdownSyntaxStyle()}
          {...(tsClient !== undefined ? { treeSitterClient: tsClient } : {})}
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
  const items = createMemo((): TranscriptItem[] =>
    groupTranscriptEntries(props.entries, props.toolCalls ?? {}),
  );

  const entryMap = createMemo(() => {
    const m = new Map<string, TranscriptEntry>();
    for (const e of props.entries) m.set(e.id, e);
    return m;
  });

  return (
    <scrollbox flexGrow={1}>
      <For each={items()}>
        {(item) => {
          if (item.type === "group") {
            const tcs = item.entryIds
              .map((id) => {
                const entry = entryMap().get(id);
                return entry?.toolCallId !== undefined
                  ? props.toolCalls?.[entry.toolCallId]
                  : undefined;
              })
              .filter((tc): tc is ToolCallState => tc !== undefined);
            return (
              <ToolGroup
                toolCalls={tcs}
                expanded={props.globalExpand ?? false}
              />
            );
          }
          const entry = item.entry;
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
            case "tool": {
              const tc = entry.toolCallId !== undefined
                ? props.toolCalls?.[entry.toolCallId]
                : undefined;
              if (tc !== undefined) {
                return (
                  <ToolChip
                    tc={tc}
                    expanded={props.globalExpand ?? false}
                  />
                );
              }
              return (
                <ToolEntry
                  name={entry.tool?.name ?? "tool"}
                  summary={entry.tool?.summary ?? entry.text}
                />
              );
            }
            case "system":
              return <SystemEntry text={entry.text} />;
          }
        }}
      </For>
    </scrollbox>
  );
}
