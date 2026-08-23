import { describe, it, expect, vi } from "vitest";
import { registerCascadeActions, type CascadeRouter } from "./cascade-actions.js";
import type { StandaloneHost } from "../swarm/standalone-host.js";

/** docs/44 P8 — cascade action notifications → Track-A primitives. */

/** A router that captures the registered notification handler so tests fire it. */
function fakeRouter(): {
  router: CascadeRouter;
  fire: (method: string, params: unknown) => void;
} {
  let handler: ((method: string, params: unknown) => void) | undefined;
  return {
    router: {
      onNotification: (h) => {
        handler = h;
      },
    },
    fire: (method, params) => handler?.(method, params),
  };
}

/** Wait a microtask turn so the handler's async dispatch + emit settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("registerCascadeActions", () => {
  it("merge → host.mergeStreamIdIntoBranch + emits stream.merged", async () => {
    const merge = vi.fn(async () => ({ success: true, newHead: "abc123" }));
    const host = { mergeStreamIdIntoBranch: merge } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });

    fire("x-cascade/request.merge", { stream_id: "s1", target_stream_id: "main" });
    await tick();

    expect(merge).toHaveBeenCalledWith("s1", "main");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "x-cascade/stream.merged",
        data: expect.objectContaining({ stream_id: "s1", target: "main", newHead: "abc123" }),
      }),
    );
  });

  it("merge conflict → emits stream.conflict with details", async () => {
    const merge = vi.fn(async () => ({
      success: false,
      errorType: "conflict",
      conflicts: ["foo.ts"],
      error: "CONFLICT",
    }));
    const host = { mergeStreamIdIntoBranch: merge } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });

    fire("x-cascade/request.merge", { stream_id: "s1" });
    await tick();

    expect(merge).toHaveBeenCalledWith("s1", "main"); // default target
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "x-cascade/stream.conflict",
        data: expect.objectContaining({ errorType: "conflict", conflicts: ["foo.ts"] }),
      }),
    );
  });

  it("merge unsupported (adapter null) → emits unsupported", async () => {
    const host = { mergeStreamIdIntoBranch: vi.fn(async () => null) } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.merge", { stream_id: "s1" });
    await tick();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "x-cascade/stream.unsupported" }),
    );
  });

  it("resolve → host.resolveConflict + emits stream.resolved", async () => {
    const resolveConflict = vi.fn();
    const host = { resolveConflict } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });

    fire("x-cascade/request.resolve", { stream_id: "s1", conflict_id: "c1", strategy: "ours" });
    await tick();

    expect(resolveConflict).toHaveBeenCalledWith("c1");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "x-cascade/stream.resolved",
        data: expect.objectContaining({ conflict_id: "c1", strategy: "ours" }),
      }),
    );
  });

  it("resolve falls back to stream_id when conflict_id is absent", async () => {
    const resolveConflict = vi.fn();
    const host = { resolveConflict } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.resolve", { stream_id: "s1" });
    await tick();
    expect(resolveConflict).toHaveBeenCalledWith("s1");
  });

  it("abandon → host.abandonStream + emits stream.abandoned", async () => {
    const abandonStream = vi.fn(async () => ({ success: true }));
    const host = { abandonStream } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.abandon", { stream_id: "s1", reason: "stale" });
    await tick();
    expect(abandonStream).toHaveBeenCalledWith("s1", "stale");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "x-cascade/stream.abandoned" }),
    );
  });

  it("pause/resume → host.{pause,resume}Stream + emits paused/resumed", async () => {
    const pauseStream = vi.fn(async () => ({ success: true }));
    const resumeStream = vi.fn(async () => ({ success: true }));
    const host = { pauseStream, resumeStream } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.pause", { stream_id: "s1", reason: "hold" });
    fire("x-cascade/request.resume", { stream_id: "s1" });
    await tick();
    expect(pauseStream).toHaveBeenCalledWith("s1", "hold");
    expect(resumeStream).toHaveBeenCalledWith("s1");
    const types = emit.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toContain("x-cascade/stream.paused");
    expect(types).toContain("x-cascade/stream.resumed");
  });

  it("commit → host.commitStream + emits stream.committed with the sha", async () => {
    const commitStream = vi.fn(async () => ({ success: true, commit: "abc123", changeId: "c-1" }));
    const host = { commitStream } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.commit", { stream_id: "s1", message: "wip" });
    await tick();
    expect(commitStream).toHaveBeenCalledWith("s1", "wip");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "x-cascade/stream.committed",
        data: expect.objectContaining({ commit: "abc123", changeId: "c-1" }),
      }),
    );
  });

  it("push → host.pushStream + emits stream.pushed", async () => {
    const pushStream = vi.fn(async () => ({ success: true, pushedCommit: "deadbeef" }));
    const host = { pushStream } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.push", { stream_id: "s1", remote: "origin", target_ref: "feature/x" });
    await tick();
    expect(pushStream).toHaveBeenCalledWith("s1", "origin", "feature/x");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "x-cascade/stream.pushed",
        data: expect.objectContaining({ pushedCommit: "deadbeef" }),
      }),
    );
  });

  it("commit/pause/resume/push → unsupported when the adapter lacks them", async () => {
    // Host passthroughs return null when no git-cascade adapter is wired.
    const host = {
      abandonStream: async () => null,
      pauseStream: async () => null,
      resumeStream: async () => null,
      commitStream: async () => null,
      pushStream: async () => null,
    } as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    for (const action of ["commit", "pause", "resume", "push"]) {
      fire(`x-cascade/request.${action}`, { stream_id: "s1" });
    }
    await tick();
    const unsupported = emit.mock.calls.filter(
      (c) => (c[0] as { type: string }).type === "x-cascade/stream.unsupported",
    );
    expect(unsupported).toHaveLength(4);
  });

  it("missing stream_id → emits error", async () => {
    const host = {} as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("x-cascade/request.merge", {});
    await tick();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "x-cascade/stream.error",
        data: expect.objectContaining({ error: expect.stringMatching(/stream_id/) }),
      }),
    );
  });

  it("ignores non-cascade notifications", async () => {
    const host = {} as unknown as StandaloneHost;
    const emit = vi.fn();
    const { router, fire } = fakeRouter();
    registerCascadeActions(router, { host, emit, log: () => {} });
    fire("some/other.method", { stream_id: "s1" });
    await tick();
    expect(emit).not.toHaveBeenCalled();
  });
});
