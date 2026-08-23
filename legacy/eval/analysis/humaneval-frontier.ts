/**
 * humaneval-frontier.ts — the oracle-cascade pre-check + offline frontier over the
 * flat single-shot rows emitted by `eval/experiments/humaneval-signal.ts` (docs/62).
 *
 * `offline-frontier.ts` reads the swarmkit-eval SWE `.eval-runs/cache/` cells; this
 * is its sibling for the HumanEval/MBPP `rows.jsonl` schema (one row per
 * `(task_id, model, seed)`). It computes, for a (small C, large E) model pair:
 *   - per-model resolve + honest compute (FLOPs = 2·N·(in+out), N = active params);
 *   - task structure (both-solve / small-only / large-only / neither);
 *   - the ORACLE cascade (escalate iff the cheap sample is wrong) — the ceiling that
 *     needs no signal — and whether it Pareto-dominates mono-large;
 *   - the oracle pre-check inequality `cost(C) < resolve_C · cost(E)` on the FLOPs
 *     axis (docs/62 §2/§7): the always-paid cheap cost must be less than the
 *     expected large-tier cost that accepting C's correct answers saves. If it
 *     fails, the pair can't expand the frontier — stop before signals/τ-sweeps/seeds;
 *   - the escalation-signal AUC (sig_visible on C) and a real-signal τ-sweep
 *     (null signal ⇒ escalate, the conservative default).
 *
 * The docs/62 F7 Phase-1 analysis was done in an ephemeral scratchpad script that did
 * not survive; this makes Phase 1.5 (and every later pair) reproducible from disk.
 *
 * No new compute. Run:
 *   tsx eval/analysis/humaneval-frontier.ts [rows.jsonl] [smallModelId] [largeModelId]
 * Models auto-detect by active-params (fewer ⇒ C) when not given.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MODEL_ACTIVE_PARAMS_B,
  normalizeModelId,
  estimateForwardFlops,
} from "../../src/core/cost-model.js";

/** One row as written by humaneval-signal.ts. */
export interface Row {
  task_id: string;
  model: string;
  seed: number;
  correct: 0 | 1;
  sig_visible: number | null;
  tok_in: number;
  tok_out: number;
  tok_total?: number;
  err?: string;
}

/** FLOPs for one attempt; throws (loudly) if the model's params aren't registered —
 * an unregistered model would silently blank the honest axis (the docs/62 blocker). */
export function attemptFlops(row: Row): number {
  const params = MODEL_ACTIVE_PARAMS_B[normalizeModelId(row.model)];
  const f = estimateForwardFlops({ model: row.model, inputTokens: row.tok_in, outputTokens: row.tok_out }, params);
  if (f === undefined) {
    throw new Error(
      `no active-params for "${row.model}" (normalized "${normalizeModelId(row.model)}") — ` +
        `add it to MODEL_ACTIVE_PARAMS_B in src/core/cost-model.ts before analyzing the FLOPs frontier.`,
    );
  }
  return f;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Rank-based AUC (Mann-Whitney): P(score higher on a positive than a negative), ties=0.5. */
export function auc(scores: number[], labels: number[]): number | null {
  const pos: number[] = [], neg: number[] = [];
  for (let i = 0; i < scores.length; i++) (labels[i] ? pos : neg).push(scores[i]!);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** Aggregate a model's rows per task: seed-mean correctness and seed-mean FLOPs. */
interface TaskAgg {
  pCorrect: number; // mean correct over seeds ∈ [0,1]
  flops: number; // mean FLOPs over seeds
  freshTok: number; // mean (in+out) over seeds
  sig: number | null; // mean sig over seeds with a signal (null if none)
}
function aggByTask(rows: Row[]): Map<string, TaskAgg> {
  const bySeed = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.task_id;
    (bySeed.get(k) ?? bySeed.set(k, []).get(k)!).push(r);
  }
  const out = new Map<string, TaskAgg>();
  for (const [task, rs] of bySeed) {
    const sigs = rs.map((r) => r.sig_visible).filter((s): s is number => s !== null);
    out.set(task, {
      pCorrect: mean(rs.map((r) => r.correct)),
      flops: mean(rs.map(attemptFlops)),
      freshTok: mean(rs.map((r) => r.tok_in + r.tok_out)),
      sig: sigs.length ? mean(sigs) : null,
    });
  }
  return out;
}

export interface PairReport {
  small: string; large: string;
  nTasks: number;
  resolveC: number; resolveE: number;
  flopsC: number; flopsE: number; // mean per task
  freshTokC: number; freshTokE: number;
  structure: { both: number; smallOnly: number; largeOnly: number; neither: number };
  oracle: { quality: number; flops: number };
  monoLargePareto: boolean; // oracle dominates mono-large (quality ≥ Q_E & FLOPs < FLOPs_E)
  precheck: { lhs: number; rhs: number; pass: boolean }; // cost(C) < resolveC·cost(E), FLOPs
  sigAuc: number | null; sigCoverage: number;
  tauSweep: { tau: number; quality: number; flops: number; escalateRate: number }[];
}

export function analyzePair(all: Row[], smallId: string, largeId: string): PairReport {
  const C = aggByTask(all.filter((r) => r.model === smallId));
  const E = aggByTask(all.filter((r) => r.model === largeId));
  const tasks = [...C.keys()].filter((t) => E.has(t));

  const resolveC = mean(tasks.map((t) => C.get(t)!.pCorrect));
  const resolveE = mean(tasks.map((t) => E.get(t)!.pCorrect));
  const flopsC = mean(tasks.map((t) => C.get(t)!.flops));
  const flopsE = mean(tasks.map((t) => E.get(t)!.flops));

  const structure = { both: 0, smallOnly: 0, largeOnly: 0, neither: 0 };
  for (const t of tasks) {
    const c = C.get(t)!.pCorrect >= 0.5, e = E.get(t)!.pCorrect >= 0.5;
    if (c && e) structure.both++;
    else if (c) structure.smallOnly++;
    else if (e) structure.largeOnly++;
    else structure.neither++;
  }

  // Oracle: on each task, escalate iff C wrong. Expected over seeds: accept-C with
  // prob pC (quality 1 on the accepted correct sample, cost = flopsC), else pay E too.
  let oQ = 0, oF = 0;
  for (const t of tasks) {
    const c = C.get(t)!, e = E.get(t)!;
    oQ += c.pCorrect * 1 + (1 - c.pCorrect) * e.pCorrect;
    oF += c.flops + (1 - c.pCorrect) * e.flops;
  }
  const oracle = { quality: oQ / tasks.length, flops: oF / tasks.length };
  const monoLargePareto = oracle.quality >= resolveE - 1e-9 && oracle.flops < flopsE;

  // Pre-check on the FLOPs axis: cost(C) < resolveC · cost(E).
  const precheck = { lhs: flopsC, rhs: resolveC * flopsE, pass: flopsC < resolveC * flopsE };

  // Signal quality on C (per-attempt, only rows with a signal).
  const cRows = all.filter((r) => r.model === smallId && r.sig_visible !== null);
  const sigAuc = auc(cRows.map((r) => r.sig_visible!), cRows.map((r) => r.correct));
  const sigCoverage = cRows.length;

  // Real-signal τ-sweep: accept C iff sig ≥ τ; null signal ⇒ escalate (conservative).
  const tauSweep = [0, 0.25, 0.5, 0.75, 1.0].map((tau) => {
    let q = 0, f = 0, esc = 0;
    for (const t of tasks) {
      const c = C.get(t)!, e = E.get(t)!;
      const accept = c.sig !== null && c.sig >= tau;
      if (accept) { q += c.pCorrect; f += c.flops; }
      else { q += c.pCorrect * 1 + (1 - c.pCorrect) * e.pCorrect; f += c.flops + (1 - c.pCorrect) * e.flops; esc++; }
    }
    return { tau, quality: q / tasks.length, flops: f / tasks.length, escalateRate: esc / tasks.length };
  });

  return {
    small: smallId, large: largeId, nTasks: tasks.length,
    resolveC, resolveE, flopsC, flopsE,
    freshTokC: mean(tasks.map((t) => C.get(t)!.freshTok)),
    freshTokE: mean(tasks.map((t) => E.get(t)!.freshTok)),
    structure, oracle, monoLargePareto, precheck, sigAuc, sigCoverage, tauSweep,
  };
}

function fmtFlops(f: number): string {
  return `${(f / 1e9).toFixed(1)}G`; // report in GFLOPs (2·Nb·tok has 1e9 baked into N·1e9)
}

export function printReport(r: PairReport): void {
  const p = (x: number) => x.toFixed(3);
  console.log(`\n=== HumanEval offline frontier: ${r.small.split("/").pop()} (C) vs ${r.large.split("/").pop()} (E) ===`);
  console.log(`tasks paired: ${r.nTasks}`);
  console.log(`\n            resolve   mean FLOPs/task   mean fresh tok/task`);
  console.log(`  mono-C    ${p(r.resolveC)}     ${fmtFlops(r.flopsC).padStart(9)}        ${r.freshTokC.toFixed(0)}`);
  console.log(`  mono-E    ${p(r.resolveE)}     ${fmtFlops(r.flopsE).padStart(9)}        ${r.freshTokE.toFixed(0)}`);
  console.log(`  oracle    ${p(r.oracle.quality)}     ${fmtFlops(r.oracle.flops).padStart(9)}`);
  const s = r.structure;
  console.log(`\nstructure: both=${s.both} small-only=${s.smallOnly} large-only=${s.largeOnly} neither=${s.neither}`);
  console.log(`\nORACLE PRE-CHECK (FLOPs):  cost(C) < resolve_C · cost(E)`);
  console.log(`  ${fmtFlops(r.precheck.lhs)}  <  ${p(r.resolveC)} · ${fmtFlops(r.flopsE)} = ${fmtFlops(r.precheck.rhs)}   → ${r.precheck.pass ? "PASS ✓ (pair can expand the frontier)" : "FAIL ✗ (structurally dead — stop)"}`);
  console.log(`oracle Pareto-dominates mono-large: ${r.monoLargePareto ? "YES" : "no"} (q ${p(r.oracle.quality)} ≥ ${p(r.resolveE)} & FLOPs ${fmtFlops(r.oracle.flops)} < ${fmtFlops(r.flopsE)})`);
  console.log(`\nescalation signal (sig_visible on C): AUC ${r.sigAuc === null ? "n/a" : p(r.sigAuc)} over ${r.sigCoverage} attempts`);
  console.log(`\nreal-signal τ-sweep (null sig ⇒ escalate):`);
  console.log(`   τ      quality   FLOPs/task   escalate%`);
  for (const t of r.tauSweep) {
    console.log(`  ${t.tau.toFixed(2)}    ${p(t.quality)}     ${fmtFlops(t.flops).padStart(9)}    ${(t.escalateRate * 100).toFixed(0)}%`);
  }
  console.log("");
}

function main(argv: string[]): number {
  const path = argv[0] ?? "eval/.artifacts/humaneval/rows.jsonl";
  const rows: Row[] = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const models = [...new Set(rows.map((r) => r.model))];
  let small = argv[1], large = argv[2];
  if (!small || !large) {
    if (models.length !== 2) {
      console.error(`rows have ${models.length} models (${models.join(", ")}); pass smallId largeId explicitly.`);
      return 1;
    }
    const withParams = models
      .map((m) => ({ m, p: MODEL_ACTIVE_PARAMS_B[normalizeModelId(m)] }))
      .sort((a, b) => (a.p ?? Infinity) - (b.p ?? Infinity));
    small = withParams[0]!.m; large = withParams[1]!.m;
  }
  printReport(analyzePair(rows, small, large));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
