/**
 * Tests for GitCascadeBranchPolicyAdapter — v0.7 stage 7A.3.
 *
 * Uses the `trackerForTest` injection so the suite runs without a real git
 * repo + sqlite db. End-to-end live verification (real git init in tmpdir)
 * lives in the smoke script (7A.5+).
 */

import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";
import {
  GitCascadeBranchPolicyAdapter,
  IdentityBranchPolicyAdapter,
} from "./git-cascade-branch-policy.js";
import type { AgentId } from "../../core/types.js";

// ---------------------------------------------------------------------------
// Fake tracker
// ---------------------------------------------------------------------------

function makeTracker() {
  const created: Array<{
    method: "createStream" | "forkStream";
    args: Record<string, unknown>;
    streamId: string;
  }> = [];
  const worktrees: Array<{
    agentId: string;
    path: string;
    branch?: string;
  }> = [];
  let counter = 0;
  let closed = false;
  return {
    created,
    worktrees,
    isClosed: () => closed,
    tracker: {
      createStream: vi.fn(
        (opts: { name: string; agentId: string; base?: string }) => {
          counter++;
          const id = `s-${counter}`;
          created.push({ method: "createStream", args: opts, streamId: id });
          return id;
        },
      ),
      forkStream: vi.fn(
        (opts: {
          parentStreamId: string;
          name: string;
          agentId: string;
        }) => {
          counter++;
          const id = `s-fork-${counter}`;
          created.push({ method: "forkStream", args: opts, streamId: id });
          return id;
        },
      ),
      createWorktree: vi.fn(
        (opts: { agentId: string; path: string; branch?: string }) => {
          worktrees.push(opts);
          return { agentId: opts.agentId, path: opts.path };
        },
      ),
      // v0.7 stage 7B: returns a fake commit + changeId per call. Real
      // git-cascade returns { commit, changeId } (not commitSha).
      commitChanges: vi.fn(
        (opts: {
          streamId: string;
          agentId: string;
          worktree: string;
          message: string;
          metadata?: Record<string, unknown>;
        }) => {
          counter++;
          return {
            commit: `sha-${counter}`,
            changeId: `cid-${counter}`,
            streamId: opts.streamId,
            message: opts.message,
          };
        },
      ),
      // v0.7 stage 7C: fake merge — succeeds by default; tests that want
      // a conflict scenario reassign this mock per case.
      mergeStream: vi.fn(
        (opts: {
          sourceStream: string;
          targetStream: string;
          agentId: string;
          worktree: string;
          strategy?: string;
        }) => {
          counter++;
          return {
            success: true,
            newHead: `merge-sha-${counter}`,
            sourceStream: opts.sourceStream,
            targetStream: opts.targetStream,
          };
        },
      ),
      close: vi.fn(() => {
        closed = true;
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// IdentityBranchPolicyAdapter (default)
// ---------------------------------------------------------------------------

describe("IdentityBranchPolicyAdapter", () => {
  it("returns {} for every policy kind (no-op default)", async () => {
    const adapter = new IdentityBranchPolicyAdapter();
    expect(await adapter.resolve()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// GitCascadeBranchPolicyAdapter — kind:"none"|"reuse"|"create" pass-through
// ---------------------------------------------------------------------------

describe("GitCascadeBranchPolicyAdapter — non-stream policies", () => {
  it("returns {} for kind:'none' without touching the tracker", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.resolve({ kind: "none" }, "agent-x" as AgentId);
    expect(r).toEqual({});
    expect(fake.tracker.createStream).not.toHaveBeenCalled();
    expect(fake.tracker.createWorktree).not.toHaveBeenCalled();
  });

  it("returns {} for kind:'reuse' (existing-branch shared workflows)", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.resolve(
      { kind: "reuse", branch: "main" },
      "agent-x" as AgentId,
    );
    expect(r).toEqual({});
  });

  it("returns {} for kind:'create' (legacy branch-creation policy)", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.resolve(
      { kind: "create", from: "main" },
      "agent-x" as AgentId,
    );
    expect(r).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// GitCascadeBranchPolicyAdapter — kind:"stream"
// ---------------------------------------------------------------------------

describe("GitCascadeBranchPolicyAdapter — kind:'stream'", () => {
  it("createStream + createWorktree; returns cwd under .swarm-harness/worktrees/<id>/", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.resolve(
      { kind: "stream", name: "feature/x" },
      "agent-A" as AgentId,
    );

    expect(fake.tracker.createStream).toHaveBeenCalledWith({
      name: "feature/x",
      agentId: "agent-A",
    });
    expect(fake.created[0]?.streamId).toBe("s-1");

    expect(fake.tracker.createWorktree).toHaveBeenCalledWith({
      agentId: "agent-A",
      path: path.join("/repo", ".swarm-harness", "worktrees", "s-1"),
      branch: "stream/s-1",
    });

    expect(r.cwd).toBe(
      path.join("/repo", ".swarm-harness", "worktrees", "s-1"),
    );
    expect(r.streamId).toBe("s-1");
    expect(r.branch).toBe("stream/s-1");
  });

  it("uses agentId-based default name when policy.name is omitted", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve({ kind: "stream" }, "agent-bobby" as AgentId);
    const passedName = fake.tracker.createStream.mock.calls[0]?.[0]
      ?.name as string;
    expect(passedName.startsWith("agent-bobby-")).toBe(true);
  });

  it("baseStreamId routes through forkStream (git-cascade's createStream({base}) expects a git ref, not a streamId)", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve(
      { kind: "stream", baseStreamId: "s-base", name: "child" },
      "a" as AgentId,
    );
    expect(fake.tracker.createStream).not.toHaveBeenCalled();
    expect(fake.tracker.forkStream).toHaveBeenCalledWith({
      parentStreamId: "s-base",
      name: "child",
      agentId: "a",
    });
  });
});

// ---------------------------------------------------------------------------
// GitCascadeBranchPolicyAdapter — kind:"fork"
// ---------------------------------------------------------------------------

describe("GitCascadeBranchPolicyAdapter — kind:'fork'", () => {
  it("forkStream + createWorktree; returns cwd + streamId + branch", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.resolve(
      { kind: "fork", parentStreamId: "s-parent", name: "child" },
      "agent-C" as AgentId,
    );

    expect(fake.tracker.forkStream).toHaveBeenCalledWith({
      parentStreamId: "s-parent",
      name: "child",
      agentId: "agent-C",
    });
    expect(r.streamId).toBe("s-fork-1");
    expect(r.branch).toBe("stream/s-fork-1");
    expect(r.cwd).toBe(
      path.join("/repo", ".swarm-harness", "worktrees", "s-fork-1"),
    );
  });
});

// ---------------------------------------------------------------------------
// dispose()
// ---------------------------------------------------------------------------

describe("GitCascadeBranchPolicyAdapter.commitChanges (v0.7 stage 7B)", () => {
  it("returns null when the agent has no recorded stream", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.commitChanges("agent-x" as AgentId, "msg");
    expect(r).toBeNull();
    expect(fake.tracker.commitChanges).not.toHaveBeenCalled();
  });

  it("routes through tracker.commitChanges using the agent's stream + worktree", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    // Resolve a stream so the adapter records the agentId → {streamId, worktree} map.
    await adapter.resolve({ kind: "stream" }, "agent-A" as AgentId);

    const r = await adapter.commitChanges(
      "agent-A" as AgentId,
      "feat: add x",
      { taskId: "t-99" },
    );
    expect(r).not.toBeNull();
    expect(r?.streamId).toBe("s-1");
    expect(r?.commitSha).toMatch(/^sha-/);
    expect(r?.changeId).toMatch(/^cid-/);

    expect(fake.tracker.commitChanges).toHaveBeenCalledOnce();
    const callArgs = fake.tracker.commitChanges.mock.calls[0]![0];
    expect(callArgs.streamId).toBe("s-1");
    expect(callArgs.agentId).toBe("agent-A");
    expect(callArgs.message).toBe("feat: add x");
    expect(callArgs.metadata).toEqual({ taskId: "t-99" });
  });

  it("commitChanges works for fork-resolved agents too", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve(
      { kind: "fork", parentStreamId: "s-parent" },
      "agent-C" as AgentId,
    );
    const r = await adapter.commitChanges("agent-C" as AgentId, "fix: y");
    expect(r?.streamId).toBe("s-fork-1");
    expect(r?.commitSha).toMatch(/^sha-/);
  });
});

describe("GitCascadeBranchPolicyAdapter.streamIdFor + mergeStream (v0.7 stage 7C)", () => {
  it("streamIdFor returns undefined before resolve()", () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    expect(adapter.streamIdFor("agent-x" as AgentId)).toBeUndefined();
  });

  it("streamIdFor returns the recorded streamId after stream/fork resolve", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve({ kind: "stream" }, "agent-A" as AgentId);
    await adapter.resolve(
      { kind: "fork", parentStreamId: "s-base" },
      "agent-B" as AgentId,
    );
    expect(adapter.streamIdFor("agent-A" as AgentId)).toBe("s-1");
    expect(adapter.streamIdFor("agent-B" as AgentId)).toBe("s-fork-2");
  });

  it("mergeStream returns invalid_state when agent has no recorded stream", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    const r = await adapter.mergeStream({
      sourceAgentId: "agent-x" as AgentId,
      targetStream: "main",
    });
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("invalid_state");
    expect(fake.tracker.mergeStream).not.toHaveBeenCalled();
  });

  it("mergeStream routes through tracker.mergeStream with the resolved stream + worktree", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve({ kind: "stream" }, "agent-A" as AgentId);
    const r = await adapter.mergeStream({
      sourceAgentId: "agent-A" as AgentId,
      targetStream: "main",
      strategy: "no-ff",
    });
    expect(r.success).toBe(true);
    expect(r.newHead).toMatch(/^merge-sha-/);
    expect(fake.tracker.mergeStream).toHaveBeenCalledOnce();
    const args = fake.tracker.mergeStream.mock.calls[0]![0];
    expect(args.sourceStream).toBe("s-1");
    expect(args.targetStream).toBe("main");
    expect(args.agentId).toBe("agent-A");
    expect(args.strategy).toBe("no-ff");
    expect(args.worktree).toContain(".swarm-harness/worktrees/s-1");
  });

  it("mergeStream propagates conflict results without throwing", async () => {
    const fake = makeTracker();
    // Cast: override returns a conflict shape, narrower than the default
    // success-shape declared on the fake — vitest's typed Mock won't widen.
    fake.tracker.mergeStream = vi.fn(() => ({
      success: false,
      conflicts: ["src/a.ts", "src/b.ts"],
      error: "merge conflict",
      errorType: "conflict",
      newHead: undefined as unknown as string,
      sourceStream: "s-1",
      targetStream: "main",
    }));
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve({ kind: "stream" }, "agent-A" as AgentId);
    const r = await adapter.mergeStream({
      sourceAgentId: "agent-A" as AgentId,
      targetStream: "main",
    });
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("conflict");
    expect(r.conflicts).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("GitCascadeBranchPolicyAdapter.dispose", () => {
  it("closes the tracker when one was constructed", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve({ kind: "stream" }, "a" as AgentId);
    await adapter.dispose();
    expect(fake.isClosed()).toBe(true);
  });

  it("dispose is idempotent (second call is a no-op)", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve({ kind: "stream" }, "a" as AgentId);
    await adapter.dispose();
    await adapter.dispose(); // must not throw
    expect(fake.tracker.close).toHaveBeenCalledTimes(1);
  });

  it("dispose without prior resolve is a no-op (no tracker constructed)", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.dispose();
    expect(fake.tracker.close).not.toHaveBeenCalled();
  });
});
