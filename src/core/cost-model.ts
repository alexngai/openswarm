/**
 * cost-model.ts — pluggable cost & throughput accounting for heterogeneous swarms.
 *
 * docs/50 §5.1 (gap G1). The single-$-table pricing in budget.ts (`usageCostUsd`)
 * answers only "how many dollars?" for a handful of frontier models and returns 0
 * for open-weight ones. The heterogeneous cost/throughput study needs three numbers
 * per usage sample — dollars, GPU-seconds, FLOPs — with a backend per measurement
 * regime:
 *
 *   - ApiCostModel      — dollars from the pricing table + a FLOPs estimate from
 *                         model params. No hardware access required (P0: works on
 *                         already-captured docs/47 traces).
 *   - SelfHostCostModel — GPU-seconds measured off the vLLM serving layer (carried
 *                         on the sample) + optional dollars from $/GPU-hour (P1).
 *
 * Pure module — no I/O, no swarm deps — like budget.ts. The pricing table stays the
 * single source of truth (imported, never duplicated). One semantics change vs
 * `usageCostUsd`: an unpriced model yields `usd: undefined` (NOT 0), so a roll-up
 * can distinguish "free/local" from "genuinely $0" and flag partial coverage
 * (see `sumCosts`). This is the honesty the dual-axis frontier needs (docs/50 §8.1).
 */

import { MODEL_PRICING } from "./budget.js";
import type { BudgetUsage } from "./budget.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One usage sample to price — token counts plus optional timing/GPU signal. */
export interface CostSample extends BudgetUsage {
  /** Model id; may carry a provider/gateway prefix, e.g. "litellm/qwen3-8b". */
  readonly model?: string;
  /** Wall-clock of the sampled turn(s), if known (feeds throughput analysis). */
  readonly wallClockMs?: number;
  /** GPU-seconds attributed to this sample, measured off the serving layer. */
  readonly gpuSeconds?: number;
}

/**
 * Cost of a sample across the three axes. Each field is `undefined` when that axis
 * cannot be determined (unpriced model → no `usd`; unknown params → no `flops`; no
 * serving-layer measurement → no `gpuSeconds`). Undefined ≠ 0 — that distinction is
 * the whole point.
 */
export interface CostBreakdown {
  readonly usd?: number;
  readonly gpuSeconds?: number;
  readonly flops?: number;
}

/** A cost backend: turns a usage sample into a per-axis cost breakdown. */
export interface CostModel {
  cost(sample: CostSample): CostBreakdown;
}

// ---------------------------------------------------------------------------
// Model → active-parameter registry (for FLOPs)
// ---------------------------------------------------------------------------

/**
 * Active parameters per token, in BILLIONS, for FLOPs estimation. MoE models use
 * ACTIVE params, not total — a token routes through only its experts. These are
 * illustrative defaults for the study's candidate pool (docs/50 §4.2 / §9.4);
 * override per experiment via the `params` option once the pool is fixed. Keys are
 * matched after `normalizeModelId` (prefix-stripped, lowercased).
 */
export const MODEL_ACTIVE_PARAMS_B: Readonly<Record<string, number>> = {
  "qwen3-4b": 4,
  "qwen3-8b": 8,
  "llama-3.1-8b": 8,
  "qwen3-14b": 14,
  "qwen3-32b": 32,
  "qwen3-30b-a3b": 3, // 30B total, ~3B active/token (MoE)
  "qwen3-coder-30b-a3b-instruct": 3, // coder variant of qwen3-30b-a3b (same MoE, ~3B active)
  "qwen2.5-coder-32b-instruct": 32, // dense 32B coder (alt small tier)
  // Bedrock inference-profile ids (normalizeModelId strips the awsbedrock/ prefix → the bare id).
  "us.meta.llama3-1-8b-instruct-v1:0": 8, // Llama 3.1 8B (dense) — native-Bedrock small tier
  "meta.llama3-1-8b-instruct-v1:0": 8,
  "us.meta.llama3-3-70b-instruct-v1:0": 70, // Llama 3.3 70B (dense) — native-Bedrock large tier (docs/62 Phase 1.5, known-params pair)
  "meta.llama3-3-70b-instruct-v1:0": 70,
};

/** Strip a provider/gateway prefix ("litellm/…", "azureoai/…") and lowercase. */
export function normalizeModelId(model: string | undefined): string {
  if (model === undefined || model === "") return "";
  const slash = model.lastIndexOf("/");
  return (slash >= 0 ? model.slice(slash + 1) : model).toLowerCase();
}

/**
 * Forward-pass FLOPs ≈ 2 · N · tokens (N = active params). A dense transformer does
 * ~2 FLOPs (one multiply-add) per parameter per token. We count fresh input +
 * output; cache-READ tokens are served from the KV cache and don't re-incur prefill,
 * so they're excluded (they aren't in `inputTokens` under the usual API convention,
 * and are ignored here regardless). Ignores the attention quadratic term — negligible
 * vs the MLP at these context lengths. A RELATIVE estimate for comparing arms on the
 * same pool, not billing-accurate (docs/50 §8.5). Returns undefined when params are
 * unknown.
 */
export function estimateForwardFlops(
  sample: CostSample,
  activeParamsB: number | undefined,
): number | undefined {
  if (activeParamsB === undefined) return undefined;
  const computeTokens = sample.inputTokens + sample.outputTokens;
  return 2 * activeParamsB * 1e9 * computeTokens;
}

// ---------------------------------------------------------------------------
// Pricing helper (reuses MODEL_PRICING — single source of truth)
// ---------------------------------------------------------------------------

/**
 * USD from the pricing table, or `undefined` when the model has no entry. Tries an
 * exact key first (back-compat with `usageCostUsd` keys), then the normalized id, so
 * "litellm/gpt-4o-2024-11-20" resolves to the "gpt-4o-2024-11-20" price. Prices
 * input, output, AND cache traffic (docs/53): cache reads default to 0.1× the
 * input rate (Anthropic's cache-read rate; OpenAI's ~90%-off cached input is the
 * same ballpark) and cache writes to 1.25× (Anthropic 5-minute-TTL write rate;
 * OpenAI-style APIs report no separate write tokens, so the term is 0 there).
 * Override per model via `cacheReadPerMTok` / `cacheWritePerMTok`.
 */
export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok?: number;
  readonly cacheWritePerMTok?: number;
}

function priceUsd(
  sample: CostSample,
  table: Readonly<Record<string, ModelPricing>>,
): number | undefined {
  const pricing =
    (sample.model !== undefined ? table[sample.model] : undefined) ??
    table[normalizeModelId(sample.model)];
  if (pricing === undefined) return undefined;
  const cacheReadRate = pricing.cacheReadPerMTok ?? pricing.inputPerMTok * 0.1;
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25;
  return (
    (sample.inputTokens * pricing.inputPerMTok +
      sample.outputTokens * pricing.outputPerMTok +
      (sample.cacheReadInputTokens ?? 0) * cacheReadRate +
      (sample.cacheWriteInputTokens ?? 0) * cacheWriteRate) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export interface ApiCostModelOptions {
  /** Pricing table override (defaults to MODEL_PRICING). */
  readonly pricing?: Readonly<Record<string, ModelPricing>>;
  /** Active-params (B) by normalized model id (defaults to MODEL_ACTIVE_PARAMS_B). */
  readonly params?: Readonly<Record<string, number>>;
}

/**
 * Dollars from the pricing table + a FLOPs estimate from model params. GPU-seconds
 * pass through when a sample happens to carry them, but this backend never derives
 * them. The working default for P0 (re-pricing existing traces without hardware).
 */
export class ApiCostModel implements CostModel {
  private readonly pricing: Readonly<Record<string, ModelPricing>>;
  private readonly params: Readonly<Record<string, number>>;

  constructor(opts: ApiCostModelOptions = {}) {
    this.pricing = opts.pricing ?? MODEL_PRICING;
    this.params = opts.params ?? MODEL_ACTIVE_PARAMS_B;
  }

  cost(sample: CostSample): CostBreakdown {
    return {
      usd: priceUsd(sample, this.pricing),
      flops: estimateForwardFlops(sample, this.params[normalizeModelId(sample.model)]),
      gpuSeconds: sample.gpuSeconds,
    };
  }
}

export interface SelfHostCostModelOptions {
  /** $/GPU-hour, used to derive `usd` from measured `gpuSeconds`. */
  readonly usdPerGpuHour?: number;
  /** Active-params (B) by normalized model id (defaults to MODEL_ACTIVE_PARAMS_B). */
  readonly params?: Readonly<Record<string, number>>;
}

/**
 * GPU-seconds measured off the serving layer (carried on the sample) + FLOPs from
 * params + optional dollars from $/GPU-hour. The iso-compute ground truth (P1). `usd`
 * is undefined unless BOTH `gpuSeconds` (on the sample) and `usdPerGpuHour` are known.
 */
export class SelfHostCostModel implements CostModel {
  private readonly usdPerGpuHour?: number;
  private readonly params: Readonly<Record<string, number>>;

  constructor(opts: SelfHostCostModelOptions = {}) {
    this.usdPerGpuHour = opts.usdPerGpuHour;
    this.params = opts.params ?? MODEL_ACTIVE_PARAMS_B;
  }

  cost(sample: CostSample): CostBreakdown {
    const gpuSeconds = sample.gpuSeconds;
    const usd =
      gpuSeconds !== undefined && this.usdPerGpuHour !== undefined
        ? (gpuSeconds / 3600) * this.usdPerGpuHour
        : undefined;
    return {
      usd,
      gpuSeconds,
      flops: estimateForwardFlops(sample, this.params[normalizeModelId(sample.model)]),
    };
  }
}

// ---------------------------------------------------------------------------
// Aggregation (coverage-aware)
// ---------------------------------------------------------------------------

/**
 * A summed cost across many breakdowns. The `*Complete` flags are false when ANY
 * summed sample lacked that axis — so a roll-up over a heterogeneous tree reports a
 * total AND whether it's a full or partial figure (e.g. `usdComplete: false` means
 * some model was unpriced and the `$` total is a lower bound). This is why per-sample
 * `usd` is `undefined` rather than 0: the information survives to the sum.
 */
export interface CostTotal {
  readonly usd: number;
  readonly gpuSeconds: number;
  readonly flops: number;
  readonly usdComplete: boolean;
  readonly gpuComplete: boolean;
  readonly flopsComplete: boolean;
}

/** Sum breakdowns, tracking per-axis coverage (see `CostTotal`). */
export function sumCosts(breakdowns: Iterable<CostBreakdown>): CostTotal {
  let usd = 0;
  let gpuSeconds = 0;
  let flops = 0;
  let usdComplete = true;
  let gpuComplete = true;
  let flopsComplete = true;
  for (const b of breakdowns) {
    if (b.usd === undefined) usdComplete = false;
    else usd += b.usd;
    if (b.gpuSeconds === undefined) gpuComplete = false;
    else gpuSeconds += b.gpuSeconds;
    if (b.flops === undefined) flopsComplete = false;
    else flops += b.flops;
  }
  return { usd, gpuSeconds, flops, usdComplete, gpuComplete, flopsComplete };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Pick a CostModel from the environment: SelfHostCostModel when
 * OPENSWARM_USD_PER_GPU_HOUR is set (self-hosted regime), else ApiCostModel.
 * Until the serving layer stamps `gpuSeconds` onto samples (G2), the self-host
 * backend yields GPU/`$` only once that data flows; ApiCostModel ($ + FLOPs) is the
 * working P0 default. docs/50 §4.2 dual-axis.
 */
export function defaultCostModel(
  env: Record<string, string | undefined> = process.env,
): CostModel {
  const perHour = env["OPENSWARM_USD_PER_GPU_HOUR"];
  if (perHour !== undefined && perHour !== "") {
    const n = Number(perHour);
    if (Number.isFinite(n)) return new SelfHostCostModel({ usdPerGpuHour: n });
  }
  return new ApiCostModel();
}
