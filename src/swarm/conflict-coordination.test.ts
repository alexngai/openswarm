import { describe, it, expect } from "vitest";
import { StandaloneHost } from "./standalone-host.js";

/** docs/44 P2 — the resolveConflict / waitForConflictResolution primitive. */
describe("StandaloneHost conflict coordination", () => {
  it("resolveConflict wakes a pending waiter with the payload", async () => {
    const host = new StandaloneHost();
    const waitP = host.waitForConflictResolution!("c1", 1000);
    host.resolveConflict!("c1", { resolutionCommit: "abc" });
    expect(await waitP).toEqual({ resolutionCommit: "abc" });
  });

  it("returns immediately when the resolution arrived before the wait", async () => {
    const host = new StandaloneHost();
    host.resolveConflict!("c2", { resolutionCommit: "def" });
    expect(await host.waitForConflictResolution!("c2", 1000)).toEqual({
      resolutionCommit: "def",
    });
  });

  it("consumes an early resolution only once", async () => {
    const host = new StandaloneHost();
    host.resolveConflict!("c4", { resolutionCommit: "xyz" });
    expect(await host.waitForConflictResolution!("c4", 1000)).toEqual({
      resolutionCommit: "xyz",
    });
    // Second wait has nothing buffered → times out.
    expect(await host.waitForConflictResolution!("c4", 10)).toBeNull();
  });

  it("times out to null when no resolution arrives", async () => {
    const host = new StandaloneHost();
    expect(await host.waitForConflictResolution!("c3", 10)).toBeNull();
  });

  it("carries an undefined commit through when none is given", async () => {
    const host = new StandaloneHost();
    const waitP = host.waitForConflictResolution!("c5", 1000);
    host.resolveConflict!("c5");
    expect(await waitP).toEqual({ resolutionCommit: undefined });
  });
});
