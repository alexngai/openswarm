/**
 * humaneval-signal.ts — docs/58 Phase 1: single-shot code-gen + escalation signal.
 *
 * For each HumanEval problem × model × seed: generate a completion via the provider
 * transport (`.stream()`, no agent loop / no sandbox-per-trial), then run the
 * `humaneval_exec.py` harness to get BOTH the oracle correctness label (hidden test)
 * and a cheap, oracle-free escalation signal (`sig_visibletests` = docstring `>>>`
 * doctests pass-rate). Emits one JSONL row per (task, model, seed); prints per-model
 * resolve-rate and the signal AUC (P(sig higher on a correct sample than a wrong one)).
 *
 * The docs/58 crux: if `sig_visibletests` discriminates correct from wrong completions
 * (AUC ≫ 0.5), a cascade can route on it; if AUC ≈ 0.5 no cascade works regardless of
 * the model pair. Cheap ($5–30), graded, code-relevant — the mechanism, de-confounded.
 *
 * Run (creds via `source ~/.zshrc`):
 *   HE_MODELS=awsbedrock/us.meta.llama3-1-8b-instruct-v1:0,azureoai/gpt-5.5 \
 *   HE_PYTHON_BIN=~/.venvs/swebench/bin/python HE_N=164 \
 *   npx tsx eval/experiments/humaneval-signal.ts
 */
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveProvider } from "../../src/providers/routing.js";
import type { ProviderRequest, Provider } from "../../src/providers/index.js";

const MODELS = (process.env.HE_MODELS ?? "awsbedrock/us.meta.llama3-1-8b-instruct-v1:0,azureoai/gpt-5.5")
  .split(",").map((s) => s.trim()).filter(Boolean);
const N = process.env.HE_N ? Number(process.env.HE_N) : Infinity;
const SEEDS = (process.env.HE_SEEDS ?? "1").split(",").map(Number);
const TEMP = process.env.HE_TEMP ? Number(process.env.HE_TEMP) : 0.2;
const PY = process.env.HE_PYTHON_BIN ?? "python3";
const EXEC = resolve("eval/scripts/humaneval_exec.py"); // absolute — runExec uses cwd=scratch dir
const DATA = process.env.HE_DATA ?? "eval/.artifacts/humaneval/humaneval.jsonl";
const OUT = process.env.HE_OUT ?? "eval/.artifacts/humaneval/rows.jsonl";
// Extra oracle-free signals (docs/62 §4 full comparison): the model authors tests for
// its own completion (sig_selftests, ~100% coverage — the SWE authored-repro analog) and
// self-judges it (sig_judge). Off by default (2 extra calls/problem); HE_SIGNALS=1 enables.
const SIGNALS = process.env.HE_SIGNALS === "1";

interface Problem { task_id: string; prompt: string; canonical_solution: string; test: string; entry_point: string; }
interface Row {
  task_id: string; model: string; seed: number;
  correct: 0 | 1; sig_visible: number | null; sig_selftests: number | null; sig_judge: number | null;
  dt_attempt: number; st_attempt: number;
  tok_in: number; tok_out: number; tok_total: number; gen_chars: number; err?: string;
}

async function buildProvider(model: string): Promise<{ provider: Provider; modelId: string }> {
  const r = resolveProvider(model);
  if (r.kind !== "native" || !r.providerFactory) {
    throw new Error(`humaneval-signal needs a native transport for "${model}" (got kind=${r.kind}); single-shot uses .stream()`);
  }
  const auth = r.authFactory ? await r.authFactory() : (undefined as never);
  const provider = await r.providerFactory(auth, r.modelId ?? model);
  return { provider, modelId: r.modelId ?? model };
}

async function generate(provider: Provider, modelId: string, p: Problem, temperature: number) {
  const promptText =
    "Complete the following Python function. Respond with ONLY the complete function " +
    "definition (signature + body + any imports it needs). No explanation, no markdown.\n\n" + p.prompt;
  const req: ProviderRequest = {
    model: modelId,
    messages: [{ role: "user", content: [{ type: "text", text: promptText }] }],
    maxOutputTokens: 1024,
    temperature,
  };
  let text = "";
  let usage: Record<string, number> = {};
  for await (const ev of provider.stream(req)) {
    if (ev.type === "text-delta") text += ev.text;
    else if (ev.type === "finish") usage = (ev.usage as unknown as Record<string, number>) ?? {};
    else if (ev.type === "error") throw new Error(`gen error: ${ev.message}`);
  }
  return { text, usage };
}

/** One-shot text completion (for the signal sub-calls). */
async function askText(provider: Provider, modelId: string, prompt: string, temperature: number, maxOutputTokens: number): Promise<string> {
  const req: ProviderRequest = { model: modelId, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], maxOutputTokens, temperature };
  let text = "";
  for await (const ev of provider.stream(req)) if (ev.type === "text-delta") text += ev.text;
  return text;
}

/** sig_selftests: the model authors assert tests for the function from the SPEC (never sees
 * the hidden test); we run them against its own completion. Oracle-free, ~100% coverage. */
async function genSelfTests(provider: Provider, modelId: string, p: Problem): Promise<string[]> {
  const prompt =
    `Given this Python function specification, write 5 independent \`assert\` statements that test ` +
    `\`${p.entry_point}\` based ONLY on the spec. Each on its own line, calling \`${p.entry_point}(...)\`. ` +
    `Output ONLY the asserts — no code fences, no explanation.\n\n${p.prompt}`;
  const raw = await askText(provider, modelId, prompt, 0.2, 512);
  const body = raw.match(/```(?:python)?\s*\n?([\s\S]*?)```/)?.[1] ?? raw;
  return body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("assert")).slice(0, 8);
}

/** sig_judge: the model self-scores P(correct) ∈ [0,1] for its own completion. */
async function judge(provider: Provider, modelId: string, p: Problem, completion: string): Promise<number | null> {
  const prompt =
    `Problem:\n${p.prompt}\n\nCandidate solution:\n${completion}\n\nOn a scale of 0 to 100, the probability this ` +
    `solution is correct and passes all hidden tests. Reply with ONLY the integer.`;
  const raw = await askText(provider, modelId, prompt, 0, 8);
  const m = raw.match(/\d+/);
  if (!m) return null;
  return Math.max(0, Math.min(100, Number(m[0]))) / 100;
}

/** Strip markdown fences / keep the code body. */
function extractCode(raw: string): string {
  const fence = raw.match(/```(?:python)?\s*\n?([\s\S]*?)```/);
  return (fence ? fence[1]! : raw).trim();
}

interface ExecOut { hidden: boolean; dt_attempt: number; dt_fail: number; st_attempt: number; st_fail: number; err?: string }
function runExec(p: Problem, completion: string, selftests: string[]): ExecOut {
  const dir = mkdtempSync(join(tmpdir(), "he-"));
  const pf = join(dir, "prompt.py"), cf = join(dir, "completion.py"), tf = join(dir, "test.py"), sf = join(dir, "selftests.py");
  writeFileSync(pf, p.prompt); writeFileSync(cf, completion); writeFileSync(tf, p.test); writeFileSync(sf, selftests.join("\n"));
  const args = selftests.length ? [EXEC, pf, cf, tf, p.entry_point, sf] : [EXEC, pf, cf, tf, p.entry_point];
  const r = spawnSync(PY, args, { timeout: 15_000, encoding: "utf8", cwd: dir });
  if (r.status !== 0 || !r.stdout) {
    return { hidden: false, dt_attempt: 0, dt_fail: 0, st_attempt: selftests.length, st_fail: selftests.length, err: r.error?.message ?? (r.stderr || "exec-fail").slice(0, 120) };
  }
  try { const o = JSON.parse(r.stdout.trim().split("\n").pop()!); return { st_attempt: 0, st_fail: 0, ...o }; }
  catch { return { hidden: false, dt_attempt: 0, dt_fail: 0, st_attempt: selftests.length, st_fail: selftests.length, err: "parse" }; }
}

/** Rank-based AUC (Mann-Whitney): P(score higher on a positive than a negative), ties=0.5. */
function auc(scores: number[], labels: number[]): number | null {
  const pos: number[] = [], neg: number[] = [];
  for (let i = 0; i < scores.length; i++) (labels[i] ? pos : neg).push(scores[i]!);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

async function main(): Promise<number> {
  const problems: Problem[] = readFileSync(DATA, "utf8").trim().split("\n").map((l) => JSON.parse(l)).slice(0, N);
  writeFileSync(OUT, ""); // truncate
  console.error(`[he] ${problems.length} problems × ${MODELS.length} models × ${SEEDS.length} seeds → ${OUT}`);

  for (const model of MODELS) {
    const { provider, modelId } = await buildProvider(model);
    const rows: Row[] = [];
    for (const p of problems) {
      for (const seed of SEEDS) {
        let row: Row;
        try {
          const { text, usage } = await generate(provider, modelId, p, SEEDS.length > 1 ? 0.7 : TEMP);
          const code = extractCode(text);
          const selftests = SIGNALS ? await genSelfTests(provider, modelId, p) : [];
          const ex = runExec(p, code, selftests);
          const sig = ex.dt_attempt > 0 ? (ex.dt_attempt - ex.dt_fail) / ex.dt_attempt : null;
          const sigSt = ex.st_attempt > 0 ? (ex.st_attempt - ex.st_fail) / ex.st_attempt : null;
          const sigJudge = SIGNALS ? await judge(provider, modelId, p, code) : null;
          row = {
            task_id: p.task_id, model, seed, correct: ex.hidden ? 1 : 0,
            sig_visible: sig, sig_selftests: sigSt, sig_judge: sigJudge, dt_attempt: ex.dt_attempt, st_attempt: ex.st_attempt,
            tok_in: usage.inputTokens ?? 0, tok_out: usage.outputTokens ?? 0,
            tok_total: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            gen_chars: code.length, ...(ex.err ? { err: ex.err } : {}),
          };
        } catch (e) {
          row = { task_id: p.task_id, model, seed, correct: 0, sig_visible: null, sig_selftests: null, sig_judge: null, dt_attempt: 0, st_attempt: 0,
            tok_in: 0, tok_out: 0, tok_total: 0, gen_chars: 0, err: (e instanceof Error ? e.message : String(e)).slice(0, 140) };
        }
        rows.push(row);
        appendFileSync(OUT, JSON.stringify(row) + "\n");
      }
    }
    // per-model summary: resolve + AUC/coverage for every computed signal.
    const solved = rows.filter((r) => r.correct).length;
    console.error(`[he] ${model.split("/").pop()}: resolve ${(solved / rows.length).toFixed(3)} (${solved}/${rows.length}) | errs ${rows.filter((r) => r.err).length}`);
    for (const key of ["sig_visible", "sig_selftests", "sig_judge"] as const) {
      const w = rows.filter((r) => r[key] !== null);
      if (!w.length) continue;
      const a = auc(w.map((r) => r[key]!), w.map((r) => r.correct));
      console.error(`[he]    ${key.padEnd(14)} AUC ${a === null ? "n/a" : a.toFixed(3)}  coverage ${w.length}/${rows.length}`);
    }
  }
  console.error(`[he] done → ${OUT}. Analyze: the AUC above is the escalation-signal discriminativeness (docs/58 Q2).`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("[he] FAILED:", e); process.exit(1); });
