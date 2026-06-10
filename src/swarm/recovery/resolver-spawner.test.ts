import { describe, it, expect, vi } from "vitest";
import {
  buildResolverSpawner,
  resolverPrompt,
  type ResolverSpawnerDeps,
} from "./resolver-spawner.js";
import type { ConflictContext } from "./types.js";

const ctx = (over: Partial<ConflictContext> = {}): ConflictContext => ({
  conflictId: "c1",
  sourceAgentId: "a1",
  streamId: "s1",
  paths: ["foo.ts"],
  operation: "merge",
  recoveryDepth: 0,
  targetBranch: "main",
  ...over,
});

function deps(over: Partial<ResolverSpawnerDeps> = {}): ResolverSpawnerDeps {
  return {
    spawnResolver: vi.fn(async () => ({ agentId: "r1", kill: vi.fn(async () => {}) })),
    mergeWithRetain: vi.fn(async () => ({
      success: false,
      errorType: "conflict",
      conflicts: ["foo.ts"],
      conflictWorktree: "/tmp/wt",
      targetOldSha: "old",
    })),
    waitForResolution: vi.fn(async () => ({ resolutionCommit: "fix" })),
    finalize: vi.fn(async () => ({ success: true, newHead: "fix" })),
    timeoutMs: 1000,
    ...over,
  };
}

describe("buildResolverSpawner", () => {
  it("happy path: re-merge → spawn → resolve → finalize → resolved", async () => {
    const d = deps();
    const r = await buildResolverSpawner(d)(ctx());
    expect(d.spawnResolver).toHaveBeenCalledOnce();
    expect(d.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: "/tmp/wt", targetBranch: "main", oldSha: "old", resolutionCommit: "fix" }),
    );
    expect(r).toEqual({ kind: "resolved", resolutionCommit: "fix" });
  });

  it("fails when no targetBranch (stream-landing path unsupported)", async () => {
    const d = deps();
    const r = await buildResolverSpawner(d)(ctx({ targetBranch: undefined }));
    expect(r.kind).toBe("failed");
    expect(d.mergeWithRetain).not.toHaveBeenCalled();
  });

  it("fails when the adapter can't branch-merge", async () => {
    const r = await buildResolverSpawner(deps({ mergeWithRetain: vi.fn(async () => null) }))(ctx());
    expect(r.kind).toBe("failed");
  });

  it("resolves immediately when the re-merge no longer conflicts (race)", async () => {
    const d = deps({ mergeWithRetain: vi.fn(async () => ({ success: true, newHead: "h" })) });
    const r = await buildResolverSpawner(d)(ctx());
    expect(d.spawnResolver).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: "resolved", resolutionCommit: "h" });
  });

  it("escalates and kills the resolver on timeout", async () => {
    const kill = vi.fn(async () => {});
    const d = deps({
      spawnResolver: vi.fn(async () => ({ agentId: "r1", kill })),
      waitForResolution: vi.fn(async () => null),
    });
    const r = await buildResolverSpawner(d)(ctx());
    expect(kill).toHaveBeenCalledOnce();
    expect(d.finalize).not.toHaveBeenCalled();
    expect(r).toEqual({ kind: "escalated", escalatedTo: "human" });
  });

  it("discards the retained worktree on timeout (no leak)", async () => {
    const cleanupWorktree = vi.fn(async () => {});
    const d = deps({
      waitForResolution: vi.fn(async () => null),
      cleanupWorktree,
    });
    const r = await buildResolverSpawner(d)(ctx());
    expect(cleanupWorktree).toHaveBeenCalledWith("/tmp/wt");
    expect(r.kind).toBe("escalated");
  });

  it("tolerates a missing cleanupWorktree dep on timeout (legacy)", async () => {
    const d = deps({ waitForResolution: vi.fn(async () => null) });
    // cleanupWorktree omitted — must not throw.
    const r = await buildResolverSpawner(d)(ctx());
    expect(r.kind).toBe("escalated");
  });

  it("fails when finalize fails (e.g. stale CAS)", async () => {
    const d = deps({ finalize: vi.fn(async () => ({ success: false, errorType: "stale", error: "stale" })) });
    const r = await buildResolverSpawner(d)(ctx());
    expect(r.kind).toBe("failed");
  });

  it("omits resolutionCommit to finalize when the signal didn't carry one", async () => {
    const d = deps({ waitForResolution: vi.fn(async () => ({})) });
    await buildResolverSpawner(d)(ctx());
    const arg = (d.finalize as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect("resolutionCommit" in arg).toBe(false);
  });
});

describe("resolverPrompt", () => {
  it("includes the conflictId, target, and paths", () => {
    const p = resolverPrompt("c9", "main", ["a.ts", "b.ts"]);
    expect(p).toContain('conflictId="c9"');
    expect(p).toContain("main");
    expect(p).toContain("a.ts, b.ts");
  });
});
