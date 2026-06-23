/**
 * MAST judge — LLM-as-judge that tags a swarm-harness trace with the 14 MAST failure modes.
 *
 * The LLM call is INJECTED (`LlmComplete`) so this module is pure and unit-testable with a mock;
 * a real run wires it to the gateway/Claude. Output is a per-mode verdict; `aggregateMast` rolls
 * many reports into the per-mode / per-category histogram we compare against the paper (and across
 * arms) in docs/45 §6.
 */
import {
  MAST_MODES,
  MAST_MODE_BY_CODE,
  MAST_CATEGORIES,
  type MastCategoryId,
} from "./taxonomy.js";

/** What the judge sees for one run. `transcript` = the flattened agent/team trace (events or messages). */
export interface MastTraceInput {
  /** Stable id for the run/cell (for joining back to eval cells). */
  readonly id: string;
  /** The task the team was given. */
  readonly task: string;
  /** Flattened transcript: agent turns, tool calls, inter-agent messages, in order. */
  readonly transcript: string;
  /** Ground-truth outcome from the grader (NOT agent-asserted). Helps the judge calibrate. */
  readonly outcome: "success" | "failure";
}

export interface MastModeVerdict {
  readonly code: string;
  readonly category: MastCategoryId;
  readonly present: boolean;
  /** Short quote/paraphrase from the transcript justifying a `present: true`. Empty when absent. */
  readonly evidence: string;
}

export interface MastReport {
  readonly id: string;
  readonly outcome: "success" | "failure";
  readonly modes: readonly MastModeVerdict[];
}

/** Injected text-completion seam. Returns the model's raw text (expected to contain the JSON verdict). */
export type LlmComplete = (args: {
  readonly system: string;
  readonly prompt: string;
}) => Promise<string>;

const SYSTEM = [
  "You are a strict failure-mode annotator for multi-agent LLM systems.",
  "You apply the MAST taxonomy (Multi-Agent System failure Taxonomy).",
  "For EACH of the 14 modes, decide whether it is PRESENT in the trace. Be conservative: mark",
  "present:true only with concrete evidence in the transcript. A successful outcome can still",
  "exhibit process failures; a failed outcome need not exhibit every mode. Judge the PROCESS, not",
  "just the result. Output STRICT JSON only — no prose, no code fences.",
].join(" ");

/** Build the judge prompt. The rubric enumerates all 14 modes so the model returns a complete verdict. */
export function buildMastJudgePrompt(input: MastTraceInput): string {
  const rubric = MAST_MODES.map(
    (m) => `- ${m.code} (${m.category}) ${m.name}: ${m.hint}`,
  ).join("\n");
  return [
    `TASK GIVEN TO THE TEAM:\n${input.task}`,
    `\nGROUND-TRUTH OUTCOME (from the grader, not the agents): ${input.outcome}`,
    `\nMAST MODES TO ASSESS:\n${rubric}`,
    `\nTRACE:\n${input.transcript}`,
    [
      "\nReturn STRICT JSON of exactly this shape:",
      '{"modes":[{"code":"FM-1.1","present":false,"evidence":""}, ... all 14 codes ...]}',
      "Include every one of the 14 codes exactly once. `evidence` is a short transcript quote when",
      "present:true, else an empty string.",
    ].join(" "),
  ].join("\n");
}

/**
 * Parse the judge's raw text into a full 14-mode report. Robust to code fences and extra prose, and
 * to a partial answer: any mode the model omitted is recorded `present:false` (conservative default),
 * and unknown codes are ignored. Throws only if no JSON object can be found at all.
 */
export function parseMastResponse(id: string, outcome: "success" | "failure", raw: string): MastReport {
  const obj = extractJsonObject(raw);
  const seen = new Map<string, { present: boolean; evidence: string }>();
  const arr = Array.isArray((obj as { modes?: unknown }).modes) ? (obj as { modes: unknown[] }).modes : [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const code = typeof e.code === "string" ? e.code : undefined;
    if (!code || !MAST_MODE_BY_CODE[code]) continue; // ignore unknown codes
    seen.set(code, {
      present: e.present === true,
      evidence: typeof e.evidence === "string" ? e.evidence : "",
    });
  }
  const modes: MastModeVerdict[] = MAST_MODES.map((m) => {
    const v = seen.get(m.code);
    return { code: m.code, category: m.category, present: v?.present ?? false, evidence: v?.evidence ?? "" };
  });
  return { id, outcome, modes };
}

/** Judge one trace end-to-end. */
export async function judgeTrace(input: MastTraceInput, llm: LlmComplete): Promise<MastReport> {
  const raw = await llm({ system: SYSTEM, prompt: buildMastJudgePrompt(input) });
  return parseMastResponse(input.id, input.outcome, raw);
}

// ── Aggregation ──────────────────────────────────────────────────────────────────────────────

export interface MastHistogram {
  readonly n: number;
  /** Count of runs in which each mode was present, keyed by code. */
  readonly byMode: Record<string, number>;
  /** Count of mode-occurrences per category (sum over that category's modes). */
  readonly byCategory: Record<MastCategoryId, number>;
  /** Per-category share of all flagged occurrences — compare to MAST paper (~42/37/21). */
  readonly categoryShare: Record<MastCategoryId, number>;
}

/** Roll up many reports into the failure histogram used to compare arms (and vs the paper). */
export function aggregateMast(reports: readonly MastReport[]): MastHistogram {
  const byMode: Record<string, number> = Object.fromEntries(MAST_MODES.map((m) => [m.code, 0]));
  const byCategory: Record<MastCategoryId, number> = { FC1: 0, FC2: 0, FC3: 0 };
  for (const r of reports) {
    for (const v of r.modes) {
      if (!v.present) continue;
      byMode[v.code] = (byMode[v.code] ?? 0) + 1;
      byCategory[v.category] += 1;
    }
  }
  const total = byCategory.FC1 + byCategory.FC2 + byCategory.FC3;
  const share = (c: MastCategoryId): number => (total === 0 ? 0 : byCategory[c] / total);
  return {
    n: reports.length,
    byMode,
    byCategory,
    categoryShare: { FC1: share("FC1"), FC2: share("FC2"), FC3: share("FC3") },
  };
}

/** Markdown one-liner per category for quick eval reports. */
export function renderMastHistogram(h: MastHistogram): string {
  const rows = (Object.keys(MAST_CATEGORIES) as MastCategoryId[]).map((c) => {
    const cat = MAST_CATEGORIES[c];
    const pct = (h.categoryShare[c] * 100).toFixed(0);
    const paper = (cat.paperShare * 100).toFixed(0);
    return `| ${cat.id} ${cat.name} | ${h.byCategory[c]} | ${pct}% | ${paper}% |`;
  });
  return [
    `MAST histogram over n=${h.n} runs`,
    "",
    "| Category | occurrences | our share | paper share |",
    "|---|--:|--:|--:|",
    ...rows,
  ].join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

/** Pull the first balanced JSON object out of arbitrary model text (handles ```json fences + prose). */
function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf("{");
  if (start === -1) throw new Error("MAST judge: no JSON object in model response");
  // Scan for the matching closing brace (string-aware).
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error("MAST judge: unterminated JSON object in model response");
}
