/**
 * In-container driver for the docs/07 §7.1 search arms; runner.mjs seeds it at
 * /opt/pilot/search.mjs and the harness calls it exactly as it calls the CLI:
 * `search.mjs <flags> "<prompt>"`.
 *
 *   PILOT_SEARCH=review  one agent, then the reviewer: the attempts behind arms (a) and (c)
 *   PILOT_SEARCH=rounds  up to PILOT_ROUNDS agent rounds; the reviewer's report on each
 *                        round opens the next (arm b, the budget-matched single agent)
 *   PILOT_SEARCH=self    the same rounds with no reviewer: each round opens with a prompt
 *                        to check the work against the roadmap itself (arm b0, the control
 *                        that separates the reviewer's feedback from the extra rounds)
 *
 * The gate and the reviewer are gate.mjs's. Reports go to
 * /verifier-out/<HOSTNAME>.search.json, beside the verifier's
 * <task>.<HOSTNAME>.reward.json, so search-report.py joins them.
 */
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { gate, task } from "./gate.mjs";

const MODE = process.env.PILOT_SEARCH;
if (!["review", "rounds", "self"].includes(MODE)) {
  console.error(`PILOT_SEARCH must be review, rounds or self (got ${MODE})`);
  process.exit(2);
}
const OUT = `${process.env.PILOT_OUT_DIR ?? "/verifier-out"}/${process.env.HOSTNAME || hostname()}.search.json`;

const state = await gate({
  cwd: process.env.PILOT_APP ?? "/app",
  prompt: task,
  roadmap: task,
  mode: MODE,
  maxRounds: Number(process.env.PILOT_ROUNDS ?? 4),
  record: (s) => writeFileSync(OUT, JSON.stringify({ mode: MODE, base: s.base, rounds: s.rounds }, null, 1)),
});
process.exit(state.code);
