/**
 * swe-cells-to-rows.ts — convert swarmkit-eval SWE mono cells (.eval-runs/cache) into
 * the flat single-shot Row schema that `humaneval-frontier.ts` consumes, so the agentic
 * SWE offline frontier (docs/62 Phase 2) can be analyzed on the HONEST FLOPs axis
 * (active-params × fresh tokens) — the axis `offline-frontier.ts` lacks (it is token-only,
 * which understates a small tier whose FLOPs/token is far lower).
 *
 * One row per (instance, model, seed). Fresh tokens (in + out + cacheWrite, cache-reads
 * excluded — docs/62 F2) are folded into `tok_out` so humaneval-frontier's FLOPs
 * (2·N·(tok_in+tok_out)) becomes 2·N·fresh. No escalation signal for SWE mono cells
 * (sig_visible = null; the offline oracle frontier needs none).
 *
 * Run (on the box, after a cascade-swe mono run):
 *   tsx eval/analysis/swe-cells-to-rows.ts [cacheDir] > swe-rows.jsonl
 *   tsx eval/analysis/humaneval-frontier.ts swe-rows.jsonl <smallModel> <largeModel>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isCorrect, freshTokens, modelOf } from "./offline-frontier.js";

/** `cascade__<instance>__<arm>__cascade__seed<N>@<hash>.json` (instance may contain `__`).
 *  Matches any `mono-<name>` arm, incl. docs/64 H4 loadout arms (mono-direct/repro/…). */
const CELL_RE = /^cascade__(.+)__(mono-[a-z0-9-]+)__cascade__seed(\d+)@[0-9a-f]+\.json$/;

function main(argv: string[]): number {
  const dir = argv[0] ?? ".eval-runs/cache";
  let n = 0;
  for (const f of readdirSync(dir)) {
    const m = CELL_RE.exec(f);
    if (!m) continue; // skips .trace.jsonl and non-mono arms
    const [, inst, arm, seed] = m;
    let cell: Parameters<typeof isCorrect>[0];
    try {
      cell = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    const model = modelOf(cell, arm!);
    if (model === "unknown") continue;
    const fresh = freshTokens(cell);
    // Deployable escalation signal (docs/62 §5.2): the compile/authored-repro confidence
    // logged by CS_SIGNAL=1 runs. null when the cell predates the signal instrumentation.
    const conf = (cell as { metadata?: { cascade?: { confidence?: number } } }).metadata?.cascade?.confidence;
    process.stdout.write(
      JSON.stringify({
        task_id: inst,
        model,
        arm, // docs/64 H4: distinguishes loadouts (mono-direct/repro/…) of the same model
        seed: Number(seed),
        correct: isCorrect(cell) ? 1 : 0,
        sig_visible: typeof conf === "number" ? conf : null,
        tok_in: 0,
        tok_out: fresh,
        tok_total: fresh,
      }) + "\n",
    );
    n++;
  }
  process.stderr.write(`[swe-cells-to-rows] emitted ${n} rows from ${dir}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
