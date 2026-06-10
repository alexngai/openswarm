import { describe, it, expect } from "vitest";
import { deferStrategy } from "./defer.js";
import { abandonStrategy } from "./abandon.js";
import { escalateStrategy } from "./escalate.js";
import {
  createDefaultRecoveryRegistry,
  describeResolution,
} from "./index.js";
import type { ConflictContext } from "./types.js";

const ctx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  conflictId: "c1",
  sourceAgentId: "a1",
  streamId: "s1",
  paths: ["src/foo.ts"],
  operation: "merge",
  recoveryDepth: 0,
  ...over,
});

describe("built-in recovery strategies", () => {
  it("defer is a sync no-op that returns deferred", async () => {
    expect(deferStrategy.name).toBe("defer");
    expect(deferStrategy.mode).toBe("sync");
    const r = await deferStrategy.recover(ctx());
    expect(r.kind).toBe("deferred");
  });

  it("abandon returns abandoned with the stream id and conflicting paths", async () => {
    const r = await abandonStrategy.recover(ctx({ streamId: "s9", paths: ["a.ts", "b.ts"] }));
    expect(r).toEqual({
      kind: "abandoned",
      streamId: "s9",
      reason: "conflict on a.ts, b.ts",
    });
  });

  it("abandon handles an empty paths list", async () => {
    const r = await abandonStrategy.recover(ctx({ paths: [] }));
    expect(r).toMatchObject({ kind: "abandoned", reason: "conflict on <unknown>" });
  });

  it("escalate returns escalated to human (async mode)", async () => {
    expect(escalateStrategy.mode).toBe("async");
    const r = await escalateStrategy.recover(ctx());
    expect(r).toEqual({ kind: "escalated", escalatedTo: "human" });
  });
});

describe("createDefaultRecoveryRegistry", () => {
  it("registers defer, abandon, and escalate", () => {
    const r = createDefaultRecoveryRegistry();
    expect([...r.list()].sort()).toEqual(["abandon", "defer", "escalate"]);
  });

  it("does NOT register auto-resolve (D2 — intentionally cut)", () => {
    const r = createDefaultRecoveryRegistry();
    expect(r.has("auto-resolve")).toBe(false);
  });
});

describe("describeResolution", () => {
  it("renders each resolution kind", () => {
    expect(describeResolution({ kind: "resolved", resolutionCommit: "abc" })).toMatch(/resolved \(abc\)/);
    expect(describeResolution({ kind: "resolved" })).toBe("resolved");
    expect(describeResolution({ kind: "deferred", reason: "x" })).toMatch(/deferred \(x\)/);
    expect(describeResolution({ kind: "abandoned", streamId: "s", reason: "r" })).toMatch(/abandoned s \(r\)/);
    expect(describeResolution({ kind: "escalated", escalatedTo: "human" })).toMatch(/escalated to human/);
    expect(describeResolution({ kind: "failed", error: "boom" })).toMatch(/failed: boom/);
  });
});
