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
  events: [] as Record<string, unknown>[],
  onDispatch: undefined as undefined | ((type: string) => void),
  supportsSkillsSurfaced: true,
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
      h.events.push(evt as unknown as Record<string, unknown>);
      h.onDispatch?.(evt.type);
    },
  }),
  get EventType() {
    return {
      SessionStart: "SessionStart",
      TurnStart: "TurnStart",
      TurnEnd: "TurnEnd",
      SessionEnd: "SessionEnd",
      ...(h.supportsSkillsSurfaced ? { SkillsSurfaced: "SkillsSurfaced" } : {}),
    };
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
  h.events = [];
  h.onDispatch = undefined;
  h.supportsSkillsSurfaced = true;
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

  it("declares surfaced skills via SkillsSurfaced inside the turn window", async () => {
    await beginCheckpointedSession({
      ...baseOpts,
      surfacedSkills: [
        { id: "sk-1", name: "verify-before-completion" },
        { id: "pb-2", name: "test-driven-fix", sourceType: "cognitive-core" },
      ],
    });
    expect(h.dispatched).toEqual(["SessionStart", "TurnStart", "SkillsSurfaced"]);
    const evt = h.events[2] as {
      skillsSurfaced: { name: string; sourceType: string; upstreamSkillId: string; surfacedAt: string }[];
    };
    expect(evt.skillsSurfaced).toHaveLength(2);
    expect(evt.skillsSurfaced[0]).toMatchObject({
      name: "verify-before-completion",
      sourceType: "skill-tree",
      upstreamSkillId: "sk-1",
    });
    expect(evt.skillsSurfaced[1]).toMatchObject({
      name: "test-driven-fix",
      sourceType: "cognitive-core",
      upstreamSkillId: "pb-2",
    });
    expect(evt.skillsSurfaced[0].surfacedAt).toBeTruthy();
  });

  it("skips SkillsSurfaced when no skills were surfaced", async () => {
    await beginCheckpointedSession({ ...baseOpts, surfacedSkills: [] });
    expect(h.dispatched).toEqual(["SessionStart", "TurnStart"]);
  });

  it("skips SkillsSurfaced on sessionlog versions without the event", async () => {
    h.supportsSkillsSurfaced = false;
    const session = await beginCheckpointedSession({
      ...baseOpts,
      surfacedSkills: [{ id: "sk-1", name: "verify-before-completion" }],
    });
    expect(session).not.toBeNull();
    expect(h.dispatched).toEqual(["SessionStart", "TurnStart"]);
  });

  it("a failed SkillsSurfaced dispatch does not abort checkpointing", async () => {
    h.onDispatch = (type) => {
      if (type === "SkillsSurfaced") throw new Error("old sessionlog");
    };
    const session = await beginCheckpointedSession({
      ...baseOpts,
      surfacedSkills: [{ id: "sk-1", name: "verify-before-completion" }],
    });
    expect(session).not.toBeNull();
    await session!.finish();
    expect(h.dispatched).toEqual([
      "SessionStart",
      "TurnStart",
      "SkillsSurfaced",
      "TurnEnd",
      "SessionEnd",
    ]);
  });
});
