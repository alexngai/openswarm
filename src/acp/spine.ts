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

/**
 * Which lane events the ACP spine persists. The shared recorded/live partition
 * drops `tool_use_input` as a high-frequency delta — but for `session/load`
 * replay we keep it (a few small jsonDelta fragments per tool call) so the
 * translator reconstructs full tool *arguments* on replay, exactly as live. The
 * voluminous delta — `text_delta` — stays dropped; the lead's prose is recovered
 * from its session JSONL instead (mergeLeadProse).
 */
function isAcpSpineEvent(event: LaneEvent): boolean {
  return isRecordedLaneEvent(event) || event.type === "tool_use_input";
}

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
  return path.join(baseDir(), "openswarm", "acp", safe);
}

/** The orchestration spine path for an ACP session. */
export function acpEventsPath(sessionId: string): string {
  return path.join(acpSessionDir(sessionId), "events.jsonl");
}

/**
 * The lead worker's session-sidecar path for an ACP session. Persists the
 * coordinator root's latest engine session id so `session/load` can resume the
 * conversation in a fresh process (the worker reads it on its first turn).
 */
export function acpSidecarPath(sessionId: string): string {
  return path.join(acpSessionDir(sessionId), "lead-session.json");
}

/**
 * Read a session's persisted spine, in wall-clock (`ts`) order. Skips the
 * `_metadata` header and any malformed line; returns `[]` when no spine exists.
 * Used by `session/load` (B1.4) to re-project a prior team session.
 */
export function readSpine(sessionId: string): LaneEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(acpEventsPath(sessionId), "utf8");
  } catch {
    return [];
  }
  const events: LaneEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const e = obj as { ts?: unknown; agentId?: unknown; type?: unknown };
    if (e.type === "_metadata") continue;
    if (
      typeof e.ts === "number" &&
      typeof e.agentId === "string" &&
      typeof e.type === "string"
    ) {
      events.push(obj as LaneEvent);
    }
  }
  // Stable sort by emit-time; the writer appends in arrival order but a defensive
  // sort keeps replay wall-clock-correct regardless.
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.ts - b.e.ts || a.i - b.i)
    .map(({ e }) => e);
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
        if (!isAcpSpineEvent(event)) return;
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
