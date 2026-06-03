import { describe, it, expect } from "vitest";
import { normalizedEventToLaneType } from "./events.js";

describe("normalizedEventToLaneType", () => {
  it("maps core engine events to their real lane types", () => {
    expect(normalizedEventToLaneType("text_delta")).toBe("text_delta");
    expect(normalizedEventToLaneType("tool_use_start")).toBe("tool_use_start");
    expect(normalizedEventToLaneType("tool_use_input")).toBe("tool_use_input");
    expect(normalizedEventToLaneType("tool_use_end")).toBe("tool_use_end");
    expect(normalizedEventToLaneType("tool_result")).toBe("tool_result");
    expect(normalizedEventToLaneType("message_stop")).toBe("message_stop");
    expect(normalizedEventToLaneType("error")).toBe("error");
  });

  it("drops engine events with no lane equivalent", () => {
    expect(normalizedEventToLaneType("compaction")).toBeUndefined();
    expect(normalizedEventToLaneType("cache_hit")).toBeUndefined();
    expect(normalizedEventToLaneType("cache_miss")).toBeUndefined();
    expect(normalizedEventToLaneType("hook_event")).toBeUndefined();
    expect(normalizedEventToLaneType("info")).toBeUndefined();
  });
});
