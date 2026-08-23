/**
 * router-frontier.ts — N-way complementary-specialist router over the flat Row schema
 * (docs/64 H3). Tests whether a DIVERSE swarm, routed per-task to the best-suited member,
 * beats the best single model on accuracy (union coverage) and/or a big baseline on
 * compute — i.e. whether diversity (not just cost-tiering) helps.
 *
 * Key metric: complementarity index κ = (tasks solved by EXACTLY ONE swarm member) /
 * (tasks solved by ≥1 member). κ≈0 ⇒ members solve the same tasks ⇒ routing can't raise
 * accuracy (docs/64 §2). Compute is the honest FLOPs axis (2·N·tokens), reusing
 * humaneval-frontier's attemptFlops.
 *
 * Run: tsx eval/analysis/router-frontier.ts rows.jsonl --swarm m1,m2,m3 [--baseline mB]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attemptFlops, type Row } from "./humaneval-frontier.js";

/** A row may carry an `arm` tag (docs/64 H4 loadouts of one model). */
type RouterRow = Row & { arm?: string };
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Agg { p: number; flops: number; n: number }
/** Per (member, task): mean correctness + mean FLOPs over seeds. `member` = model, or the
 *  loadout arm when byArm — FLOPs always come from the real model (attemptFlops). */
function aggregate(rows: RouterRow[], byArm: boolean): Map<string, Map<string, Agg>> {
  const key = (r: RouterRow) => (byArm ? r.arm ?? r.model : r.model);
  const acc = new Map<string, Map<string, { nc: number; n: number; flops: number }>>();
  for (const r of rows) {
    const bt = acc.get(key(r)) ?? new Map();
    acc.set(key(r), bt);
    const a = bt.get(r.task_id) ?? { nc: 0, n: 0, flops: 0 };
    a.nc += r.correct; a.n += 1; a.flops += attemptFlops(r);
    bt.set(r.task_id, a);
  }
  const out = new Map<string, Map<string, Agg>>();
  for (const [model, bt] of acc) {
    const m = new Map<string, Agg>();
    for (const [t, a] of bt) m.set(t, { p: a.nc / a.n, flops: a.flops / a.n, n: a.n });
    out.set(model, m);
  }
  return out;
}

const fmtF = (f: number): string => `${(f / 1e9).toFixed(0)}G`;

export interface RouterReport {
  swarm: string[]; baseline?: string;
  nTasks: number;
  perModel: { model: string; resolve: number; flops: number }[];
  kappa: number;
  uniqueBy: Record<string, number>; // tasks each member uniquely solves
  oracle: { quality: number; flops: number }; // route to cheapest swarm solver; union coverage
  bestSingle: { model: string; resolve: number };
  diversityGain: number; // oracle.quality − best single swarm resolve
  baselineStat?: { resolve: number; flops: number };
}

export function analyzeRouter(rows: RouterRow[], swarm: string[], baseline?: string, byArm = false): RouterReport {
  const agg = aggregate(rows, byArm);
  for (const m of [...swarm, ...(baseline ? [baseline] : [])]) {
    if (!agg.has(m)) throw new Error(`no rows for model "${m}" (have: ${[...agg.keys()].join(", ")})`);
  }
  // tasks attempted by every swarm member (fair pairing)
  const tasks = [...agg.get(swarm[0]!)!.keys()].filter((t) => swarm.every((m) => agg.get(m)!.has(t)));
  const solves = (m: string, t: string) => (agg.get(m)!.get(t)?.p ?? 0) >= 0.5;

  const perModel = swarm.map((m) => ({
    model: m,
    resolve: mean(tasks.map((t) => (solves(m, t) ? 1 : 0))),
    flops: mean(tasks.map((t) => agg.get(m)!.get(t)!.flops)),
  }));

  // complementarity: per task, how many swarm members solve it
  const uniqueBy: Record<string, number> = Object.fromEntries(swarm.map((m) => [m, 0]));
  let solvedByOne = 0, solvedByAny = 0;
  let oracleQ = 0, oracleF = 0;
  for (const t of tasks) {
    const solvers = swarm.filter((m) => solves(m, t));
    if (solvers.length >= 1) solvedByAny++;
    if (solvers.length === 1) { solvedByOne++; uniqueBy[solvers[0]!]!++; }
    // oracle router: if any member solves, route to the cheapest solver (quality 1);
    // else route to the cheapest member overall (quality 0, still pay an attempt).
    oracleQ += solvers.length >= 1 ? 1 : 0;
    const routeSet = solvers.length >= 1 ? solvers : swarm;
    oracleF += Math.min(...routeSet.map((m) => agg.get(m)!.get(t)!.flops));
  }
  const kappa = solvedByAny ? solvedByOne / solvedByAny : 0;
  const bestSingle = perModel.reduce((a, b) => (b.resolve > a.resolve ? b : a));

  const report: RouterReport = {
    swarm, baseline, nTasks: tasks.length, perModel, kappa, uniqueBy,
    oracle: { quality: oracleQ / tasks.length, flops: oracleF / tasks.length },
    bestSingle: { model: bestSingle.model, resolve: bestSingle.resolve },
    diversityGain: oracleQ / tasks.length - bestSingle.resolve,
  };
  if (baseline) {
    report.baselineStat = {
      resolve: mean(tasks.map((t) => (solves(baseline, t) ? 1 : 0))),
      flops: mean(tasks.map((t) => agg.get(baseline)!.get(t)!.flops)),
    };
  }
  return report;
}

export function printRouter(r: RouterReport): void {
  const p = (x: number) => x.toFixed(3);
  const short = (m: string) => m.split("/").pop()!.replace(/-v1:0$|-instruct.*$/, "");
  console.log(`\n=== router frontier: ${r.swarm.length}-model swarm${r.baseline ? ` vs ${short(r.baseline)}` : ""} (${r.nTasks} tasks) ===`);
  console.log(`\n  member                         resolve   FLOPs/task   unique-solves`);
  for (const m of r.perModel) console.log(`  ${short(m.model).padEnd(28)}   ${p(m.resolve)}    ${fmtF(m.flops).padStart(8)}    ${r.uniqueBy[m.model]}`);
  console.log(`\ncomplementarity κ = ${p(r.kappa)}  (share of solved tasks owned by exactly one member; κ≈0 ⇒ diversity illusory)`);
  console.log(`\nORACLE ROUTER (swarm): quality ${p(r.oracle.quality)} @ ${fmtF(r.oracle.flops)}/task`);
  console.log(`  best single member:  ${p(r.bestSingle.resolve)} (${short(r.bestSingle.model)})`);
  console.log(`  DIVERSITY GAIN Δacc = ${p(r.diversityGain)}  ${r.diversityGain > 0.01 ? "→ routing beats the best single member" : "→ no accuracy gain from diversity"}`);
  if (r.baselineStat) {
    const b = r.baselineStat;
    const acc = r.oracle.quality >= b.resolve - 1e-9;
    const cheaper = r.oracle.flops < b.flops;
    console.log(`\nvs BASELINE ${short(r.baseline!)}: resolve ${p(b.resolve)} @ ${fmtF(b.flops)}/task`);
    console.log(`  swarm oracle-router ${acc ? "≥" : "<"} baseline accuracy (${p(r.oracle.quality)} vs ${p(b.resolve)}) and ${cheaper ? `${(b.flops / r.oracle.flops).toFixed(1)}× CHEAPER` : "NOT cheaper"} on FLOPs`);
    console.log(`  → H3 efficiency ${acc && cheaper ? "SUPPORTED (matches/beats the monolith at lower compute)" : "not shown on this slice"}`);
  }
  console.log("");
}

function main(argv: string[]): number {
  const path = argv[0]!;
  const swarmArg = argv[argv.indexOf("--swarm") + 1];
  const baseArg = argv.includes("--baseline") ? argv[argv.indexOf("--baseline") + 1] : undefined;
  const byArm = argv.includes("--by") && argv[argv.indexOf("--by") + 1] === "arm";
  if (!path || !swarmArg) { console.error("usage: router-frontier.ts rows.jsonl --swarm m1,m2,m3 [--baseline mB] [--by arm]"); return 1; }
  const rows: RouterRow[] = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  printRouter(analyzeRouter(rows, swarmArg.split(","), baseArg, byArm));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
