/**
 * Wire-protocol framework for openswarm JSONL streams.
 *
 * Adds three pieces inspired by kimi-code's
 * `packages/agent-core/src/agent/records`:
 *
 *   1. A `WireMetadataEvent` written as the first line of any
 *      persistent JSONL wire. Declares `protocol_version` and
 *      `created_at` so future readers can detect version drift.
 *   2. A migration registry pattern. Migrations are declared as
 *      pure `(line) => line` transforms keyed by from/to version.
 *      `resolveWireMigrations(fromVersion)` chains them up to the
 *      current version; readers apply each migration in order
 *      before parsing the domain shape.
 *   3. A crash-tolerant line iterator: any truncated trailing line
 *      (no terminating "\n") is dropped silently, and per-line
 *      JSON parse errors are returned as `null` rather than thrown.
 *
 * Also exports `isLiveOnlyLaneEvent(type)` — a runtime predicate that
 * partitions LaneEventType into "recorded" (durable, write to disk)
 * and "live-only" (high-frequency deltas, never persist). Today this
 * is informational only; consumers can adopt it incrementally.
 */

import type { LaneEvent, LaneEventType } from "./events.js";

// ---------------------------------------------------------------------------
// Protocol version & metadata event
// ---------------------------------------------------------------------------

/**
 * Current wire protocol version. Bump when the event shape changes in a
 * way that requires a migration. The string is opaque; we use semantic
 * dot-separated segments for human readability, but the migration
 * registry only does exact-string lookup.
 */
export const WIRE_PROTOCOL_VERSION = "1.0" as const;

export interface WireMetadataEvent {
  readonly type: "_metadata";
  readonly protocol_version: string;
  /** Epoch milliseconds at wire creation. */
  readonly created_at: number;
  /** Identifies the wire's producer (e.g. "team-daemon"). Free-form. */
  readonly producer?: string;
}

export function isMetadataEvent(value: unknown): value is WireMetadataEvent {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "_metadata" &&
    typeof (value as WireMetadataEvent).protocol_version === "string"
  );
}

export function buildMetadataEvent(producer?: string): WireMetadataEvent {
  return {
    type: "_metadata",
    protocol_version: WIRE_PROTOCOL_VERSION,
    created_at: Date.now(),
    ...(producer !== undefined ? { producer } : {}),
  };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * A migration transforms a raw parsed JSON object from `from` shape to
 * `to` shape. Migrations must be pure: same input → same output, no I/O.
 * Returning `null` means "drop this event" (e.g. an event type was removed).
 */
export interface WireMigration {
  readonly from: string;
  readonly to: string;
  readonly migrate: (record: Record<string, unknown>) => Record<string, unknown> | null;
}

/**
 * Registered migrations, evaluated in `resolveWireMigrations()`. Append
 * new migrations here when bumping `WIRE_PROTOCOL_VERSION`. Each entry
 * must form a contiguous chain from the previous version to the new one.
 */
const MIGRATIONS: readonly WireMigration[] = [
  // No migrations yet — 1.0 is the only declared version. Example:
  // {
  //   from: "1.0", to: "1.1",
  //   migrate: (record) => ({ ...record, newField: "default" }),
  // },
];

/**
 * Returns the ordered list of migrations needed to upgrade a record
 * written at `fromVersion` to the current `WIRE_PROTOCOL_VERSION`.
 *
 * Throws when no chain exists. Returns an empty array when
 * `fromVersion === WIRE_PROTOCOL_VERSION`.
 */
export function resolveWireMigrations(fromVersion: string): readonly WireMigration[] {
  if (fromVersion === WIRE_PROTOCOL_VERSION) return [];

  const chain: WireMigration[] = [];
  let current = fromVersion;
  // Bound the loop by the registry size to defend against cycles.
  for (let i = 0; i <= MIGRATIONS.length; i += 1) {
    if (current === WIRE_PROTOCOL_VERSION) return chain;
    const step = MIGRATIONS.find((m) => m.from === current);
    if (step === undefined) {
      throw new Error(
        `wire-protocol: no migration registered from "${current}" toward "${WIRE_PROTOCOL_VERSION}"`,
      );
    }
    chain.push(step);
    current = step.to;
  }
  throw new Error(
    `wire-protocol: migration cycle detected starting at "${fromVersion}"`,
  );
}

/**
 * Apply the migration chain to a single record. Returns null if any
 * migration drops the record.
 */
export function applyMigrations(
  record: Record<string, unknown>,
  chain: readonly WireMigration[],
): Record<string, unknown> | null {
  let cur: Record<string, unknown> | null = record;
  for (const step of chain) {
    if (cur === null) return null;
    cur = step.migrate(cur);
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Crash-tolerant line iterator
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL line. Returns `null` on parse failure rather than
 * throwing — appropriate for streaming readers that should keep going
 * past one corrupt line.
 */
export function parseWireLineSafe(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Iterate a wire blob line-by-line. The last line is dropped if it is
 * not newline-terminated (i.e. the writer was killed mid-write). Parse
 * failures yield `null` rather than throwing so the caller can decide
 * how to react (skip, log, or surface).
 */
export function* iterateWireLines(
  content: string,
): Generator<Record<string, unknown> | null> {
  if (content.length === 0) return;
  const endsWithNewline = content.endsWith("\n");
  const parts = content.split("\n");
  // Whether or not the blob ends with a newline, splitting on "\n" yields
  // a trailing empty string when it does. We trim that. If it doesn't
  // end with a newline, the last non-empty entry is a truncated line and
  // must be skipped for crash tolerance.
  const stop = endsWithNewline ? parts.length - 1 : parts.length - 1;
  for (let i = 0; i < stop; i += 1) {
    yield parseWireLineSafe(parts[i]!);
  }
}

// ---------------------------------------------------------------------------
// Live-only vs. recorded LaneEvent partition
// ---------------------------------------------------------------------------

/**
 * High-frequency deltas and ephemeral signals that don't earn their disk
 * footprint. Consumers may filter these out before persisting to keep
 * wires lean. Inspired by kimi-code's `LoopRecordedEvent` / live-only
 * event split (`loop/events.ts`).
 *
 * Anything not in this set is considered "recorded" by default.
 *
 * Note on `worker_lifecycle_changed`: it carries WorkerLifecyclePayload
 * (the canonical typed record of every state transition) and fires at
 * human timescale, not token-streaming timescale — so it is *recorded*,
 * not live-only. The three entries below are true high-rate signals.
 */
const LIVE_ONLY_LANE_EVENT_TYPES = new Set<LaneEventType>([
  "text_delta",
  "tool_use_input",
  "heartbeat",
]);

export function isLiveOnlyLaneEvent(type: LaneEventType): boolean {
  return LIVE_ONLY_LANE_EVENT_TYPES.has(type);
}

export function isRecordedLaneEvent(event: LaneEvent): boolean {
  return !isLiveOnlyLaneEvent(event.type);
}
