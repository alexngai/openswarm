/**
 * compare-traces.ts — diagnose WHY the team fails where single succeeds, on the SAME task.
 * Finds the single trajectory that SOLVED an instance and a team trajectory that FAILED it, flattens
 * both, and asks an LLM to pinpoint what the team did differently. Run under node:
 *   source ~/.zshrc && MAST_JUDGE=azure AZURE_DEPLOYMENT=gpt-4.1 tsx eval/experiments/compare-traces.ts
 * Env: CMP_INSTANCE (default xarray-3993), CMP_MODEL (default gpt-5.5).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import * as path from "node:path";
import { azureLlm } from "../mast/azure-llm.js";
import { bedrockLlm } from "../mast/bedrock-llm.js";

const CACHE = ".eval-runs/cache";
const INSTANCES = process.env.SWE_INSTANCES_DIR ?? "eval/.artifacts/swe-hard";
const INSTANCE = process.env.CMP_INSTANCE ?? "xarray-3993";
const MODEL = process.env.CMP_MODEL ?? "gpt-5.5";

type Cell = { armId?: string; taskId?: string; model?: string; durationMs?: number; score?: { full?: boolean }; file: string };

function loadCells(): Cell[] {
  const out: Cell[] = [];
  for (const f of readdirSync(CACHE)) {
    if (!f.endsWith(".json") || f.endsWith(".trace.jsonl")) continue;
    if (!f.includes(INSTANCE) || !f.includes(MODEL)) continue;
    try {
      const d = JSON.parse(readFileSync(path.join(CACHE, f), "utf8"));
      out.push({ ...d, file: f });
    } catch {
      /* skip */
    }
  }
  return out;
}

function flatten(traceFile: string): string {
  const raw = readFileSync(path.join(CACHE, traceFile), "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(s); } catch { continue; }
    if (e.cellKey !== undefined || e.runId !== undefined) continue;
    const who = String(e.from ?? e.agentId ?? e.model ?? "?").slice(0, 8);
    if (e.type === "tool") out.push(`[${who}] TOOL ${String(e.name)}${e.isError ? " ERR" : ""}: ${JSON.stringify(e.input ?? "").slice(0, 200)}`);
    else if (e.type === "message") out.push(`[${who}] MSG: ${String(e.content ?? "").slice(0, 600)}`);
  }
  return out.join("\n").slice(0, 24000); // bound transcript size
}

function problem(taskId: string): string {
  const f = path.join(INSTANCES, `${taskId}.json`);
  if (!existsSync(f)) return taskId;
  return (JSON.parse(readFileSync(f, "utf8")).problem_statement ?? taskId).slice(0, 3000);
}

const cells = loadCells();
const single = cells.find((c) => c.armId === "single" && c.score?.full);
// failed team with the LONGEST run = the verified one (grinds, doesn't quit early)
const teamCells = cells.filter((c) => c.armId === "team" && !c.score?.full).sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
const team = teamCells[0];
if (!single || !team) {
  console.error(`[cmp] need a solved single + a failed team for ${INSTANCE}/${MODEL}. single=${!!single} team=${!!team}`);
  process.exit(1);
}
console.error(`[cmp] single SOLVED (${Math.round((single.durationMs ?? 0) / 1000)}s) vs team FAILED (${Math.round((team.durationMs ?? 0) / 1000)}s) on ${single.taskId}`);

const singleT = flatten(single.file.replace(/\.json$/, ".trace.jsonl"));
const teamT = flatten(team.file.replace(/\.json$/, ".trace.jsonl"));

const llm = process.env.MAST_JUDGE === "azure" ? azureLlm({ maxTokens: 2000 }) : bedrockLlm({ maxTokens: 2000 });
const system =
  "You are an expert analyst of agentic coding systems. You compare two trajectories on the SAME software task: " +
  "a SINGLE agent that SUCCEEDED and a multi-agent TEAM (architect + spawned teammates) that FAILED. Identify, " +
  "with concrete evidence from the transcripts, the SPECIFIC differences in approach/coordination that caused the " +
  "team to fail where the single agent succeeded. Be concrete and mechanistic, not generic.";
const prompt =
  `# Task\n${problem(single.taskId!)}\n\n` +
  `# Trajectory A — SINGLE agent (SUCCEEDED)\n${singleT}\n\n` +
  `# Trajectory B — coordinator TEAM (FAILED, ran longer, did NOT quit early)\n${teamT}\n\n` +
  `# Your analysis\n` +
  `Answer concisely:\n` +
  `1. What did the SINGLE agent do to solve it (the key moves)?\n` +
  `2. What did the TEAM do differently — where did its effort go, and what went wrong (delegation, context loss, ` +
  `duplicated/conflicting work, shallow verification, wrong focus)?\n` +
  `3. The single ROOT-CAUSE difference that explains the team's failure.`;

const out = await llm({ system, prompt });
console.log(`\n===== WHY THE TEAM FAILED (${single.taskId}, ${MODEL}) =====\n`);
console.log(out);
