/**
 * mbpp-signal.ts — docs/62 Phase 1.5: MBPP scale-out of the single-shot code-gen +
 * escalation-signal surface. Sibling of humaneval-signal.ts; emits the SAME row
 * schema so `eval/analysis/humaneval-frontier.ts` analyzes both unchanged.
 *
 * MBPP has no docstring `>>>` examples — each problem ships a `test_list` of asserts.
 * To keep signal and oracle leakage-free we SPLIT it: the model is shown `tests[0]`
 * (which also conveys the function name/signature) and that assert becomes the
 * visible-test signal; `tests[1:]` are held out as the hidden oracle. All sanitized
 * MBPP problems have ≥3 asserts, so the oracle is ≥2 held-out tests and signal
 * coverage is ~100% (vs HumanEval's 44% doctest coverage — §4.2 caveat b).
 *
 * Data prep (MB_DATA, gitignored under .artifacts like humaneval.jsonl): fetch the
 * canonical sanitized set and normalize to `{task_id, text, setup, tests[]}` per line:
 *   curl -sO https://raw.githubusercontent.com/google-research/google-research/master/mbpp/sanitized-mbpp.json
 *   # then: task_id→"MBPP/<id>", prompt→text, test_imports→setup(\n-joined), test_list→tests
 *
 * Run (creds via `source ~/.zshrc`, region us-west-2 — the transport defaults to
 * us-east-1 which is 429-exhausted):
 *   AWS_REGION=us-west-2 \
 *   MB_MODELS=awsbedrock/us.meta.llama3-1-8b-instruct-v1:0,awsbedrock/us.meta.llama3-3-70b-instruct-v1:0 \
 *   MB_PYTHON_BIN=~/.venvs/swebench/bin/python MB_N=427 \
 *   npx tsx eval/experiments/mbpp-signal.ts
 */
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveProvider } from "../../src/providers/routing.js";
import type { ProviderRequest, Provider } from "../../src/providers/index.js";

const MODELS = (process.env.MB_MODELS ?? "awsbedrock/us.meta.llama3-1-8b-instruct-v1:0,awsbedrock/us.meta.llama3-3-70b-instruct-v1:0")
  .split(",").map((s) => s.trim()).filter(Boolean);
const N = process.env.MB_N ? Number(process.env.MB_N) : Infinity;
const SEEDS = (process.env.MB_SEEDS ?? "1").split(",").map(Number);
const TEMP = process.env.MB_TEMP ? Number(process.env.MB_TEMP) : 0.2;
const PY = process.env.MB_PYTHON_BIN ?? "python3";
const EXEC = resolve("eval/scripts/mbpp_exec.py"); // absolute — runExec uses cwd=scratch dir
const DATA = process.env.MB_DATA ?? "eval/.artifacts/mbpp/mbpp.jsonl";
const OUT = process.env.MB_OUT ?? "eval/.artifacts/mbpp/rows.jsonl";

interface Problem { task_id: string; text: string; setup: string; tests: string[]; }
interface Row {
  task_id: string; model: string; seed: number;
  correct: 0 | 1; sig_visible: number | null; dt_attempt: number;
  tok_in: number; tok_out: number; tok_total: number; gen_chars: number; err?: string;
}

async function buildProvider(model: string): Promise<{ provider: Provider; modelId: string }> {
  const r = resolveProvider(model);
  if (r.kind !== "native" || !r.providerFactory) {
    throw new Error(`mbpp-signal needs a native transport for "${model}" (got kind=${r.kind}); single-shot uses .stream()`);
  }
  const auth = r.authFactory ? await r.authFactory() : (undefined as never);
  const provider = await r.providerFactory(auth, r.modelId ?? model);
  return { provider, modelId: r.modelId ?? model };
}

function buildPrompt(p: Problem): string {
  return (
    "Write a single Python function to solve the task below. Respond with ONLY the " +
    "complete function definition (signature + body + any imports it needs). No " +
    "explanation, no markdown, no example calls, no tests.\n\n" +
    `Task: ${p.text}\n\nYour function must pass this test:\n${p.tests[0]}`
  );
}

async function generate(provider: Provider, modelId: string, prompt: string, temperature: number) {
  const req: ProviderRequest = {
    model: modelId,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
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

/** Extract the code body, robust to reasoning models: strip <think> blocks, then prefer
 *  the LAST fenced code block (reasoning models emit scratch code mid-thought, final last). */
function extractCode(raw: string): string {
  const noThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
  const fences = [...noThink.matchAll(/```(?:python)?\s*\n?([\s\S]*?)```/g)];
  if (fences.length) return fences[fences.length - 1]![1]!.trim();
  return noThink.trim();
}

function runExec(p: Problem, completion: string): { hidden: boolean; dt_attempt: number; dt_fail: number; err?: string } {
  const dir = mkdtempSync(join(tmpdir(), "mb-"));
  const cf = join(dir, "completion.py"), vf = join(dir, "visible.txt"), hf = join(dir, "hidden.txt"), sf = join(dir, "setup.txt");
  writeFileSync(cf, completion);
  writeFileSync(vf, p.tests[0] ?? "");        // visible = the assert shown in the prompt
  writeFileSync(hf, p.tests.slice(1).join("\n")); // hidden oracle = held-out asserts
  writeFileSync(sf, p.setup ?? "");
  const r = spawnSync(PY, [EXEC, cf, vf, hf, sf], { timeout: 15_000, encoding: "utf8", cwd: dir });
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
  console.error(`[mb] ${problems.length} problems × ${MODELS.length} models × ${SEEDS.length} seeds → ${OUT}`);

  for (const model of MODELS) {
    const { provider, modelId } = await buildProvider(model);
    const rows: Row[] = [];
    for (const p of problems) {
      for (const seed of SEEDS) {
        let row: Row;
        try {
          const { text, usage } = await generate(provider, modelId, buildPrompt(p), SEEDS.length > 1 ? 0.7 : TEMP);
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
    const solved = rows.filter((r) => r.correct).length;
    const withSig = rows.filter((r) => r.sig_visible !== null);
    const a = auc(withSig.map((r) => r.sig_visible!), withSig.map((r) => r.correct));
    console.error(
      `[mb] ${model.split("/").pop()}: resolve ${(solved / rows.length).toFixed(3)} (${solved}/${rows.length}) | ` +
      `sig coverage ${withSig.length}/${rows.length} | sig_visible AUC ${a === null ? "n/a" : a.toFixed(3)} | ` +
      `errs ${rows.filter((r) => r.err).length}`,
    );
  }
  console.error(`[mb] done → ${OUT}. Analyze: tsx eval/analysis/humaneval-frontier.ts ${OUT}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => { console.error("[mb] FAILED:", e); process.exit(1); });
