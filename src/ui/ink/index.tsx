import React, { useEffect, useState } from "react";
import { render, Text, Box } from "ink";
// ink-markdown was built against React 16 types; cast to any to avoid JSX
// element type mismatch with React 19 @types/react.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import MarkdownRaw from "ink-markdown";
const Markdown = MarkdownRaw as any;
import type { NormalizedEvent } from "../../core/types.js";

export interface InkRunOptions {
  readonly prompt: string;
}

/** Mount the ink UI, consume the event stream, resolve when stream ends. */
export async function renderInkApp(
  events: AsyncIterable<NormalizedEvent>,
  options: InkRunOptions,
): Promise<void> {
  return new Promise((resolve) => {
    interface ToolEntry {
      id: string;
      name: string;
      result?: string;
      isError?: boolean;
    }

    const App = () => {
      const [text, setText] = useState("");
      const [tools, setTools] = useState<ToolEntry[]>([]);
      const [done, setDone] = useState(false);
      const [error, setError] = useState<string | null>(null);

      useEffect(() => {
        (async () => {
          for await (const evt of events) {
            switch (evt.type) {
              case "text_delta":
                setText((prev) => prev + evt.text);
                break;
              case "tool_use_start":
                setTools((prev) => [...prev, { id: evt.id, name: evt.name }]);
                break;
              case "tool_result":
                setTools((prev) =>
                  prev.map((t) =>
                    t.id === evt.toolUseId
                      ? {
                          ...t,
                          result: evt.content.slice(0, 200),
                          isError: evt.isError,
                        }
                      : t,
                  ),
                );
                break;
              case "error":
                setError(evt.error.message);
                setDone(true);
                return;
              case "message_stop":
                setDone(true);
                return;
            }
          }
        })();
      }, []);

      useEffect(() => {
        if (done) {
          setTimeout(() => {
            app.unmount();
            resolve();
          }, 50);
        }
      }, [done]);

      return (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color="cyan">&gt; {options.prompt}</Text>
          </Box>
          {tools.map((t) => (
            <Box key={t.id}>
              <Text color={t.isError ? "red" : "yellow"}>
                [{t.name}]{t.result ? ` → ${t.result.split("\n")[0]}` : "..."}
              </Text>
            </Box>
          ))}
          {text.length > 0 && <Markdown>{text}</Markdown>}
          {error && <Text color="red">Error: {error}</Text>}
        </Box>
      );
    };

    const app = render(<App />);
  });
}
