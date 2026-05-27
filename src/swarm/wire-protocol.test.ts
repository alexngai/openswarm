import { describe, it, expect } from "vitest";
import {
  WIRE_PROTOCOL_VERSION,
  buildMetadataEvent,
  isMetadataEvent,
  resolveWireMigrations,
  applyMigrations,
  parseWireLineSafe,
  iterateWireLines,
  isLiveOnlyLaneEvent,
  isRecordedLaneEvent,
  type WireMigration,
} from "./wire-protocol.js";
import type { LaneEvent } from "./events.js";
import type { AgentId } from "../core/types.js";

describe("wire-protocol — metadata event", () => {
  it("buildMetadataEvent stamps the current protocol version", () => {
    const ev = buildMetadataEvent("team-daemon");
    expect(ev.type).toBe("_metadata");
    expect(ev.protocol_version).toBe(WIRE_PROTOCOL_VERSION);
    expect(typeof ev.created_at).toBe("number");
    expect(ev.producer).toBe("team-daemon");
  });

  it("isMetadataEvent recognises metadata records", () => {
    expect(isMetadataEvent(buildMetadataEvent())).toBe(true);
    expect(isMetadataEvent({ type: "turn_start" })).toBe(false);
    expect(isMetadataEvent({ type: "_metadata" })).toBe(false); // missing protocol_version
    expect(isMetadataEvent(null)).toBe(false);
    expect(isMetadataEvent("string")).toBe(false);
  });
});

describe("wire-protocol — migration registry", () => {
  it("returns an empty chain when fromVersion matches current", () => {
    expect(resolveWireMigrations(WIRE_PROTOCOL_VERSION)).toEqual([]);
  });

  it("throws a descriptive error when no chain exists", () => {
    expect(() => resolveWireMigrations("9.99")).toThrow(
      /no migration registered from "9\.99"/,
    );
  });

  it("applyMigrations is a no-op when the chain is empty", () => {
    const record = { foo: "bar" };
    expect(applyMigrations(record, [])).toEqual({ foo: "bar" });
  });

  it("applyMigrations runs migrations in order and supports dropping records", () => {
    const chain: WireMigration[] = [
      { from: "1.0", to: "1.1", migrate: (r) => ({ ...r, added: 1 }) },
      {
        from: "1.1",
        to: "1.2",
        migrate: (r) => (r["drop"] === true ? null : r),
      },
    ];
    expect(applyMigrations({ x: 1 }, chain)).toEqual({ x: 1, added: 1 });
    expect(applyMigrations({ x: 1, drop: true }, chain)).toEqual(null);
  });
});

describe("wire-protocol — crash-tolerant line parsing", () => {
  it("parseWireLineSafe returns null for invalid JSON", () => {
    expect(parseWireLineSafe("not json")).toBeNull();
    expect(parseWireLineSafe("{")).toBeNull();
  });

  it("parseWireLineSafe returns null for non-object JSON values", () => {
    expect(parseWireLineSafe("42")).toBeNull();
    expect(parseWireLineSafe("[1,2,3]")).toBeNull();
    expect(parseWireLineSafe("null")).toBeNull();
    expect(parseWireLineSafe("\"str\"")).toBeNull();
  });

  it("parseWireLineSafe returns the object on success", () => {
    expect(parseWireLineSafe('{"a":1}')).toEqual({ a: 1 });
  });

  it("iterateWireLines yields each fully-terminated line", () => {
    const blob = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const lines = [...iterateWireLines(blob)];
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("iterateWireLines drops a truncated trailing line (no terminating newline)", () => {
    // Writer killed before completing the last line — simulates crash mid-write.
    const blob = '{"a":1}\n{"b":2}\n{"c":3,truncat';
    const lines = [...iterateWireLines(blob)];
    expect(lines).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("iterateWireLines tolerates parse failures inline (yields null) without throwing", () => {
    const blob = '{"a":1}\nnot json\n{"c":3}\n';
    const lines = [...iterateWireLines(blob)];
    expect(lines).toEqual([{ a: 1 }, null, { c: 3 }]);
  });

  it("iterateWireLines handles an empty blob", () => {
    expect([...iterateWireLines("")]).toEqual([]);
  });
});

describe("wire-protocol — live-only vs recorded LaneEvent split", () => {
  const stubEvent = (type: LaneEvent["type"]): LaneEvent => ({
    ts: 0,
    agentId: "a" as AgentId,
    type,
    payload: {} as LaneEvent["payload"],
  });

  it("classifies high-frequency deltas as live-only", () => {
    expect(isLiveOnlyLaneEvent("text_delta")).toBe(true);
    expect(isLiveOnlyLaneEvent("tool_use_input")).toBe(true);
    expect(isLiveOnlyLaneEvent("heartbeat")).toBe(true);
    expect(isLiveOnlyLaneEvent("worker_lifecycle_changed")).toBe(true);
  });

  it("classifies semantic-step events as recorded (default)", () => {
    expect(isLiveOnlyLaneEvent("turn_start")).toBe(false);
    expect(isLiveOnlyLaneEvent("tool_use_end")).toBe(false);
    expect(isLiveOnlyLaneEvent("task_completed")).toBe(false);
    expect(isLiveOnlyLaneEvent("permission_granted")).toBe(false);
    expect(isLiveOnlyLaneEvent("dead_letter_written")).toBe(false);
  });

  it("isRecordedLaneEvent is the inverse predicate", () => {
    expect(isRecordedLaneEvent(stubEvent("text_delta"))).toBe(false);
    expect(isRecordedLaneEvent(stubEvent("turn_start"))).toBe(true);
  });
});
