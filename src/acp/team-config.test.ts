import { describe, it, expect } from "vitest";
import { buildCoordinatorSpec } from "./team-config.js";

describe("buildCoordinatorSpec", () => {
  it("builds a coordinator with one lead whose prompt is the user text", () => {
    const spec = buildCoordinatorSpec("do the thing");
    expect(spec.topology).toBe("coordinator");
    expect(spec.members).toHaveLength(1);
    expect(spec.members[0]).toMatchObject({ role: "lead", prompt: "do the thing" });
    expect(spec.coordination.completion).toEqual({ kind: "all" });
  });
});
