/**
 * cost-model.test.ts — unit tests for src/core/cost-model.ts (docs/50 G1).
 *
 * Covers:
 *   - ApiCostModel: priced model → usd matches the pricing formula (back-compat)
 *   - ApiCostModel: UNPRICED model → usd undefined (NOT 0 — the key semantics change)
 *   - ApiCostModel: FLOPs from the params registry; unknown params → undefined
 *   - ApiCostModel: gateway-prefixed model id normalizes for both price and params
 *   - SelfHostCostModel: gpuSeconds passthrough; usd from $/GPU-hour; undefined cases
 *   - estimateForwardFlops: dense + MoE (active-params) cases; cache-read excluded
 *   - sumCosts: coverage flags flip false on any missing axis; totals are lower bounds
 *   - defaultCostModel: env selects self-host vs api backend
 */

import { describe, it, expect } from "vitest";
import {
  ApiCostModel,
  SelfHostCostModel,
  estimateForwardFlops,
  normalizeModelId,
  sumCosts,
  defaultCostModel,
  MODEL_ACTIVE_PARAMS_B,
  type CostSample,
} from "./cost-model.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRICED_MODEL = "claude-sonnet-4-6"; // $3/MTok in, $15/MTok out
const UNPRICED_MODEL = "qwen3-8b"; // open-weight: no pricing entry, but HAS params
const UNKNOWN_MODEL = "mystery-model-9000"; // no pricing AND no params

function sample(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  extra: Partial<CostSample> = {},
): CostSample {
  return { model, inputTokens, outputTokens, ...extra };
}

// ---------------------------------------------------------------------------
// ApiCostModel
// ---------------------------------------------------------------------------

describe("ApiCostModel", () => {
  const api = new ApiCostModel();

  it("priced model → usd matches the pricing formula (back-compat with usageCostUsd)", () => {
    // 100 in * $3 + 10 out * $15 = (300 + 150)/1e6 = $0.00045
    const { usd } = api.cost(sample(PRICED_MODEL, 100, 10));
    expect(usd).toBeCloseTo(0.00045, 8);
  });

  it("UNPRICED model → usd undefined, not 0 (the key semantics change)", () => {
    const { usd } = api.cost(sample(UNPRICED_MODEL, 1000, 500));
    expect(usd).toBeUndefined();
  });

  it("undefined model → usd undefined", () => {
    expect(api.cost(sample(undefined, 1000, 500)).usd).toBeUndefined();
  });

  it("FLOPs from the params registry: 2 · N · (in + out)", () => {
    // qwen3-8b = 8B active; (1000 + 500) tokens → 2 * 8e9 * 1500 = 2.4e13
    const { flops } = api.cost(sample(UNPRICED_MODEL, 1000, 500));
    expect(flops).toBe(2.4e13);
  });

  it("unknown params → flops undefined", () => {
    expect(api.cost(sample(UNKNOWN_MODEL, 1000, 500)).flops).toBeUndefined();
  });

  it("gateway-prefixed id normalizes for price AND params", () => {
    // "litellm/qwen3-8b" → params found (flops defined), still no price
    const bd = api.cost(sample("litellm/qwen3-8b", 1000, 500));
    expect(bd.flops).toBe(2.4e13);
    expect(bd.usd).toBeUndefined();
    // "litellm/claude-sonnet-4-6" → normalized price resolves
    expect(api.cost(sample("litellm/claude-sonnet-4-6", 100, 10)).usd).toBeCloseTo(0.00045, 8);
  });

  it("passes through gpuSeconds when a sample carries it", () => {
    expect(api.cost(sample(PRICED_MODEL, 10, 10, { gpuSeconds: 3.5 })).gpuSeconds).toBe(3.5);
  });

  it("accepts a per-experiment params override", () => {
    const custom = new ApiCostModel({ params: { "my-13b": 13 } });
    expect(custom.cost(sample("my-13b", 1000, 0)).flops).toBe(2 * 13e9 * 1000);
  });
});

// ---------------------------------------------------------------------------
// SelfHostCostModel
// ---------------------------------------------------------------------------

describe("SelfHostCostModel", () => {
  it("derives usd from measured gpuSeconds and $/GPU-hour", () => {
    const sh = new SelfHostCostModel({ usdPerGpuHour: 2.0 });
    // 7.2 GPU-s / 3600 * $2.0 = $0.004
    const bd = sh.cost(sample(UNPRICED_MODEL, 1000, 500, { gpuSeconds: 7.2 }));
    expect(bd.gpuSeconds).toBe(7.2);
    expect(bd.usd).toBeCloseTo(0.004, 8);
    expect(bd.flops).toBe(2.4e13); // params still estimate FLOPs for open-weight
  });

  it("usd undefined when gpuSeconds absent", () => {
    const sh = new SelfHostCostModel({ usdPerGpuHour: 2.0 });
    expect(sh.cost(sample(UNPRICED_MODEL, 1000, 500)).usd).toBeUndefined();
  });

  it("usd undefined when $/GPU-hour not configured", () => {
    const sh = new SelfHostCostModel();
    const bd = sh.cost(sample(UNPRICED_MODEL, 1000, 500, { gpuSeconds: 7.2 }));
    expect(bd.usd).toBeUndefined();
    expect(bd.gpuSeconds).toBe(7.2);
  });
});

// ---------------------------------------------------------------------------
// estimateForwardFlops
// ---------------------------------------------------------------------------

describe("estimateForwardFlops", () => {
  it("dense model: 2 · N · (in + out)", () => {
    expect(estimateForwardFlops(sample("x", 1000, 500), 8)).toBe(2 * 8e9 * 1500);
  });

  it("MoE uses ACTIVE params (registry stores 3B for qwen3-30b-a3b)", () => {
    expect(MODEL_ACTIVE_PARAMS_B["qwen3-30b-a3b"]).toBe(3);
    // 1000 in, 0 out → 2 * 3e9 * 1000 = 6e12
    expect(estimateForwardFlops(sample("x", 1000, 0), 3)).toBe(6e12);
  });

  it("excludes cache-read tokens (only input + output count)", () => {
    const s = sample("x", 1000, 500, { cacheReadInputTokens: 9_999_999 });
    expect(estimateForwardFlops(s, 8)).toBe(2 * 8e9 * 1500);
  });

  it("undefined params → undefined", () => {
    expect(estimateForwardFlops(sample("x", 1000, 500), undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeModelId
// ---------------------------------------------------------------------------

describe("normalizeModelId", () => {
  it("strips a gateway/provider prefix and lowercases", () => {
    expect(normalizeModelId("litellm/Qwen3-8B")).toBe("qwen3-8b");
    expect(normalizeModelId("azureoai/gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeModelId("bedrock/us.anthropic/claude")).toBe("claude");
  });
  it("passes a bare id through (lowercased)", () => {
    expect(normalizeModelId("Claude-Sonnet-4-6")).toBe("claude-sonnet-4-6");
  });
  it("undefined/empty → empty string", () => {
    expect(normalizeModelId(undefined)).toBe("");
    expect(normalizeModelId("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// sumCosts (coverage-aware)
// ---------------------------------------------------------------------------

describe("sumCosts", () => {
  const api = new ApiCostModel();

  it("all axes present → totals sum, all complete", () => {
    const total = sumCosts([
      { usd: 1, gpuSeconds: 2, flops: 3 },
      { usd: 4, gpuSeconds: 5, flops: 6 },
    ]);
    expect(total).toMatchObject({
      usd: 5,
      gpuSeconds: 7,
      flops: 9,
      usdComplete: true,
      gpuComplete: true,
      flopsComplete: true,
    });
  });

  it("a mixed priced/unpriced tree → usd is a lower bound, usdComplete false", () => {
    // priced frontier member + unpriced open-weight member (real hetero-swarm case)
    const total = sumCosts([
      api.cost(sample(PRICED_MODEL, 1_000_000, 0)), // usd $3, no flops (no params)
      api.cost(sample(UNPRICED_MODEL, 1000, 500)), // no usd, flops 2.4e13
    ]);
    expect(total.usd).toBeCloseTo(3.0, 6); // lower bound: only the priced member counted
    expect(total.usdComplete).toBe(false); // ← flags the open-weight member as unpriced
    expect(total.flopsComplete).toBe(false); // frontier member had no params → no flops
    expect(total.flops).toBe(2.4e13);
    expect(total.gpuComplete).toBe(false); // neither carried GPU-seconds
  });

  it("empty → zeros, everything vacuously complete", () => {
    expect(sumCosts([])).toMatchObject({ usd: 0, usdComplete: true, gpuComplete: true, flopsComplete: true });
  });
});

// ---------------------------------------------------------------------------
// defaultCostModel
// ---------------------------------------------------------------------------

describe("defaultCostModel", () => {
  it("OPENSWARM_USD_PER_GPU_HOUR set → self-host backend (usd from GPU-seconds)", () => {
    const m = defaultCostModel({ OPENSWARM_USD_PER_GPU_HOUR: "2.0" });
    const bd = m.cost(sample(UNPRICED_MODEL, 10, 10, { gpuSeconds: 3600 }));
    expect(bd.usd).toBeCloseTo(2.0, 8); // 3600s = 1 GPU-hr = $2
  });

  it("unset → api backend (usd from pricing, undefined for open-weight)", () => {
    const m = defaultCostModel({});
    expect(m.cost(sample(PRICED_MODEL, 100, 10)).usd).toBeCloseTo(0.00045, 8);
    expect(m.cost(sample(UNPRICED_MODEL, 10, 10, { gpuSeconds: 3600 })).usd).toBeUndefined();
  });

  it("non-numeric env → falls back to api backend", () => {
    const m = defaultCostModel({ OPENSWARM_USD_PER_GPU_HOUR: "not-a-number" });
    expect(m.cost(sample(PRICED_MODEL, 100, 10)).usd).toBeCloseTo(0.00045, 8);
  });
});
