/**
 * events-log.ts — the blessed `events.jsonl` team-daemon event contract.
 *
 * Phase 4.1d: rather than adding a bespoke `team_event` subscribe RPC over the
 * daemon's Unix socket, the daemon's per-team `events.jsonl` IS the official
 * follow contract for consumers (local `team logs --follow`, external tooling,
 * tests). This module is the stable, structured reader for that file so
 * consumers don't hand-roll JSONL parsing.
 *
 * Contract (stable):
 *   - The file is a wire-protocol JSONL stream (see wire-protocol.ts).
 *   - Line 1 is a `_metadata` record (WireMetadataEvent) carrying
 *     `protocol_version` + `producer: "team-daemon"`. It is written once, on
 *     first open; on daemon restart the file is appended to and the header is
 *     NOT repeated.
 *   - Every subsequent line is a recorded LaneEvent (see events.ts). Live-only
 *     high-frequency deltas (text_delta / tool_use_input / heartbeat) are
 *     filtered out at write time (isRecordedLaneEvent) and never appear here.
 *   - Lines are append-only and newline-terminated. A truncated trailing line
 *     (writer killed mid-write) is dropped by the reader.
 *   - Records written at an older protocol_version are upgraded through the
 *     wire-protocol migration chain before being surfaced.
 *
 * `team logs` streams the raw bytes for humans; this module is the programmatic
 * counterpart that yields parsed, migrated LaneEvents.
 */

import type { LaneEvent } from "./events.js";
import {
  applyMigrations,
  isMetadataEvent,
  iterateWireLines,
  resolveWireMigrations,
  WIRE_PROTOCOL_VERSION,
  type WireMetadataEvent,
} from "./wire-protocol.js";

/** Canonical filename of a team daemon's event log (per-team directory). */
export const EVENTS_LOG_FILENAME = "events.jsonl";

/** Producer string stamped into the metadata header by the team daemon. */
export const EVENTS_LOG_PRODUCER = "team-daemon";

export interface ParsedEventsLog {
  /** The metadata header, when present (absent for pre-header/partial reads). */
  readonly metadata: WireMetadataEvent | undefined;
  /** Recorded lane events, in file order, migrated to the current version. */
  readonly events: readonly LaneEvent[];
  /** Count of non-empty lines that failed to parse or coerce (observability). */
  readonly malformed: number;
}

/** Structural guard: a parsed record has the minimal LaneEvent shape. */
function isLaneEventShaped(record: Record<string, unknown>): boolean {
  return (
    typeof record.ts === "number" &&
    typeof record.agentId === "string" &&
    typeof record.type === "string"
  );
}

/**
 * Parse a full `events.jsonl` blob into its metadata header + recorded lane
 * events. Malformed / truncated lines are counted, not thrown (a follower
 * should keep going past one corrupt line). Records written at an older
 * `protocol_version` are migrated forward via the wire-protocol registry.
 */
export function parseTeamEventsLog(content: string): ParsedEventsLog {
  let metadata: WireMetadataEvent | undefined;
  let fromVersion: string = WIRE_PROTOCOL_VERSION;
  const events: LaneEvent[] = [];
  let malformed = 0;

  for (const record of iterateWireLines(content)) {
    if (record === null) {
      malformed += 1;
      continue;
    }
    if (isMetadataEvent(record)) {
      metadata = record;
      fromVersion = record.protocol_version;
      continue;
    }
    let migrated: Record<string, unknown> | null = record;
    try {
      migrated = applyMigrations(record, resolveWireMigrations(fromVersion));
    } catch {
      // No migration chain for this version — surface as malformed rather
      // than guessing at the shape.
      malformed += 1;
      continue;
    }
    if (migrated === null) continue; // migration dropped it intentionally
    if (!isLaneEventShaped(migrated)) {
      malformed += 1;
      continue;
    }
    events.push(migrated as unknown as LaneEvent);
  }

  return { metadata, events, malformed };
}
