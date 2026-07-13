import { afterEach, describe, expect, it, vi } from "vitest";
import { microcompactPolicyFromEnv } from "./compaction-runner.js";

// The tool-result eviction lever: OPENSWARM_MICROCOMPACT_KEEP_RECENT / _MIN_SAVINGS override the
// microcompaction policy from env (delivered via the harness scaffold.env at run time, no rebuild).
describe("microcompactPolicyFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns empty (CC defaults apply) when nothing is set", () => {
    vi.stubEnv("OPENSWARM_MICROCOMPACT_KEEP_RECENT", "");
    vi.stubEnv("OPENSWARM_MICROCOMPACT_MIN_SAVINGS", "");
    expect(microcompactPolicyFromEnv()).toEqual({});
  });

  it("reads OPENSWARM_MICROCOMPACT_KEEP_RECENT into keepRecent", () => {
    vi.stubEnv("OPENSWARM_MICROCOMPACT_KEEP_RECENT", "2");
    expect(microcompactPolicyFromEnv().keepRecent).toBe(2);
  });

  it("reads OPENSWARM_MICROCOMPACT_MIN_SAVINGS into minSavingsTokens", () => {
    vi.stubEnv("OPENSWARM_MICROCOMPACT_MIN_SAVINGS", "2000");
    expect(microcompactPolicyFromEnv().minSavingsTokens).toBe(2000);
  });

  it("accepts keepRecent=0 (maximally aggressive eviction)", () => {
    vi.stubEnv("OPENSWARM_MICROCOMPACT_KEEP_RECENT", "0");
    expect(microcompactPolicyFromEnv().keepRecent).toBe(0);
  });

  it("ignores non-numeric / negative values (falls back to defaults)", () => {
    vi.stubEnv("OPENSWARM_MICROCOMPACT_KEEP_RECENT", "abc");
    vi.stubEnv("OPENSWARM_MICROCOMPACT_MIN_SAVINGS", "-5");
    expect(microcompactPolicyFromEnv()).toEqual({});
  });

  it("reads both knobs together", () => {
    vi.stubEnv("OPENSWARM_MICROCOMPACT_KEEP_RECENT", "10");
    vi.stubEnv("OPENSWARM_MICROCOMPACT_MIN_SAVINGS", "5000");
    expect(microcompactPolicyFromEnv()).toEqual({
      keepRecent: 10,
      minSavingsTokens: 5000,
    });
  });
});
