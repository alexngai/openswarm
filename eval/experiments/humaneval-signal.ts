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

interface Problem { task_id: string; prompt: string; canonical_solution: string; test: string; entry_point: string; }
interface Row {
  task_id: string; model: string; seed: number;
  correct: 0 | 1; sig_visible: number | null; dt_attempt: number;
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
    else if (ev.type === "finish") usage = (ev.usage as Record<string, number>) ?? {};
    else if (ev.type === "error") throw new Error(`gen error: ${ev.message}`);
  }
  return { text, usage };
}

/** Strip markdown fences / keep the code body. */
function extractCode(raw: string): string {
  const fence = raw.match(/```(?:python)?\s*\n?([\s\S]*?)```/);
  return (fence ? fence[1]! : raw).trim();
}

function runExec(p: Problem, completion: string): { hidden: boolean; dt_attempt: number; dt_fail: number; err?: string } {
  const dir = mkdtempSync(join(tmpdir(), "he-"));
  const pf = join(dir, "prompt.py"), cf = join(dir, "completion.py"), tf = join(dir, "test.py");
  writeFileSync(pf, p.prompt); writeFileSync(cf, completion); writeFileSync(tf, p.test);
  const r = spawnSync(PY, [EXEC, pf, cf, tf, p.entry_point], { timeout: 15_000, encoding: "utf8", cwd: dir });
  if (r.status !== 0 || !r.stdout) {
    return { hidden: false, dt_attempt: 0, dt_fail: 0, err: r.error?.message ?? (r.stderr || "exec-fail").slice(0, 120) };
  }
  try { return JSON.parse(r.stdout.trim().split("\n").pop()!); }
  catch { return { hidden: false, dt_attempt: 0, dt_fail: 0, err: "parse" }; }
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
          const ex = runExec(p, code);
          const sig = ex.dt_attempt > 0 ? (ex.dt_attempt - ex.dt_fail) / ex.dt_attempt : null;
          row = {
            task_id: p.task_id, model, seed, correct: ex.hidden ? 1 : 0,
            sig_visible: sig, dt_attempt: ex.dt_attempt,
            tok_in: usage.inputTokens ?? 0, tok_out: usage.outputTokens ?? 0,
            tok_total: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            gen_chars: code.length, ...(ex.err ? { err: ex.err } : {}),
          };
        } catch (e) {
          row = { task_id: p.task_id, model, seed, correct: 0, sig_visible: null, dt_attempt: 0,
            tok_in: 0, tok_out: 0, tok_total: 0, gen_chars: 0, err: (e instanceof Error ? e.message : String(e)).slice(0, 140) };
        }
        rows.push(row);
        appendFileSync(OUT, JSON.stringify(row) + "\n");
      }
    }
    // per-model summary
    const solved = rows.filter((r) => r.correct).length;
    const withSig = rows.filter((r) => r.sig_visible !== null);
    const a = auc(withSig.map((r) => r.sig_visible!), withSig.map((r) => r.correct));
    console.error(
      `[he] ${model.split("/").pop()}: resolve ${(solved / rows.length).toFixed(3)} (${solved}/${rows.length}) | ` +
      `sig coverage ${withSig.length}/${rows.length} | sig_visible AUC ${a === null ? "n/a" : a.toFixed(3)} | ` +
      `errs ${rows.filter((r) => r.err).length}`,
    );
  }
  console.error(`[he] done → ${OUT}. Analyze: the AUC above is the escalation-signal discriminativeness (docs/58 Q2).`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("[he] FAILED:", e); process.exit(1); });
