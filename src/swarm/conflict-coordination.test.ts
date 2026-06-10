import { describe, it, expect, vi } from "vitest";
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

/** docs/44 P2b — the task.resolve_conflict IPC route (worker → orchestrator). */
describe("StandaloneHost task.resolve_conflict IPC routing", () => {
  it("routes a valid frame to resolveConflict and acks", async () => {
    const host = new StandaloneHost();
    const waitP = host.waitForConflictResolution!("cipc", 1000);
    const respond = vi.fn();
    const transport = { respond, respondError: vi.fn() };
    const frame = {
      kind: "request",
      id: 7,
      method: "task.resolve_conflict",
      params: { conflictId: "cipc", resolutionCommit: "zzz" },
    };
    // handleWorkerRequest is private; reached directly for a routing unit test.
    await (host as unknown as {
      handleWorkerRequest: (a: string, t: unknown, f: unknown) => Promise<void>;
    }).handleWorkerRequest("worker-1", transport, frame);
    expect(await waitP).toEqual({ resolutionCommit: "zzz" });
    expect(respond).toHaveBeenCalledWith(7, null);
  });

  it("rejects an invalid frame with INVALID_PARAMS", async () => {
    const host = new StandaloneHost();
    const respondError = vi.fn();
    const transport = { respond: vi.fn(), respondError };
    const frame = {
      kind: "request",
      id: 8,
      method: "task.resolve_conflict",
      params: { conflictId: "" },
    };
    await (host as unknown as {
      handleWorkerRequest: (a: string, t: unknown, f: unknown) => Promise<void>;
    }).handleWorkerRequest("worker-1", transport, frame);
    expect(respondError).toHaveBeenCalled();
  });
});
