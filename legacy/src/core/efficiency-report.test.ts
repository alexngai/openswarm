import { describe, it, expect } from "vitest";
import {
  parseRunJsonl,
  totalTokens,
  cacheReadFraction,
  ctxPerTurn,
  runCostUsd,
  formatArm,
  formatDelta,
  type RunStats,
} from "./efficiency-report.js";

function stop(usage: Record<string, number>): string {
  return JSON.stringify({ type: "message_stop", stopReason: "end_turn", usage });
}

describe("parseRunJsonl", () => {
  it("takes the LAST message_stop's usage (cumulative tally) and counts turns", () => {
    const stats = parseRunJsonl([
      stop({ inputTokens: 100, outputTokens: 10 }),
      JSON.stringify({ type: "text_delta", text: "hi" }),
      stop({ inputTokens: 300, outputTokens: 50, cacheReadInputTokens: 900 }),
    ]);
    expect(stats.turns).toBe(2);
    expect(stats.inputTokens).toBe(300);
    expect(stats.cacheReadInputTokens).toBe(900);
    expect(stats.cacheWriteInputTokens).toBe(0);
  });

  it("skips non-JSON lines and unknown events", () => {
    const stats = parseRunJsonl([
      "[openswarm] some log line",
      "",
      '{"type":"tool_use_start","id":"t1","name":"read_file"}',
      stop({ inputTokens: 5, outputTokens: 1 }),
    ]);
    expect(stats.turns).toBe(1);
    expect(stats.inputTokens).toBe(5);
  });

  it("collects deduped attributed miss reasons (TE-21)", () => {
    const stats = parseRunJsonl([
      JSON.stringify({
        type: "cache_miss",
        payload: { tokens: 10, changedComponents: ["tools"] },
      }),
      JSON.stringify({
        type: "cache_miss",
        payload: { tokens: 20, changedComponents: ["tools", "system"] },
      }),
      stop({ inputTokens: 1, outputTokens: 1 }),
    ]);
    expect(stats.missReasons).toEqual(["system", "tools"]);
  });
});

function runStats(over: Partial<RunStats> = {}): RunStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    turns: 1,
    missReasons: [],
    ...over,
  };
}

describe("derived columns", () => {
  it("uses the same formulas as /cost and /status", () => {
    const s = runStats({
      inputTokens: 2_000,
      outputTokens: 500,
      cacheReadInputTokens: 8_000,
      cacheWriteInputTokens: 1_000,
      turns: 2,
    });
    expect(totalTokens(s)).toBe(11_500);
    expect(cacheReadFraction(s)).toBeCloseTo(0.8);
    // (2000 + 8000 + 1000) / 2 turns
    expect(ctxPerTurn(s)).toBe(5_500);
  });

  it("cache fraction and ctx/turn are undefined without data", () => {
    const s = runStats({ turns: 0 });
    expect(cacheReadFraction(s)).toBeUndefined();
    expect(ctxPerTurn(s)).toBeUndefined();
  });

  it("prices via MODEL_PRICING and stays honest for unpriced models", () => {
    const s = runStats({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // Sonnet: $3 + $15
    expect(runCostUsd(s, "claude-sonnet-4-6")).toBeCloseTo(18);
    expect(runCostUsd(s, "deepseek-chat")).toBeUndefined();
    expect(runCostUsd(s, undefined)).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formatArm renders per-run rows, a mean line, and attributed misses", () => {
    const out = formatArm(
      {
        label: "A",
        runs: [
          runStats({ inputTokens: 100, cacheReadInputTokens: 900, missReasons: ["tools"] }),
          runStats({ inputTokens: 50, cacheReadInputTokens: 950 }),
        ],
      },
      "claude-sonnet-4-6",
    );
    expect(out).toContain("arm A");
    expect(out).toContain("mean");
    expect(out).toContain("90%"); // run 1 cache%
    expect(out).toContain("attributed misses: tools");
  });

  it("formatDelta reports token %, cache pp, and cost % between arm means", () => {
    const a = {
      label: "A",
      runs: [runStats({ inputTokens: 1_000, outputTokens: 0 })],
    };
    const b = {
      label: "B",
      runs: [
        runStats({ inputTokens: 500, outputTokens: 0, cacheReadInputTokens: 500 }),
      ],
    };
    const line = formatDelta(a, b, "claude-sonnet-4-6");
    // totals: A=1000, B=500+500=1000 → 0.0%; cache share: A 0%, B 50% → +50.0pp.
    expect(line).toContain("total tokens 0.0%");
    expect(line).toContain("cache 50.0pp");
  });
});
