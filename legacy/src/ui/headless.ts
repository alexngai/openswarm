import type { NormalizedEvent } from "../core/types.js";
import { ToolInputAccumulator, parseToolInput } from "../core/tool-input.js";

export interface HeadlessOptions {
  readonly out?: NodeJS.WritableStream;
}

/** Consume the event stream and emit JSONL to out (default process.stdout). */
export async function runHeadless(
  events: AsyncIterable<NormalizedEvent>,
  options?: HeadlessOptions,
): Promise<void> {
  const out = options?.out ?? process.stdout;
  const acc = new ToolInputAccumulator();
  for await (const event of events) {
    if (event.type === "tool_use_start") {
      acc.start(event.id, undefined);
      out.write(JSON.stringify(event) + "\n");
      continue;
    }
    if (event.type === "tool_use_input") {
      acc.append(event.id, event.jsonDelta);
      out.write(JSON.stringify(event) + "\n");
      continue;
    }
    if (event.type === "tool_use_end") {
      // Attach the reassembled `input` object; omit it entirely when the
      // buffer is empty or malformed (fallback "undefined").
      const input = parseToolInput(acc.end(event.id)?.raw ?? "");
      out.write(JSON.stringify(input === undefined ? event : { ...event, input }) + "\n");
      continue;
    }
    out.write(JSON.stringify(event) + "\n");
  }
}
