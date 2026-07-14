import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compactContextWindowFromEnv,
  fullCompactionDisabled,
  microcompactPolicyFromEnv,
} from "./compaction-runner.js";

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

// The trigger-window override that ACTIVATES the eviction lever (induced context pressure):
// OPENSWARM_COMPACT_CONTEXT_WINDOW shrinks the window used to classify compaction pressure.
describe("compactContextWindowFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the provider fallback when unset/blank", () => {
    vi.stubEnv("OPENSWARM_COMPACT_CONTEXT_WINDOW", "");
    expect(compactContextWindowFromEnv(200_000)).toBe(200_000);
  });

  it("overrides with a positive value (lower trigger → fires sooner)", () => {
    vi.stubEnv("OPENSWARM_COMPACT_CONTEXT_WINDOW", "40000");
    expect(compactContextWindowFromEnv(200_000)).toBe(40_000);
  });

  it("ignores zero / negative / non-numeric (keeps the real window)", () => {
    for (const bad of ["0", "-1", "abc"]) {
      vi.stubEnv("OPENSWARM_COMPACT_CONTEXT_WINDOW", bad);
      expect(compactContextWindowFromEnv(200_000)).toBe(200_000);
    }
  });
});

// Isolate the eviction lever: OPENSWARM_DISABLE_FULL_COMPACTION skips auto summarizing compaction.
describe("fullCompactionDisabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is false by default / unset", () => {
    vi.stubEnv("OPENSWARM_DISABLE_FULL_COMPACTION", "");
    expect(fullCompactionDisabled()).toBe(false);
  });

  it("is true for truthy flags", () => {
    for (const on of ["1", "true", "on", "yes"]) {
      vi.stubEnv("OPENSWARM_DISABLE_FULL_COMPACTION", on);
      expect(fullCompactionDisabled()).toBe(true);
    }
  });

  it("is false for falsy / other values", () => {
    for (const off of ["0", "false", "off", "no", "maybe"]) {
      vi.stubEnv("OPENSWARM_DISABLE_FULL_COMPACTION", off);
      expect(fullCompactionDisabled()).toBe(false);
    }
  });
});
