import { describe, it, expect, vi } from "vitest";
import { QueueToBranchStrategy } from "./queue-to-branch.js";
import type { LandingHost } from "./types.js";

function host(
  enqueue?: (opts: {
    streamId: string;
    targetBranch: string;
    agentId?: string;
  }) => Promise<string | null>,
): LandingHost {
  return {
    streamIdFor: () => undefined,
    mergeStreamForAgent: async () => null,
    mergeStreamToBranchForAgent: async () => null,
    ...(enqueue && { enqueueMerge: enqueue }),
  };
}

describe("QueueToBranchStrategy", () => {
  const s = new QueueToBranchStrategy();

  it("is named queue-to-branch", () => {
    expect(s.name).toBe("queue-to-branch");
  });

  it("enqueues to the target branch and reports success", async () => {
    const enqueueMerge = vi.fn(async () => "entry-1");
    const r = await s.land({
      host: host(enqueueMerge),
      agentId: "a1",
      streamId: "s1",
      targetBranch: "main",
    });
    expect(enqueueMerge).toHaveBeenCalledWith({
      streamId: "s1",
      targetBranch: "main",
      agentId: "a1",
    });
    expect(r).toEqual({ success: true });
  });

  it("returns null for a stream target (the queue lands to a branch)", async () => {
    const enqueueMerge = vi.fn(async () => "x");
    const r = await s.land({
      host: host(enqueueMerge),
      agentId: "a1",
      streamId: "s1",
      targetStream: "root",
    });
    expect(r).toBeNull();
    expect(enqueueMerge).not.toHaveBeenCalled();
  });

  it("returns null when the host has no enqueueMerge", async () => {
    const r = await s.land({
      host: host(),
      agentId: "a1",
      streamId: "s1",
      targetBranch: "main",
    });
    expect(r).toBeNull();
  });

  it("returns null when the adapter has no queue (enqueue returns null)", async () => {
    const r = await s.land({
      host: host(async () => null),
      agentId: "a1",
      streamId: "s1",
      targetBranch: "main",
    });
    expect(r).toBeNull();
  });
});
