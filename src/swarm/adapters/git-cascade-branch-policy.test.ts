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

  it("forwards baseStreamId as `base` to git-cascade", async () => {
    const fake = makeTracker();
    const adapter = new GitCascadeBranchPolicyAdapter({
      repoPath: "/repo",
      trackerForTest: fake.tracker,
    });
    await adapter.resolve(
      { kind: "stream", baseStreamId: "s-base", name: "child" },
      "a" as AgentId,
    );
    expect(fake.tracker.createStream).toHaveBeenCalledWith({
      name: "child",
      agentId: "a",
      base: "s-base",
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
