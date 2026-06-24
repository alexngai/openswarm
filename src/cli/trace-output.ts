import { dirname } from "node:path";
import * as fs from "node:fs";
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

  fs.mkdirSync(dirname(traceOutput), { recursive: true });
  const stream = fs.createWriteStream(traceOutput, { flags: "a" });
  const bus = (host as unknown as { readonly events: EventEmitter }).events;
  const handler = (event: LaneEvent): void => {
    stream.write(JSON.stringify(event) + "\n");
  };

  bus.on("lane_event", handler);

  return {
    close: async () => {
      bus.off("lane_event", handler);
      await new Promise<void>((resolve) => stream.end(resolve));
    },
  };
}
