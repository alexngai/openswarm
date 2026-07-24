/**
 * offline-frontier.ts — the oracle-cascade pre-check + offline frontier over
 * swarmkit-eval mono cells (docs/58).
 *
 * The docs/58 reframe: before running any live cascade, measure each model ONCE
 * and evaluate the routing policy offline. This reads the already-captured
 * `mono-small` / `mono-large` cells under `.eval-runs/cache/` and computes, per
 * (small, large) model pair present:
 *   - per-task structure (both-solve / small-only / large-only / neither),
 *   - the ORACLE cascade (escalate iff the cheap tier is wrong) — the frontier
 *     ceiling that needs no escalation signal,
 *   - the oracle pre-check inequality `cost(C) < p_C · cost(E)` on an HONEST
 *     compute axis (fresh tokens, cache-reads excluded — docs/58 F2 / docs/50 §8.1).
 *
 * If the inequality fails, the pair cannot support frontier expansion — stop
 * before spending on signals, τ-sweeps, or seeds. Phase 0 (docs/58 §3) used this
 * to diagnose both haiku↔gpt-5.5 and Nova-Pro↔gpt-5.5 as structurally dead from
 * two mono runs each.
 *
 * No new compute. Pure functions + a CLI `main`. Run:
 *   tsx eval/analysis/offline-frontier.ts [cacheDir] [largeModelId]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The subset of a swarmkit-eval cell this analyzer reads. */
interface Cell {
  readonly score?: { readonly full?: boolean; readonly earned?: number; readonly total?: number };
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly totalTokens?: number;
  };
  readonly metadata?: { readonly cascade?: { readonly perModel?: Record<string, unknown> } };
}

/** `cascade__<instance>__<arm>__cascade__seed<N>@<hash>.json` (instance contains `__`). */
const CELL_RE = /^cascade__(.+)__(mono-small|mono-large)__cascade__seed(\d+)@[0-9a-f]+\.json$/;

export const DEFAULT_LARGE = "azureoai/gpt-5.5";

/** Checkpoint score → binary correct label. */
export function isCorrect(c: Cell): boolean {
  const s = c.score;
  if (!s) return false;
  if (s.full === true) return true;
  return (s.total ?? 0) > 0 && (s.earned ?? 0) >= (s.total ?? 0);
}

/** Honest compute proxy: in + out + cache-WRITE, excluding cheap cache-READS (docs/58 F2). */
export function freshTokens(c: Cell): number {
  const u = c.usage ?? {};
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}
export function totalTokens(c: Cell): number {
  return c.usage?.totalTokens ?? 0;
}

/** The tier model a mono cell ran — read from `metadata.cascade.perModel` (falls back to arm). */
export function modelOf(c: Cell, arm: string): string {
  const keys = Object.keys(c.metadata?.cascade?.perModel ?? {});
  return keys[0] ?? (arm === "mono-large" ? DEFAULT_LARGE : "unknown");
}

export interface ModelStat {
  readonly p: number; // P(correct) over seeds
  readonly fresh: number; // mean fresh tokens
  readonly total: number; // mean total tokens
  readonly n: number; // seeds observed
}

interface AxisResult {
  readonly small: number;
  readonly large: number;
  readonly oracle: number;
  /** cheap-cost < p_small · large-cost (the docs/58 pre-check) */
  readonly savingsPossible: boolean;
  /** oracle Pareto-dominates mono-large (Q_oracle ≥ Q_large ∧ C_oracle < C_large) */
  readonly oracleDominates: boolean;
}

export interface PairResult {
  readonly small: string;
  readonly large: string;
  readonly n: number;
  readonly structure: { both: number; smallOnly: number; largeOnly: number; neither: number };
  readonly quality: { small: number; large: number; oracle: number };
  readonly axes: { fresh: AxisResult; total: AxisResult };
}

/**
 * Reconstruct the oracle-cascade frontier for one (small, large) pair from
 * per-instance aggregated stats. Pure — the unit under test.
 */
export function reconstructPair(
  small: string,
  large: string,
  smallStats: ReadonlyMap<string, ModelStat>,
  largeStats: ReadonlyMap<string, ModelStat>,
): PairResult | undefined {
  const insts = [...smallStats.keys()].filter((i) => largeStats.has(i));
  if (insts.length === 0) return undefined;

  const structure = { both: 0, smallOnly: 0, largeOnly: 0, neither: 0 };
  let qS = 0;
  let qL = 0;
  let qOracle = 0;
  const cost = { fresh: { s: 0, l: 0, o: 0 }, total: { s: 0, l: 0, o: 0 } };

  for (const i of insts) {
    const s = smallStats.get(i)!;
    const l = largeStats.get(i)!;
    qS += s.p;
    qL += l.p;
    // oracle: accept the cheap tier when correct, else escalate → union coverage
    qOracle += s.p + (1 - s.p) * l.p;
    for (const axis of ["fresh", "total"] as const) {
      const sc = axis === "fresh" ? s.fresh : s.total;
      const lc = axis === "fresh" ? l.fresh : l.total;
      cost[axis].s += sc;
      cost[axis].l += lc;
      cost[axis].o += sc + (1 - s.p) * lc; // always pay C; pay E on the escalated fraction
    }
    const sPass = s.p >= 0.5;
    const lPass = l.p >= 0.5;
    if (sPass && lPass) structure.both++;
    else if (sPass) structure.smallOnly++;
    else if (lPass) structure.largeOnly++;
    else structure.neither++;
  }

  const N = insts.length;
  const mkAxis = (a: "fresh" | "total"): AxisResult => {
    const smallC = cost[a].s / N;
    const largeC = cost[a].l / N;
    const oracleC = cost[a].o / N;
    return {
      small: smallC,
      large: largeC,
      oracle: oracleC,
      savingsPossible: smallC < (qS / N) * largeC,
      oracleDominates: qOracle / N >= qL / N - 1e-9 && oracleC < largeC,
    };
  };

  return {
    small,
    large,
    n: N,
    structure,
    quality: { small: qS / N, large: qL / N, oracle: qOracle / N },
    axes: { fresh: mkAxis("fresh"), total: mkAxis("total") },
  };
}

/** Read the cache dir and build per-(model, instance) aggregated stats. */
export function loadMonoStats(cacheDir: string): Map<string, Map<string, ModelStat>> {
  // model -> instance -> running sums
  const acc = new Map<string, Map<string, { n: number; nc: number; fresh: number; total: number }>>();
  for (const f of readdirSync(cacheDir)) {
    if (!f.endsWith(".json")) continue;
    const m = CELL_RE.exec(f);
    if (!m) continue;
    const [, inst, arm] = m;
    let cell: Cell;
    try {
      cell = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as Cell;
    } catch {
      continue;
    }
    const model = modelOf(cell, arm);
    if (model === "unknown") continue;
    const byInst = acc.get(model) ?? new Map();
    acc.set(model, byInst);
    const r = byInst.get(inst) ?? { n: 0, nc: 0, fresh: 0, total: 0 };
    r.n++;
    r.nc += isCorrect(cell) ? 1 : 0;
    r.fresh += freshTokens(cell);
    r.total += totalTokens(cell);
    byInst.set(inst, r);
  }
  const out = new Map<string, Map<string, ModelStat>>();
  for (const [model, byInst] of acc) {
    const stats = new Map<string, ModelStat>();
    for (const [inst, r] of byInst) {
      stats.set(inst, { p: r.nc / r.n, fresh: r.fresh / r.n, total: r.total / r.n, n: r.n });
    }
    out.set(model, stats);
  }
  return out;
}

const M = (t: number): string => (t / 1e6).toFixed(2) + "M";

export function renderPair(r: PairResult): string {
  const lines: string[] = [];
  const short = (m: string): string => m.split("/").pop() ?? m;
  lines.push(`\n### ${short(r.small)}  vs  ${short(r.large)}   (N=${r.n} matched instances)`);
  const st = r.structure;
  lines.push(
    `  structure (p≥0.5): both-solve=${st.both}  small-only=${st.smallOnly}  large-only=${st.largeOnly}  neither=${st.neither}`,
  );
  lines.push(
    `  quality: mono-small ${r.quality.small.toFixed(3)} | mono-large ${r.quality.large.toFixed(3)} | oracle-cascade ${r.quality.oracle.toFixed(3)}`,
  );
  for (const axis of ["fresh", "total"] as const) {
    const a = r.axes[axis];
    const label = axis === "fresh" ? "fresh in+out+cacheWrite (honest compute)" : "totalTokens (incl cache-read)";
    lines.push(`  [${label}]`);
    lines.push(`     mono-small ${M(a.small)} | mono-large ${M(a.large)} | oracle-cascade ${M(a.oracle)}`);
    lines.push(
      `     pre-check cost(C) < p_C·cost(E): ${a.savingsPossible ? "PASS" : "FAIL"}  ⇒  oracle dominates mono-large? ${a.oracleDominates ? "YES" : "NO"}`,
    );
  }
  // Verdict off the honest axis.
  lines.push(
    `  ⇒ verdict (fresh-compute): ${r.axes.fresh.oracleDominates ? "pair CAN support expansion" : "STRUCTURALLY DEAD — do not run a live cascade on this pair"}`,
  );
  return lines.join("\n");
}

export function main(argv: readonly string[]): number {
  const cacheDir = argv[0] ?? ".eval-runs/cache";
  const large = argv[1] ?? DEFAULT_LARGE;
  let stats: Map<string, Map<string, ModelStat>>;
  try {
    stats = loadMonoStats(cacheDir);
  } catch (e) {
    process.stderr.write(`offline-frontier: cannot read ${cacheDir}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const largeStats = stats.get(large);
  if (!largeStats) {
    process.stderr.write(
      `offline-frontier: no mono-large cells for "${large}". Models present: ${[...stats.keys()].join(", ") || "(none)"}\n`,
    );
    return 2;
  }
  const smalls = [...stats.keys()].filter((m) => m !== large);
  process.stdout.write(`offline-frontier — ${cacheDir}  (large tier: ${large})\n`);
  if (smalls.length === 0) {
    process.stdout.write("  no small-tier models to pair.\n");
    return 0;
  }
  for (const s of smalls) {
    const r = reconstructPair(s, large, stats.get(s)!, largeStats);
    if (r) process.stdout.write(renderPair(r) + "\n");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
