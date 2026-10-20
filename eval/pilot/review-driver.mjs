/**
 * One review of a fixed tree, in a task container (eval/pilot/reviewer-bench.py, docs/07 §7.10).
 *
 *   node review-driver.mjs <harness flags> "<roadmap>"
 *
 * /app holds the tree under review. BENCH_BRIEF picks the brief: `product` (the
 * product gate's L1 brief, from the built openswarm), `pilot` (gate.mjs's), or a
 * file. The verdict goes to BENCH_OUT, its usage with it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { REVIEW, review } from "./gate.mjs";

const name = process.env.BENCH_BRIEF ?? "product";
const brief =
  name === "product"
    ? (await import("/opt/openswarm/packages/swarm/dist/index.js")).REVIEW_BRIEF
    : name === "pilot"
      ? REVIEW
      : readFileSync(name, "utf8");
if (typeof brief !== "string" || brief === "") throw new Error(`no review brief for ${name}`);
const verdict = await review(process.env.BENCH_APP ?? "/app", process.argv.at(-1), undefined, brief);
writeFileSync(process.env.BENCH_OUT ?? "/out/verdict.json", JSON.stringify(verdict));
process.exit(0);
