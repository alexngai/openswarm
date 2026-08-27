import { openDurableAppend } from "../swarm/durable-append.js";
import type { EventEmitter } from "node:events";
import type { LaneEvent } from "../swarm/events.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";

export interface LaneTraceRecorder {
  close(): Promise<void>;
}

export function attachLaneTrace(
  host: StandaloneHost,
  traceOutput: string | undefined,
): LaneTraceRecorder | undefined {
  if (traceOutput === undefined) return undefined;

  // Held as the pending open because `attachLaneTrace` is synchronous. Writes
  // chain onto it, which preserves emission order.
  const opening = openDurableAppend(traceOutput);
  const bus = (host as unknown as { readonly events: EventEmitter }).events;
  const handler = (event: LaneEvent): void => {
    void opening
      .then((stream) => {
        stream.write(`${JSON.stringify(event)}\n`);
      })
      .catch(() => {
        /* trace is diagnostic — never take the run down with it */
      });
  };

  bus.on("lane_event", handler);

  return {
    close: async () => {
      bus.off("lane_event", handler);
      const stream = await opening.catch(() => null);
      if (stream !== null) await new Promise<void>((resolve) => stream.end(() => resolve()));
    },
  };
}
