/**
 * Tests for beginCheckpointedSession (Phase 4.2 — previously no unit tests).
 *
 * Mocks the optional `sessionlog` dependency so the two-phase dispatch
 * (SessionStart→TurnStart on begin, TurnEnd→SessionEnd on finish), the
 * best-effort no-op guards, and finish() idempotency are all covered without
 * touching a real git repo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enabled: true,
  agent: { name: "openswarm" } as unknown,
  dispatched: [] as string[],
  onDispatch: undefined as undefined | ((type: string) => void),
}));

vi.mock("sessionlog", () => ({
  isEnabled: async () => h.enabled,
  getAgent: () => h.agent,
  resolveSessionRepoConfig: async () => ({}),
  createSessionStore: () => ({}),
  createCheckpointStore: () => ({}),
  createLifecycleHandler: () => ({
    dispatch: async (_agent: unknown, evt: { type: string }) => {
      h.dispatched.push(evt.type);
      h.onDispatch?.(evt.type);
    },
  }),
  EventType: {
    SessionStart: "SessionStart",
    TurnStart: "TurnStart",
    TurnEnd: "TurnEnd",
    SessionEnd: "SessionEnd",
  },
}));

import { beginCheckpointedSession } from "./session-checkpointer.js";

const baseOpts = {
  sessionId: "sess-1",
  sessionRef: "/tmp/events.jsonl",
  prompt: "do the thing",
  cwd: "/repo",
};

beforeEach(() => {
  h.enabled = true;
  h.agent = { name: "openswarm" };
  h.dispatched = [];
  h.onDispatch = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("beginCheckpointedSession", () => {
  it("dispatches SessionStart then TurnStart on begin", async () => {
    const session = await beginCheckpointedSession(baseOpts);
    expect(session).not.toBeNull();
    expect(h.dispatched).toEqual(["SessionStart", "TurnStart"]);
  });

  it("dispatches TurnEnd then SessionEnd on finish", async () => {
    const session = await beginCheckpointedSession(baseOpts);
    await session!.finish();
    expect(h.dispatched).toEqual(["SessionStart", "TurnStart", "TurnEnd", "SessionEnd"]);
  });

  it("finish() is idempotent (second call is a no-op)", async () => {
    const session = await beginCheckpointedSession(baseOpts);
    await session!.finish();
    await session!.finish();
    expect(h.dispatched.filter((t) => t === "SessionEnd")).toHaveLength(1);
  });

  it("returns null when sessionlog is disabled for the cwd", async () => {
    h.enabled = false;
    expect(await beginCheckpointedSession(baseOpts)).toBeNull();
    expect(h.dispatched).toEqual([]);
  });

  it("returns null when no openswarm agent is registered", async () => {
    h.agent = undefined;
    expect(await beginCheckpointedSession(baseOpts)).toBeNull();
  });

  it("swallows a dispatch error during finish (best-effort, never throws)", async () => {
    const session = await beginCheckpointedSession(baseOpts);
    h.onDispatch = (type) => {
      if (type === "TurnEnd") throw new Error("checkpoint write failed");
    };
    await expect(session!.finish()).resolves.toBeUndefined();
  });
});
