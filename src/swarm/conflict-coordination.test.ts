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

  it("wakes every concurrent waiter on the same conflictId", async () => {
    // Track-A hardening #8: waiters are a Set, so a second waiter on the same
    // id is no longer silently dropped (the old single-slot map clobbered it).
    const host = new StandaloneHost();
    const a = host.waitForConflictResolution!("c6", 1000);
    const b = host.waitForConflictResolution!("c6", 1000);
    const c = host.waitForConflictResolution!("c6", 1000);
    host.resolveConflict!("c6", { resolutionCommit: "shared" });
    expect(await Promise.all([a, b, c])).toEqual([
      { resolutionCommit: "shared" },
      { resolutionCommit: "shared" },
      { resolutionCommit: "shared" },
    ]);
  });

  it("a timed-out waiter does not disturb a sibling waiter", async () => {
    const host = new StandaloneHost();
    const slow = host.waitForConflictResolution!("c7", 1000);
    const fast = host.waitForConflictResolution!("c7", 10);
    expect(await fast).toBeNull(); // times out, removes only itself
    host.resolveConflict!("c7", { resolutionCommit: "later" });
    expect(await slow).toEqual({ resolutionCommit: "later" });
  });

  it("emits a team_note when a waiter is woken (observability)", async () => {
    const host = new StandaloneHost();
    const emit = vi.spyOn(
      host as unknown as { emit: (e: unknown) => void },
      "emit",
    );
    const waitP = host.waitForConflictResolution!("obs1", 1000);
    host.resolveConflict!("obs1", { resolutionCommit: "abc" });
    await waitP;
    const notes = emit.mock.calls
      .map((c) => c[0] as { type: string; payload?: Record<string, unknown> })
      .filter((e) => e.type === "team_note");
    expect(
      notes.some(
        (n) =>
          n.payload?.conflictSignal === "resolved" &&
          n.payload?.conflictId === "obs1",
      ),
    ).toBe(true);
  });

  it("emits a team_note when a signal arrives with no waiter (orphaned)", async () => {
    const host = new StandaloneHost();
    const emit = vi.spyOn(
      host as unknown as { emit: (e: unknown) => void },
      "emit",
    );
    // Resolve-before-wait / dropped post-timeout signal — must be surfaced.
    host.resolveConflict!("obs2", { resolutionCommit: "def" });
    const notes = emit.mock.calls
      .map((c) => c[0] as { type: string; payload?: Record<string, unknown> })
      .filter((e) => e.type === "team_note");
    expect(
      notes.some(
        (n) =>
          n.payload?.conflictSignal === "buffered" &&
          n.payload?.conflictId === "obs2",
      ),
    ).toBe(true);
  });

  it("bounds the resolve-before-wait buffer (evicts oldest)", async () => {
    // Track-A hardening #7: resolvedConflicts is capped, so a flood of
    // resolve-before-wait entries can't grow unbounded. The oldest is evicted.
    const host = new StandaloneHost();
    const cap = (StandaloneHost as unknown as { RESOLVED_CONFLICTS_CAP: number })
      .RESOLVED_CONFLICTS_CAP;
    host.resolveConflict!("evicted", { resolutionCommit: "gone" });
    for (let i = 0; i < cap; i++) {
      host.resolveConflict!(`k${i}`, { resolutionCommit: `v${i}` });
    }
    // The first entry was pushed out by the cap-th insertion → now times out.
    expect(await host.waitForConflictResolution!("evicted", 10)).toBeNull();
    // A recent entry is still buffered.
    expect(await host.waitForConflictResolution!(`k${cap - 1}`, 10)).toEqual({
      resolutionCommit: `v${cap - 1}`,
    });
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
