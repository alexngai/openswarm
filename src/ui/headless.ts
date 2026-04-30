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
  for await (const event of events) {
    out.write(JSON.stringify(event) + "\n");
  }
}
