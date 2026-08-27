import { describe, it, expect } from "vitest";
import { parseTeamEventsLog, EVENTS_LOG_PRODUCER } from "./events-log.js";
import { buildMetadataEvent, WIRE_PROTOCOL_VERSION } from "./wire-protocol.js";
import type { LaneEvent } from "./events.js";

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function laneEvent(overrides: Partial<LaneEvent> = {}): LaneEvent {
  return {
    ts: 1,
    agentId: "agent-1",
    type: "worker_spawned",
    payload: {},
    ...overrides,
  } as LaneEvent;
}

describe("parseTeamEventsLog", () => {
  it("returns metadata + events for a well-formed wire", () => {
    const content =
      line(buildMetadataEvent(EVENTS_LOG_PRODUCER)) +
      line(laneEvent({ type: "worker_spawned" })) +
      line(laneEvent({ type: "worker_idle", agentId: "agent-2" }));

    const { metadata, events, malformed } = parseTeamEventsLog(content);
    expect(metadata?.protocol_version).toBe(WIRE_PROTOCOL_VERSION);
    expect(metadata?.producer).toBe(EVENTS_LOG_PRODUCER);
    expect(events.map((e) => e.type)).toEqual(["worker_spawned", "worker_idle"]);
    expect(events[1]!.agentId).toBe("agent-2");
    expect(malformed).toBe(0);
  });

  it("tolerates a header-less blob (partial read before the header line)", () => {
    const content = line(laneEvent({ type: "worker_exited" }));
    const { metadata, events } = parseTeamEventsLog(content);
    expect(metadata).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("worker_exited");
  });

  it("drops a truncated trailing line (writer killed mid-write)", () => {
    const content =
      line(buildMetadataEvent(EVENTS_LOG_PRODUCER)) +
      line(laneEvent()) +
      '{"ts":2,"agentId":"a","type":"worker_id'; // no newline, truncated

    const { events, malformed } = parseTeamEventsLog(content);
    expect(events).toHaveLength(1);
    // Truncated trailing line is dropped silently, not counted as malformed.
    expect(malformed).toBe(0);
  });

  it("counts a corrupt (unparseable) interior line as malformed and continues", () => {
    const content =
      line(buildMetadataEvent(EVENTS_LOG_PRODUCER)) +
      "{ this is not json }\n" +
      line(laneEvent({ type: "worker_idle" }));

    const { events, malformed } = parseTeamEventsLog(content);
    expect(events.map((e) => e.type)).toEqual(["worker_idle"]);
    expect(malformed).toBe(1);
  });

  it("skips lines missing the minimal LaneEvent shape", () => {
    const content =
      line(buildMetadataEvent(EVENTS_LOG_PRODUCER)) +
      line({ ts: 1, type: "worker_spawned" }) + // no agentId
      line(laneEvent({ type: "worker_exited" }));

    const { events, malformed } = parseTeamEventsLog(content);
    expect(events.map((e) => e.type)).toEqual(["worker_exited"]);
    expect(malformed).toBe(1);
  });

  it("returns empty for an empty blob", () => {
    expect(parseTeamEventsLog("")).toEqual({
      metadata: undefined,
      events: [],
      malformed: 0,
    });
  });
});
