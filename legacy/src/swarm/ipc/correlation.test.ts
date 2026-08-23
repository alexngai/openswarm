import { describe, it, expect } from "vitest";
import { makeCorrelationId } from "./correlation.js";

describe("makeCorrelationId", () => {
  it("returns a string", () => {
    expect(typeof makeCorrelationId()).toBe("string");
  });

  it("matches the UUIDv4 pattern", () => {
    const uuid = makeCorrelationId();
    // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y ∈ {8,9,a,b}
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns unique ids across many calls", () => {
    const ids = Array.from({ length: 50 }, () => makeCorrelationId());
    expect(new Set(ids).size).toBe(50);
  });
});
