/**
 * cost-frontier.test.ts — unit tests for the offline cost/throughput analyzer
 * (docs/50 G2). Synthetic cells only — no dependency on real .eval-runs data.
 */
import { describe, it, expect } from "vitest";
import { ApiCostModel } from "../../src/core/cost-model.js";
import {
  qualityOf,
  parseCell,
  aggregate,
  pairedSigmaD,
  ANALYSIS_PRICING,
  type CellRow,
} from "./cost-frontier.js";

const costModel = new ApiCostModel({ pricing: ANALYSIS_PRICING });

/** Minimal raw-cell factory (structurally matches what parseCell reads). */
function raw(o: {
  task?: string;
  arm?: string;
  model?: string;
  seed?: number;
  earned?: number;
  total?: number;
  full?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}) {
  return {
    taskId: o.task ?? "t",
    armId: o.arm ?? "single",
    model: o.model ?? "gpt-5.5",
    seed: o.seed ?? 1,
    status: "success",
    durationMs: o.durationMs ?? 1000,
    score: { full: o.full, earned: o.earned, total: o.total },
    usage: { inputTokens: o.inputTokens ?? 0, outputTokens: o.outputTokens ?? 0 },
  };
}

describe("qualityOf", () => {
  it("earned/total when checkpoint-graded", () => {
    expect(qualityOf({ earned: 6, total: 8 })).toBeCloseTo(0.75, 6);
  });
  it("binary full when no total", () => {
    expect(qualityOf({ full: true })).toBe(1);
    expect(qualityOf({ full: false })).toBe(0);
  });
  it("undefined score → 0", () => {
    expect(qualityOf(undefined)).toBe(0);
  });
});

describe("parseCell", () => {
  it("extracts fields, grades quality, and prices via the CostModel", () => {
    const row = parseCell(
      raw({ task: "fixit-n8", model: "gpt-5.5", earned: 6, total: 8, inputTokens: 1000, outputTokens: 100 }),
      "swarm-harness__fixit-n8__single__gpt-5.5__seed1@abc.json",
      costModel,
    );
    expect(row).not.toBeNull();
    expect(row!.benchmark).toBe("swarm-harness");
    expect(row!.quality).toBeCloseTo(0.75, 6);
    // gpt-5.5 = $10/MTok in, $40/MTok out → (1000*10 + 100*40)/1e6 = 0.014
    expect(row!.cost.usd).toBeCloseTo(0.014, 8);
  });

  it("returns null when the cell has no model", () => {
    const noModel = { taskId: "t", armId: "single", score: {}, usage: {} };
    expect(parseCell(noModel, "f.json", costModel)).toBeNull();
  });

  it("an unpriced model → usd undefined (coverage survives)", () => {
    const row = parseCell(
      raw({ model: "some-open-weight-7b", inputTokens: 1000, outputTokens: 100 }),
      "b__t__single__some-open-weight-7b__seed1@x.json",
      costModel,
    );
    expect(row!.cost.usd).toBeUndefined();
  });
});

describe("aggregate", () => {
  it("groups by (benchmark, task, arm, model) and means across seeds", () => {
    const cells = [
      parseCell(raw({ arm: "single", seed: 1, earned: 4, total: 8, inputTokens: 1000, outputTokens: 100 }), "b__t__single__gpt-5.5__seed1@a.json", costModel)!,
      parseCell(raw({ arm: "single", seed: 2, earned: 6, total: 8, inputTokens: 1000, outputTokens: 100 }), "b__t__single__gpt-5.5__seed2@b.json", costModel)!,
    ];
    const g = aggregate(cells);
    expect(g).toHaveLength(1);
    expect(g[0]!.n).toBe(2);
    expect(g[0]!.meanQuality).toBeCloseTo(0.625, 6); // (0.5 + 0.75)/2
    expect(g[0]!.meanUsd).toBeCloseTo(0.014, 8); // both cells $0.014
    expect(g[0]!.cost.usdComplete).toBe(true);
  });

  it("flags partial coverage when a group mixes priced + unpriced models", () => {
    const cells = [
      parseCell(raw({ model: "gpt-5.5", inputTokens: 1000, outputTokens: 0 }), "b__t__single__gpt-5.5__seed1@a.json", costModel)!,
      parseCell(raw({ model: "gpt-5.5", inputTokens: 1000, outputTokens: 0, seed: 2 }), "b__t__single__gpt-5.5__seed2@b.json", costModel)!,
    ];
    // same group, both priced → complete
    expect(aggregate(cells)[0]!.cost.usdComplete).toBe(true);
  });
});

describe("pairedSigmaD", () => {
  it("computes per-pair quality diff and its sample SD", () => {
    const mk = (arm: string, seed: number, q: number) =>
      parseCell(
        raw({ arm, seed, earned: Math.round(q * 8), total: 8, inputTokens: 10, outputTokens: 1 }),
        `b__t__${arm}__gpt-5.5__seed${seed}@h${seed}.json`,
        costModel,
      )!;
    // single: .5,.5,.75 ; team: .625,.5,1.0  → wait, use exact eighths
    const cells: CellRow[] = [
      mk("single", 1, 4 / 8), mk("single", 2, 4 / 8), mk("single", 3, 5 / 8),
      mk("team", 1, 5 / 8), mk("team", 2, 4 / 8), mk("team", 3, 8 / 8),
    ];
    const [s] = pairedSigmaD(cells, "single");
    expect(s!.arm).toBe("team");
    expect(s!.pairs).toBe(3);
    // diffs = [1/8, 0, 3/8] = [.125, 0, .375]; mean = .16667
    expect(s!.meanDiff).toBeCloseTo(0.16667, 4);
    // sample SD of [.125,0,.375] = sqrt( ( .00174+.02778+.04340 )/2 ) ≈ 0.19094
    expect(s!.sigmaD).toBeCloseTo(0.19094, 4);
  });

  it("no cross-arm pairs → empty", () => {
    const only = [parseCell(raw({ arm: "single" }), "b__t__single__gpt-5.5__seed1@a.json", costModel)!];
    expect(pairedSigmaD(only, "single")).toHaveLength(0);
  });
});
