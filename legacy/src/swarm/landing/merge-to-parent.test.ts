import { describe, it, expect } from "vitest";
import { MergeToParentStrategy } from "./merge-to-parent.js";
import type { LandingHost, MergeStreamResult } from "./types.js";

/** Records calls so we can assert the strategy routed to the right host method. */
function makeHost(result: MergeStreamResult | null): {
  host: LandingHost;
  calls: Array<{ method: string; agentId: string; opts: unknown }>;
} {
  const calls: Array<{ method: string; agentId: string; opts: unknown }> = [];
  const host: LandingHost = {
    streamIdFor: () => "stream-x",
    async mergeStreamForAgent(agentId, opts) {
      calls.push({ method: "mergeStreamForAgent", agentId, opts });
      return result;
    },
    async mergeStreamToBranchForAgent(agentId, opts) {
      calls.push({ method: "mergeStreamToBranchForAgent", agentId, opts });
      return result;
    },
  };
  return { host, calls };
}

describe("MergeToParentStrategy", () => {
  const strat = new MergeToParentStrategy();

  it("is named merge-to-parent", () => {
    expect(strat.name).toBe("merge-to-parent");
  });

  it("routes branch targets through mergeStreamToBranchForAgent with strategy", async () => {
    const ok: MergeStreamResult = { success: true, newHead: "abc" };
    const { host, calls } = makeHost(ok);
    const r = await strat.land({
      host,
      agentId: "a1",
      streamId: "s1",
      targetBranch: "main",
      strategy: "fast-forward",
    });
    expect(r).toEqual(ok);
    expect(calls).toEqual([
      {
        method: "mergeStreamToBranchForAgent",
        agentId: "a1",
        opts: { targetBranch: "main", strategy: "fast-forward" },
      },
    ]);
  });

  it("routes stream targets through mergeStreamForAgent", async () => {
    const ok: MergeStreamResult = { success: true };
    const { host, calls } = makeHost(ok);
    await strat.land({ host, agentId: "a2", streamId: "s2", targetStream: "team-root" });
    expect(calls).toEqual([
      { method: "mergeStreamForAgent", agentId: "a2", opts: { targetStream: "team-root" } },
    ]);
  });

  it("omits strategy when not provided", async () => {
    const { host, calls } = makeHost({ success: true });
    await strat.land({ host, agentId: "a3", streamId: "s3", targetBranch: "main" });
    expect(calls[0]!.opts).toEqual({ targetBranch: "main" });
  });

  it("propagates a null (adapter-unsupported) result", async () => {
    const { host } = makeHost(null);
    const r = await strat.land({ host, agentId: "a4", streamId: "s4", targetBranch: "main" });
    expect(r).toBeNull();
  });

  it("returns null and makes no host call when neither target is set", async () => {
    const { host, calls } = makeHost({ success: true });
    const r = await strat.land({ host, agentId: "a5", streamId: "s5" });
    expect(r).toBeNull();
    expect(calls).toEqual([]);
  });

  it("propagates a conflict result unchanged", async () => {
    const conflict: MergeStreamResult = {
      success: false,
      errorType: "conflict",
      conflicts: ["src/a.ts"],
    };
    const { host } = makeHost(conflict);
    const r = await strat.land({ host, agentId: "a6", streamId: "s6", targetStream: "root" });
    expect(r).toEqual(conflict);
  });
});
