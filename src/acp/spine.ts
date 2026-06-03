/**
 * ACP team orchestration-spine recorder (B1.3, docs/34 §5).
 *
 * B0 streamed lane events to the client but persisted nothing, so an ACP team
 * session had no transcript to replay. This subscribes to the runner's lane bus
 * and appends the *recorded* lane events (the attributed orchestration spine) to
 * a per-session `events.jsonl`, mirroring the team-daemon writer
 * (team-daemon.ts:162-200): a one-time wire metadata header, then one JSON line
 * per recorded event. `isRecordedLaneEvent` drops live-only deltas (text_delta,
 * tool_use_input, heartbeat, worker_lifecycle_changed) so the wire stays lean
 * while keeping every `ts` + `agentId`-attributed event — the spine B1.4's
 * `session/load` re-projects in wall-clock order (docs/31 Q4).
 *
 * Keyed by ACP sessionId so `session/load` can find a prior session's spine.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMetadataEvent, isRecordedLaneEvent } from "../swarm/wire-protocol.js";
import type { LaneEvent } from "../swarm/events.js";
import type { TeamRunner } from "./team-runner.js";

/** Base runtime dir, matching team-paths' XDG_RUNTIME_DIR → TMPDIR fallback. */
function baseDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg !== undefined && xdg !== "") return xdg;
  return process.env.TMPDIR ?? os.tmpdir();
}

/** Per-session directory holding the ACP team's events.jsonl. */
export function acpSessionDir(sessionId: string): string {
  // sessionId is a server-minted UUID; sanitize defensively against separators.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(baseDir(), "swarm-harness", "acp", safe);
}

/** The orchestration spine path for an ACP session. */
export function acpEventsPath(sessionId: string): string {
  return path.join(acpSessionDir(sessionId), "events.jsonl");
}

export interface SpineRecorder {
  /** Begin recording the lane bus to the given session's events.jsonl. */
  start(sessionId: string): void;
  /** Detach the subscription and flush/close the file. */
  stop(): Promise<void>;
}

/**
 * Build a spine recorder bound to a runner's lane bus. One active recording at a
 * time (the ACP connection binds a single session, R1); a second `start` is a
 * no-op until `stop`.
 */
export function startSpineRecorder(
  runner: Pick<TeamRunner, "subscribeEvents">,
): SpineRecorder {
  let stream: fs.WriteStream | undefined;
  let unsubscribe: (() => void) | undefined;

  return {
    start(sessionId: string): void {
      if (stream !== undefined) return;
      const dir = acpSessionDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const eventsPath = path.join(dir, "events.jsonl");
      // Stamp the wire metadata header exactly once per file.
      let needsHeader = true;
      try {
        needsHeader = fs.statSync(eventsPath).size === 0;
      } catch {
        needsHeader = true;
      }
      const s = fs.createWriteStream(eventsPath, { flags: "a" });
      stream = s;
      if (needsHeader) {
        try {
          s.write(JSON.stringify(buildMetadataEvent("acp-team")) + "\n");
        } catch {
          /* writer broken — drop the header silently */
        }
      }
      unsubscribe = runner.subscribeEvents((event: LaneEvent) => {
        // Keep the recorded, attributed spine; drop live-only deltas. LaneEvent
        // already carries its own ts + agentId — preserve them.
        if (!isRecordedLaneEvent(event)) return;
        try {
          s.write(JSON.stringify(event) + "\n");
        } catch {
          /* writer broken — drop the event silently */
        }
      });
    },

    async stop(): Promise<void> {
      unsubscribe?.();
      unsubscribe = undefined;
      const s = stream;
      stream = undefined;
      if (s !== undefined) {
        await new Promise<void>((resolve) => s.end(resolve));
      }
    },
  };
}
