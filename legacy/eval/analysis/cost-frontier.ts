/**
 * cost-frontier.ts — offline cost/throughput analyzer over swarmkit-eval cache
 * cells (docs/50 §5.2 / gap G2).
 *
 * swarmkit-eval writes one content-addressed cell per (task × arm × model × seed)
 * under `.eval-runs/cache/*.json` — each with a checkpoint `score`, token `usage`,
 * and `durationMs`. This reads those cells and re-prices every one through the
 * shipped CostModel (src/core/cost-model.ts), then produces:
 *   - a per-(benchmark, task, arm, model) aggregate: quality, tokens, $, FLOPs, latency;
 *   - the paired quality σ_d across arms (the input the docs/50 §3.1 G-power calc
 *     needs) wherever the same task+seed ran under more than one arm.
 *
 * No new compute — it only reads already-captured cells (docs/50 P0). Pure functions
 * + a CLI `main`. Run: `tsx eval/analysis/cost-frontier.ts [cacheDir]`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiCostModel, sumCosts } from "../../src/core/cost-model.js";
import type { CostBreakdown, CostModel, CostSample, CostTotal } from "../../src/core/cost-model.js";
import { MODEL_PRICING } from "../../src/core/budget.js";

/**
 * Illustrative pricing for the models present in the local cache so the `$` axis
 * demonstrates end-to-end. Best-effort public rates — VERIFY before citing. Keys
 * match `normalizeModelId` (the ApiCostModel falls back to the normalized id), so
 * "us.anthropic.claude-sonnet-4-5-…" and "azureoai/gpt-5.5" resolve here.
 */
export const ANALYSIS_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  ...MODEL_PRICING,
  "claude-sonnet-4-5-20250929-v1:0": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "gpt-5.5": { inputPerMTok: 10.0, outputPerMTok: 40.0 }, // proxied to the gpt-5 tier
  // Aliases the cascade experiments record in `byModel` (the spec's model string), so
  // the $ axis lights up on alias-driven local runs. Verify rates before citing.
  haiku: { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  sonnet: { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
};

/** The subset of a swarmkit-eval cell result this analyzer reads. */
/** Cascade provenance the CascadeAdapter writes to `raw.metadata.cascade` (docs/51 B1). */
interface CascadeMeta {
  tiers?: string[];
  tau?: number;
  escalations?: number;
  /** Advisor arm (critic-loop): executor↔critic rounds + the iteration the critic approved. */
  rounds?: number;
  approvedAtRound?: number;
  /** Per-tier (per-model) usage — the heterogeneous cost breakdown. */
  perModel?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
      totalTokens?: number;
      calls?: number;
    }
  >;
  /** Team-wide LLM-call count (docs/53 TE-14) — divides tokens into per-call means. */
  teamCalls?: number;
}

interface RawCell {
  taskId?: string;
  armId?: string;
  model?: string;
  seed?: number;
  status?: string;
  durationMs?: number;
  score?: { full?: boolean; earned?: number; total?: number };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /** The adapters persist cache writes under this name (RawRun usage shape). */
    cacheCreationTokens?: number;
    totalTokens?: number;
  };
  metadata?: { cascade?: CascadeMeta };
}

/** One parsed + priced cell. */
export interface CellRow {
  file: string;
  benchmark: string;
  taskId: string;
  arm: string;
  model: string;
  seed: number;
  status: string;
  quality: number; // [0,1]
  earned: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  cost: CostBreakdown;
  /** Cascade cells only: escalation gate τ, escalation count, and per-tier priced cost. */
  tau?: number;
  escalations?: number;
  perModelCost?: Record<string, CostBreakdown>;
  /** LLM calls in the cell (docs/53 TE-14); from teamCalls, else summed per-tier calls. */
  calls?: number;
  /** Mean prompt tokens per LLM call — fresh input + cache read/write (TE-14). */
  contextTokensPerCall?: number;
  /** Fraction of input-side tokens served from prompt cache (TE-14). */
  cacheReadFraction?: number;
  /** Advisor cells only (critic-loop): executor↔critic rounds + approval iteration. */
  rounds?: number;
  approvedAtRound?: number;
}

/** Graded quality in [0,1]: earned/total when checkpoint-graded, else binary `full`. */
export function qualityOf(score: RawCell["score"]): number {
  if (score === undefined) return 0;
  if (typeof score.total === "number" && score.total > 0 && typeof score.earned === "number") {
    return score.earned / score.total;
  }
  return score.full ? 1 : 0;
}

/** Parse + price one raw cell. Returns null when it has no model to price against. */
export function parseCell(raw: RawCell, file: string, costModel: CostModel): CellRow | null {
  const model = raw.model;
  if (model === undefined) return null;
  const usage = raw.usage ?? {};
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  // Adapters persist cache writes as `cacheCreationTokens` (RawRun usage shape);
  // accept the legacy `cacheWriteTokens` name too so older cells still price.
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? usage.cacheCreationTokens ?? 0;
  const sample: CostSample = {
    model,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheReadTokens,
    cacheWriteInputTokens: cacheWriteTokens,
  };

  // Cascade cells price per TIER (each model separately) — more accurate than pricing
  // the flat mixed team usage; the cell total is the sum of the per-tier breakdowns.
  const cascade = raw.metadata?.cascade;
  let cost = costModel.cost(sample);
  let perModelCost: Record<string, CostBreakdown> | undefined;
  let perModelCalls = 0;
  let sawPerModelCalls = false;
  if (cascade?.perModel !== undefined) {
    perModelCost = {};
    const parts: CostBreakdown[] = [];
    for (const [m, u] of Object.entries(cascade.perModel)) {
      const bd = costModel.cost({
        model: m,
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: u.cacheWriteInputTokens ?? 0,
      });
      perModelCost[m] = bd;
      parts.push(bd);
      if (u.calls !== undefined) {
        perModelCalls += u.calls;
        sawPerModelCalls = true;
      }
    }
    const summed = sumCosts(parts);
    cost = {
      ...(summed.usdComplete && { usd: summed.usd }),
      ...(summed.gpuComplete && { gpuSeconds: summed.gpuSeconds }),
      ...(summed.flopsComplete && { flops: summed.flops }),
    };
  }

  // TE-14 per-call metrics (docs/53): context tokens sent per LLM call, and the
  // cache-served fraction of the input side. Only for cells recorded after the
  // harness started counting calls.
  const calls = cascade?.teamCalls ?? (sawPerModelCalls ? perModelCalls : undefined);
  const inputSide = inputTokens + cacheReadTokens + cacheWriteTokens;
  const contextTokensPerCall = calls !== undefined && calls > 0 ? inputSide / calls : undefined;
  const cacheReadFraction = inputSide > 0 ? cacheReadTokens / inputSide : undefined;

  return {
    file,
    benchmark: file.split("__")[0] ?? "",
    taskId: raw.taskId ?? "",
    arm: raw.armId ?? "",
    model,
    seed: raw.seed ?? 0,
    status: raw.status ?? "",
    quality: qualityOf(raw.score),
    earned: raw.score?.earned ?? 0,
    total: raw.score?.total ?? 0,
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    durationMs: raw.durationMs ?? 0,
    cost,
    ...(cascade?.tau !== undefined && { tau: cascade.tau }),
    ...(cascade?.escalations !== undefined && { escalations: cascade.escalations }),
    ...(cascade?.rounds !== undefined && { rounds: cascade.rounds }),
    ...(cascade?.approvedAtRound !== undefined && { approvedAtRound: cascade.approvedAtRound }),
    ...(perModelCost !== undefined && { perModelCost }),
    ...(calls !== undefined && { calls }),
    ...(contextTokensPerCall !== undefined && { contextTokensPerCall }),
    ...(cacheReadFraction !== undefined && { cacheReadFraction }),
  };
}

/** Load every `*.json` cell (skipping `.trace.jsonl`) from a cache dir. */
export function loadCells(cacheDir: string, costModel: CostModel): CellRow[] {
  const out: CellRow[] = [];
  for (const name of readdirSync(cacheDir)) {
    if (!name.endsWith(".json") || name.endsWith(".trace.jsonl")) continue;
    let raw: RawCell;
    try {
      raw = JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as RawCell;
    } catch {
      continue;
    }
    const row = parseCell(raw, name, costModel);
    if (row !== null) out.push(row);
  }
  return out;
}

/** Per-(benchmark, task, arm, model) aggregate across seeds. */
export interface GroupStats {
  benchmark: string;
  taskId: string;
  arm: string;
  model: string;
  n: number;
  meanQuality: number;
  meanTotalTokens: number;
  meanDurationMs: number;
  /** Cost summed across the group's seeds (coverage-aware). */
  cost: CostTotal;
  /** Mean $/cell when every cell was priced, else undefined (partial coverage). */
  meanUsd?: number;
  /** Mean context tokens per LLM call across cells that recorded calls (TE-14). */
  meanContextTokensPerCall?: number;
  /** Mean cache-served input fraction across cells that recorded it (TE-14). */
  meanCacheReadFraction?: number;
}

export function aggregate(cells: CellRow[]): GroupStats[] {
  const groups = new Map<string, CellRow[]>();
  for (const c of cells) {
    // Drop zero-token cells: mock cells and INFRA failures (the agent never really ran —
    // e.g. a crashed `topology cascade` with exitCode≠0). These are NOT (quality, cost)
    // points and would poison the group means. A real agent that ran and FAILED the task
    // keeps tokens>0 and IS a valid (quality=0, cost>0) frontier point — kept.
    if (c.totalTokens <= 0) continue;
    const k = [c.benchmark, c.taskId, c.arm, c.model].join(" ");
    const arr = groups.get(k);
    if (arr) arr.push(c);
    else groups.set(k, [c]);
  }
  const stats: GroupStats[] = [];
  for (const cs of groups.values()) {
    const first = cs[0]!;
    const n = cs.length;
    const cost = sumCosts(cs.map((c) => c.cost));
    const ctx = cs.map((c) => c.contextTokensPerCall).filter((v): v is number => v !== undefined);
    const cache = cs.map((c) => c.cacheReadFraction).filter((v): v is number => v !== undefined);
    stats.push({
      benchmark: first.benchmark,
      taskId: first.taskId,
      arm: first.arm,
      model: first.model,
      n,
      meanQuality: mean(cs.map((c) => c.quality)),
      meanTotalTokens: mean(cs.map((c) => c.totalTokens)),
      meanDurationMs: mean(cs.map((c) => c.durationMs)),
      cost,
      meanUsd: cost.usdComplete ? cost.usd / n : undefined,
      ...(ctx.length > 0 && { meanContextTokensPerCall: mean(ctx) }),
      ...(cache.length > 0 && { meanCacheReadFraction: mean(cache) }),
    });
  }
  return stats.sort(
    (a, b) =>
      a.benchmark.localeCompare(b.benchmark) ||
      a.taskId.localeCompare(b.taskId) ||
      a.arm.localeCompare(b.arm) ||
      a.model.localeCompare(b.model),
  );
}

/** Paired quality difference (arm − baseline) per (benchmark, task, model, seed). */
export interface SigmaD {
  baseline: string;
  arm: string;
  pairs: number;
  meanDiff: number;
  /** Sample SD of the per-pair quality differences — the σ_d for the power calc. */
  sigmaD: number;
}

export function pairedSigmaD(cells: CellRow[], baseline = "single"): SigmaD[] {
  // (benchmark|task|model|seed) → arm → quality
  const idx = new Map<string, Map<string, number>>();
  for (const c of cells) {
    const k = [c.benchmark, c.taskId, c.model, c.seed].join("|");
    let m = idx.get(k);
    if (m === undefined) {
      m = new Map();
      idx.set(k, m);
    }
    m.set(c.arm, c.quality);
  }
  const arms = [...new Set(cells.map((c) => c.arm))].filter((a) => a !== baseline).sort();
  const out: SigmaD[] = [];
  for (const arm of arms) {
    const diffs: number[] = [];
    for (const m of idx.values()) {
      const b = m.get(baseline);
      const a = m.get(arm);
      if (b !== undefined && a !== undefined) diffs.push(a - b);
    }
    if (diffs.length === 0) continue;
    const md = mean(diffs);
    const sigmaD =
      diffs.length > 1
        ? Math.sqrt(diffs.reduce((s, d) => s + (d - md) ** 2, 0) / (diffs.length - 1))
        : 0;
    out.push({ baseline, arm, pairs: diffs.length, meanDiff: md, sigmaD });
  }
  return out;
}

/** One point on a τ-sweep curve — a (benchmark, task, arm, τ) group's means. */
export interface TauPoint {
  benchmark: string;
  taskId: string;
  arm: string;
  tau: number;
  n: number;
  meanQuality: number;
  meanEscalations: number;
  meanTotalTokens: number;
  cost: CostTotal;
  meanUsd?: number;
}

/**
 * Group cascade cells by (benchmark, task, arm, τ) → the τ-sweep curve (docs/51 §6).
 * Each point is quality vs cost at one escalation threshold; sweeping τ traces the
 * frontier and its knee. Non-cascade cells (no `tau`) are ignored.
 */
export function tauSweep(cells: CellRow[]): TauPoint[] {
  const groups = new Map<string, CellRow[]>();
  for (const c of cells) {
    if (c.tau === undefined) continue;
    // Same infra-failure guard as aggregate(): a crashed cascade cell (0 tokens) is not a
    // τ-sweep point — including it would understate cost and drag the quality mean down.
    if (c.totalTokens <= 0) continue;
    const k = [c.benchmark, c.taskId, c.arm, c.tau].join(" ");
    const arr = groups.get(k);
    if (arr) arr.push(c);
    else groups.set(k, [c]);
  }
  const out: TauPoint[] = [];
  for (const cs of groups.values()) {
    const first = cs[0]!;
    const n = cs.length;
    const cost = sumCosts(cs.map((c) => c.cost));
    out.push({
      benchmark: first.benchmark,
      taskId: first.taskId,
      arm: first.arm,
      tau: first.tau!,
      n,
      meanQuality: mean(cs.map((c) => c.quality)),
      meanEscalations: mean(cs.map((c) => c.escalations ?? 0)),
      meanTotalTokens: mean(cs.map((c) => c.totalTokens)),
      cost,
      meanUsd: cost.usdComplete ? cost.usd / n : undefined,
    });
  }
  return out.sort(
    (a, b) =>
      a.benchmark.localeCompare(b.benchmark) || a.taskId.localeCompare(b.taskId) || a.tau - b.tau,
  );
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function shortModel(m: string): string {
  const slash = m.lastIndexOf("/");
  const base = slash >= 0 ? m.slice(slash + 1) : m;
  return base.length > 26 ? base.slice(0, 25) + "…" : base;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function main(): void {
  const cacheDir = process.argv[2] ?? ".eval-runs/cache";
  const costModel = new ApiCostModel({ pricing: ANALYSIS_PRICING });
  const cells = loadCells(cacheDir, costModel);
  const real = cells.filter((c) => c.totalTokens > 0);
  const mock = cells.length - real.length;

  console.log(`\ncost-frontier — ${cacheDir}`);
  console.log(`cells: ${cells.length} (${real.length} with real tokens, ${mock} mock/0-token)\n`);

  const groups = aggregate(cells).filter((g) => g.meanTotalTokens > 0);
  const H = [
    pad("benchmark", 16), pad("task", 14), pad("arm", 7), pad("model", 20),
    pad("n", 3), pad("qual", 6), pad("tokens", 9), pad("$/cell", 9),
    pad("ctx/call", 9), pad("cache%", 6), pad("lat(s)", 7), "cov",
  ].join(" ");
  console.log("REAL-TOKEN CELLS — cost/latency (quality = earned/total):");
  console.log(H);
  console.log("-".repeat(H.length));
  for (const g of groups) {
    console.log(
      [
        pad(g.benchmark, 16), pad(g.taskId, 14), pad(g.arm, 7), pad(shortModel(g.model), 20),
        pad(String(g.n), 3), pad(g.meanQuality.toFixed(3), 6),
        pad(Math.round(g.meanTotalTokens).toLocaleString(), 9),
        pad(g.meanUsd !== undefined ? `$${g.meanUsd.toFixed(4)}` : "—", 9),
        pad(
          g.meanContextTokensPerCall !== undefined
            ? Math.round(g.meanContextTokensPerCall).toLocaleString()
            : "—",
          9,
        ),
        pad(
          g.meanCacheReadFraction !== undefined
            ? `${(g.meanCacheReadFraction * 100).toFixed(0)}%`
            : "—",
          6,
        ),
        pad((g.meanDurationMs / 1000).toFixed(1), 7),
        g.cost.usdComplete ? "$" : "$?",
      ].join(" "),
    );
  }

  // Advise-don't-redo consult log (docs/50 §10.4): per-cell executor↔critic rounds — the
  // over/under-consulting signal. approvedAt=—(cap) ⇒ never approved (hit criticMaxIterations).
  const advisorCells = real.filter((c) => c.rounds !== undefined);
  if (advisorCells.length > 0) {
    console.log("\nADVISOR CONSULT LOG (critic-loop rounds vs approval):");
    for (const c of advisorCells) {
      console.log(
        `  ${pad(c.taskId, 20)} ${pad(c.arm, 8)} seed${c.seed}  rounds=${c.rounds}  ` +
          `${c.approvedAtRound !== undefined ? `approvedAt=${c.approvedAtRound}` : "approvedAt=—(cap)"}  ` +
          `qual=${c.quality.toFixed(2)}  ${c.cost.usd !== undefined ? `$${c.cost.usd.toFixed(3)}` : "—"}`,
      );
    }
  }

  console.log("\nPAIRED σ_d (quality diff vs `single`, per task+model+seed):");
  const sig = pairedSigmaD(cells);
  if (sig.length === 0) {
    console.log("  none — no task+model+seed ran under >1 arm in this cache.");
  } else {
    for (const s of sig) {
      const allMock = !cells.some((c) => c.arm === s.arm && c.totalTokens > 0);
      console.log(
        `  ${s.baseline} → ${s.arm}: pairs=${s.pairs}  meanΔqual=${s.meanDiff.toFixed(3)}  σ_d=${s.sigmaD.toFixed(4)}` +
          (allMock ? "   ⚠ MOCK cells (0 tokens, deterministic) — σ_d not usable for the power calc" : ""),
      );
    }
  }

  const artifact = join(cacheDir, "..", "cost-frontier.json");
  writeFileSync(artifact, JSON.stringify({ cells: cells.length, real: real.length, groups, sigmaD: sig }, null, 2));
  console.log(`\nwrote ${artifact}\n`);
}

const isMain = process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
