/**
 * mast-analysis.ts — run the MAST 14-mode judge over cached eval cells that have RICH traces, to
 * categorize WHY each arm fails (FC1 spec/design, FC2 inter-agent, FC3 verification). Turns the bare
 * "all arms = 11%" resolve rate into a failure-mode mechanism.
 *
 * Single-agent traces are already rich (2–5 KB); team/hetero traces are rich only after the
 * --trace-output capture fix (and a re-run to regenerate them). Thin traces are skipped.
 *
 * Run under NODE: `source ~/.zshrc && tsx eval/experiments/mast-analysis.ts`
 * Env: MAST_ARMS (csv filter, e.g. "single,team"), MAST_MIN_TRACE_BYTES (default 1500),
 *      SWE_INSTANCES_DIR (default eval/.artifacts/swe-hard).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import {
  judgeTrace,
  aggregateMast,
  renderMastHistogram,
  type MastReport,
  type MastTraceInput,
} from "../mast/judge.js";
import { bedrockLlm } from "../mast/bedrock-llm.js";
import { azureLlm } from "../mast/azure-llm.js";

const CACHE = ".eval-runs/cache";
const INSTANCES = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-hard";
const MIN_BYTES = process.env.MAST_MIN_TRACE_BYTES ? Number(process.env.MAST_MIN_TRACE_BYTES) : 1500;
const ARMS = process.env.MAST_ARMS ? process.env.MAST_ARMS.split(",").map((s) => s.trim()) : null;

function problemStatement(taskId: string): string {
  const f = path.join(INSTANCES, `${taskId}.json`);
  if (!existsSync(f)) return taskId;
  const d = JSON.parse(readFileSync(f, "utf8")) as { problem_statement?: string };
  return (d.problem_statement ?? taskId).slice(0, 6000);
}

/** Flatten a stored trajectory (.trace.jsonl: header line + TraceEvent[] lines) into a readable transcript. */
function flatten(traceRaw: string): string {
  const out: string[] = [];
  for (const line of traceRaw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (e.cellKey !== undefined || e.runId !== undefined) continue; // skip the header line
    const who = String(e.from ?? e.agentId ?? e.model ?? "?").slice(0, 8);
    const type = e.type;
    if (type === "tool") {
      const io = JSON.stringify(e.input ?? e.output ?? "").slice(0, 240);
      out.push(`[${who}] TOOL ${String(e.name)}${e.isError ? " ⚠ERROR" : ""}: ${io}`);
    } else if (type === "message") {
      out.push(`[${who}] MSG: ${String(e.content ?? "").slice(0, 800)}`);
    } else if (type === "llm") {
      out.push(`[${who}] (llm turn)`);
    }
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  // MAST_JUDGE=azure uses Azure OpenAI (separate quota + cross-family judge); default Bedrock.
  const llm = process.env.MAST_JUDGE === "azure" ? azureLlm() : bedrockLlm();
  const files = readdirSync(CACHE).filter((f) => f.endsWith(".json") && !f.endsWith(".trace.jsonl"));
  const byArm: Record<string, MastReport[]> = {};
  let judged = 0;

  for (const jf of files) {
    let cell: { armId?: string; taskId?: string; score?: { full?: boolean } };
    try {
      cell = JSON.parse(readFileSync(path.join(CACHE, jf), "utf8"));
    } catch {
      continue;
    }
    if (!cell.armId || !cell.taskId) continue;
    if (ARMS && !ARMS.includes(cell.armId)) continue;
    const tpath = path.join(CACHE, jf.replace(/\.json$/, ".trace.jsonl"));
    if (!existsSync(tpath)) continue;
    const traceRaw = readFileSync(tpath, "utf8");
    if (Buffer.byteLength(traceRaw) < MIN_BYTES) continue; // skip thin (un-fixed) traces
    const transcript = flatten(traceRaw);
    if (transcript.trim().length === 0) continue;

    const outcome: "success" | "failure" = cell.score?.full ? "success" : "failure";
    const input: MastTraceInput = {
      id: `${cell.armId}/${cell.taskId}`,
      task: problemStatement(cell.taskId),
      transcript,
      outcome,
    };
    process.stderr.write(`[mast] ${input.id} (${outcome}, ${Buffer.byteLength(traceRaw)}B) ...\n`);
    try {
      const report = await judgeTrace(input, llm);
      (byArm[cell.armId] ??= []).push(report);
      judged++;
      const present = report.modes.filter((m) => m.present).map((m) => m.code);
      process.stderr.write(`  → ${present.length ? present.join(", ") : "no modes flagged"}\n`);
    } catch (e) {
      process.stderr.write(`  → judge error: ${(e as Error).message}\n`);
    }
  }

  if (judged === 0) {
    console.error(`[mast] no rich-trace cells matched (min ${MIN_BYTES}B${ARMS ? `, arms ${ARMS.join("/")}` : ""}).`);
    return;
  }
  console.log(`# MAST failure-mode analysis — ${judged} cell(s) with rich traces\n`);
  for (const arm of Object.keys(byArm)) {
    const reps = byArm[arm]!;
    console.log(`\n## ${arm} (n=${reps.length})\n`);
    console.log(renderMastHistogram(aggregateMast(reps)));
  }
}

await main();
