import type { NormalizedEvent } from "../core/types.js";

export interface HeadlessOptions {
  readonly out?: NodeJS.WritableStream;
}

/** Consume the event stream and emit JSONL to out (default process.stdout). */
export async function runHeadless(
  events: AsyncIterable<NormalizedEvent>,
  options?: HeadlessOptions,
): Promise<void> {
  const out = options?.out ?? process.stdout;
  const toolInputs = new Map<string, string>();
  for await (const event of events) {
    if (event.type === "tool_use_start") {
      toolInputs.set(event.id, "");
      out.write(JSON.stringify(event) + "\n");
      continue;
    }
    if (event.type === "tool_use_input") {
      toolInputs.set(event.id, (toolInputs.get(event.id) ?? "") + event.jsonDelta);
      out.write(JSON.stringify(event) + "\n");
      continue;
    }
    if (event.type === "tool_use_end") {
      const input = parseInput(toolInputs.get(event.id));
      toolInputs.delete(event.id);
      out.write(JSON.stringify(input === undefined ? event : { ...event, input }) + "\n");
      continue;
    }
    out.write(JSON.stringify(event) + "\n");
  }
}

function parseInput(json: string | undefined): unknown {
  if (!json) return undefined;
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
