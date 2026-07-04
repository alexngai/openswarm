/**
 * tool-chip.tsx — single-line chip header with expandable body.
 *
 * Renders a tool call as:
 *   ● Using bash  $ deploy.sh        (pending)
 *   ✓ Used bash  $ deploy.sh  exit:0 (success)
 *   ✗ Used bash  $ deploy.sh  exit:1 (error)
 *
 * Ctrl+O toggles body visibility via globalExpand in state.
 *
 * Inspired by Kimi Code's tool-call.ts chip pattern: header stays static,
 * body rebuilds on expand/collapse.
 */

import { Show, For, createSignal, onMount, onCleanup } from "solid-js";
import type { ToolCallState } from "../../repl/state.js";
import { getRenderer } from "../tools/registry.js";
import { theme } from "../theme.js";
import { codeSyntaxStyle, treeSitterClient } from "../syntax.js";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ToolChipProps {
  readonly tc: ToolCallState;
  readonly expanded: boolean;
}

export function ToolChip(props: ToolChipProps) {
  const renderer = () => getRenderer(props.tc.name);

  // Streaming indicator — braille spinner while args are arriving.
  const [spinnerFrame, setSpinnerFrame] = createSignal(0);
  onMount(() => {
    const interval = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
    }, 80);
    onCleanup(() => clearInterval(interval));
  });

  const bullet = () => {
    if (props.tc.pending) {
      if (props.tc.streamingArgs.length > 0) {
        return BRAILLE_FRAMES[spinnerFrame()] ?? "⠋";
      }
      return "●";
    }
    if (props.tc.isError) return "✗";
    return "✓";
  };

  const bulletColor = () => {
    if (props.tc.pending) return theme.bulletPending;
    if (props.tc.isError) return theme.bulletError;
    return theme.bulletSuccess;
  };

  const verb = () => (props.tc.pending ? "Using" : "Used");

  const chip = () => renderer().chip(props.tc);
  const keyArg = () => renderer().keyArg(props.tc);
  const bodyLines = () => renderer().bodyLines(props.tc);

  // Syntax-highlight source-code bodies (read_file / write_file) via <code>
  // when the renderer supplies a filetype and a Tree-sitter client is live
  // (doc 49 Phase A2). Edit-style tools render a full <diff> (line numbers +
  // highlighted hunks, doc 49 Phase B2). Both fall back to the plain text loop.
  const tsClient = treeSitterClient();
  const bodyFiletype = () => renderer().bodyFiletype?.(props.tc);
  const diffText = () => renderer().diffText?.(props.tc);
  const useDiff = () => {
    const d = diffText();
    return d !== undefined && d.length > 0;
  };
  const useCode = () =>
    !useDiff() && bodyFiletype() !== undefined && tsClient !== undefined;

  const headerText = () => {
    const parts = [verb(), props.tc.name];
    const ka = keyArg();
    if (ka.length > 0) parts.push(ka);
    const ch = chip();
    if (ch.length > 0) parts.push(` ${ch}`);
    return parts.join("  ");
  };

  return (
    <box flexDirection="column">
      <box>
        <text fg={bulletColor()}>{bullet()} </text>
        <text fg={theme.text}>{headerText()}</text>
      </box>
      <Show when={props.expanded && !props.tc.pending && (useDiff() || bodyLines().length > 0)}>
        <box flexDirection="column" paddingLeft={3}>
          <Show
            when={useDiff()}
            fallback={
              <Show
                when={useCode()}
                fallback={
                  <For each={bodyLines() as string[]}>
                    {(line) => {
                      const fg =
                        line.startsWith("+ ") ? theme.diffAdd
                        : line.startsWith("- ") ? theme.diffRemove
                        : theme.muted;
                      return <text fg={fg}>{line}</text>;
                    }}
                  </For>
                }
              >
                <code
                  content={(bodyLines() as string[]).join("\n")}
                  filetype={bodyFiletype()!}
                  syntaxStyle={codeSyntaxStyle()}
                  treeSitterClient={tsClient!}
                  conceal={false}
                  drawUnstyledText={true}
                />
              </Show>
            }
          >
            <diff
              diff={diffText()!}
              view="unified"
              showLineNumbers={true}
              syntaxStyle={codeSyntaxStyle()}
              addedSignColor={theme.diffAdd}
              removedSignColor={theme.diffRemove}
              {...(bodyFiletype() !== undefined ? { filetype: bodyFiletype()! } : {})}
              {...(tsClient !== undefined ? { treeSitterClient: tsClient } : {})}
            />
          </Show>
        </box>
      </Show>
    </box>
  );
}
