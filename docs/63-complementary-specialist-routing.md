# 63 — Complementary-specialist routing (diversity, not just cost-tiering)

**Status:** design + results — **diversity not supported (H3 + H4)**. Model diversity: substitutable single-shot (κ=0.058), harness-fit-contaminated agentic (§9). Loadout diversity: κ=0 at 3 seeds — the best loadout (plan-first) dominates; the 1-seed probe's κ=0.67 was noise (§10). Loadout is a *quality* lever (+0.19), not a diversity lever. Extends 50 (thesis), 62 (offline method + honest-compute pre-check + §8 attribution).

## 1. Why — the gap docs/62 leaves open

docs/62 proved the cost-frontier thesis in its *cost-tiering* form: a genuinely small tier (real FLOPs gap) + escalation expands the FLOPs frontier (single-shot 1.9–3.5×; agentic structural transfer ~1.3×). But §8.2 is the catch: **every winning pair was a same-family scale ladder, and `small-only` ≈ 0** — the cheap tier never owned tasks the large couldn't. The wins were *routing the shared easy slice cheaply*, **not diversity**. Whether a swarm of **complementary specialists** — models with *different* strengths covering *different* tasks — improves **accuracy** (union coverage beyond any single model) and **efficiency** (matched accuracy at lower compute) is untested.

**H3.** A set of complementary specialists {M₁…Mₖ}, routed per-task to the best-suited model, achieves (a) **higher accuracy** than the best single model (genuine union coverage), and/or (b) **lower compute at matched accuracy**, than any monolith — and a deployable router can capture most of that gain.

## 2. The complementarity pre-check (the H3 analog of §7)

Cost-tiering needs `cost(C) < p_C·cost(E)`. **Diversity needs mutual-exclusive coverage** — the models must solve *different* tasks. Define, over the union of solved tasks:

> **Complementarity index** `κ = 1 − (both/all-solvers per task, averaged) `, or operationally: `κ = (Σ tasks solved by exactly one model) / (Σ tasks solved by ≥1 model)`.

- `κ ≈ 0` → every solver solves the same tasks → routing **cannot** raise accuracy (only cost). Diversity is illusory — **stop** (this is what a scale ladder looks like: `small-only ≈ 0`).
- `κ` large → models own disjoint slices → an oracle router's union coverage **exceeds** the best single model by the mutual-exclusive mass. This is the exploitable structure.

Measure κ from *k mono runs each* — cheap, no router needed, exactly like the §7 pre-check. **This is the first thing to run**; everything else is gated on κ > 0.

## 3. Method — measure once, evaluate every router offline

Reuse docs/62's reconstruction: run each candidate model once per task (k seeds), one row per `(task, model, seed)` with `correct`, split tokens, and each model's cheap self-signal. Then every router is free arithmetic:

- **Oracle router** — route each task to a model that solves it (cheapest such, for the compute axis). Quality = union coverage = the accuracy ceiling. Needs no signal.
- **Diversity gain** `Δacc = Q(oracle-router) − max_i Q(Mᵢ)` — the accuracy a monolith *cannot* reach. **This is the H3(a) headline.** (κ=0 ⇒ Δacc=0.)
- **Efficiency** — oracle-router compute (route to the cheapest solver) vs the best single model's compute at matched accuracy. H3(b).
- **Real-signal router** — a deployable per-task model-picker; its gap below the oracle router = routing-signal loss.
- **Controls** — random routing at matched cost; best single model; and the *ensemble* baseline (run all k, take best — upper bound at k× cost) to show the router beats naive all-run.

Analyzer: generalize `humaneval-frontier.ts` from a 2-tier cascade to an **N-way router** (`eval/analysis/router-frontier.ts`): the complementarity matrix (pairwise + set κ), the oracle-router accuracy/compute, and the real-signal router sweep.

## 4. The router signal (the deployable part)

Routing is a k-way *which-model* decision, not a binary escalate. Candidates, cheapest first:
1. **Per-model self-test** (docs/62 F15, AUC 0.841 single-shot) — each model authors + runs tests for its own attempt; route to the model whose self-tests pass (ties → cheapest). Reuses `sig_selftests`; no new mechanism. **Primary.**
2. **Cheap task classifier** — a small model (or embedding) predicts the best specialist from the task text. One cheap call, no per-model attempts.
3. **Verifier-picks** — all candidates attempt; a cheap verifier/judge picks. Upper-accuracy, k× cost (the ensemble bound).

The single-shot F15 result says (1) is viable for code-gen; F16 warns it may degrade agentically for weak members — so **member strength matters for the signal too**, feeding model selection (§5).

## 5. Model selection — diverse families, comparable cost

The point is *horizontal* diversity: different training → different strengths, at *similar* cost (so routing is about *who's best*, not *who's cheapest*). All available on Bedrock (no new credential — the awsbedrock/ transport):

| candidate | family / bias | note |
|---|---|---|
| `qwen.qwen3-coder-30b-a3b` | agentic coder (Qwen) | 3B active — cheap, proven tool-use |
| `deepseek.v3-v1:0` | reasoning-heavy (DeepSeek) | different failure profile than a coder |
| `mistral.devstral-2-123b` | SWE-bench-tuned (Mistral) | purpose-built for repo fixes |
| `zai.glm-4.7` / `moonshotai.kimi-k2.5` | agentic (GLM / Kimi) | distinct vendors |
| `openai.gpt-oss-20b` | OpenAI OSS | different lineage |

Start with **3–4** of *comparable* cost (e.g. Qwen-Coder-30B, DeepSeek-V3, Devstral, GLM) so κ measures capability-complementarity, not a cost ladder.

## 6. Benchmark — complementarity is only visible in the "some solve, some don't" band

On easy tasks strong models all succeed (κ→0 by saturation); on impossibly-hard tasks all fail (κ→0 by floor). **Diversity shows up only at intermediate difficulty.** So: use tasks hard enough that no single model saturates and easy enough that no single model floors — MBPP (harder than HumanEval) and/or a difficulty-filtered SWE slice. Avoid pure-easy HumanEval for the screen.

## 7. Sequencing (cheap-first, box-last — apply the docs/62 §8.4 + ops lessons)

- **Phase A — single-shot complementarity screen (local, no box, ~$20).** Run 3–4 diverse families single-shot on MBPP (+ a hard HumanEval subset), **k=3 seeds**. Compute κ + oracle-router Δacc. **If κ ≈ 0 → diversity is illusory for this set; stop or reselect.** If κ > 0 → the accuracy claim has structure; measure the real-signal router (self-test).
- **Phase B — agentic SWE (box, only if Phase A shows κ > 0, ~$40–100).** Same diverse set on a difficulty-filtered SWE slice, **≥3 seeds**, oracle + real-signal router. Ops guardrails from docs/62 §5.2: **≤16 instances per pass** (194 GB box ≈ 16 images), no `docker prune` concurrent with a run, reboot to clear a disk-thrash, fresh `CS_CONFIG_VERSION`.

## 8. What would make H3 *decisive*

Accuracy: oracle-router Δacc > 0 with CI excluding 0 at ≥3 seeds, *and* a deployable router that captures a real fraction of it (not just the oracle). Efficiency: router matches the best single model's accuracy at strictly lower FLOPs. Both on the honest compute axis, offline-vs-live gap acknowledged (docs/62 §8.4). Failure is also informative: κ ≈ 0 across diverse families would say code-task competence is *scalar* (all models fail the same hard tasks) — diversity buys nothing, and only cost-tiering (docs/62) helps.

## 9. Results (2026-07-27) — H3 not supported

**Phase A — single-shot MBPP (5 models, 1 seed): diverse competent models are substitutable.** Swarm Qwen-Coder-30B / gpt-oss-20b / Gemma-12B / Ministral-8B (resolve 0.73–0.87) vs DeepSeek-V3 (0.88). **κ = 0.058** — ~374/397 solved tasks are solved by ≥2 members; only 23 uniquely owned. Oracle router 0.932 (Δacc **+0.061** over the best single) @ 9.2× fewer FLOPs than DeepSeek — **but that's cost-tiering + an oracle ceiling, not diversity**: a single small model (gpt-oss) already ~matches DeepSeek at ~3× cheaper, and the router's low FLOPs use cheapest-*solver* hindsight (a deployable router would be far worse). On MBPP, code competence is ~scalar — diversity buys ~nothing; the lever is cost (docs/62).

**Phase B — agentic SWE (easy-16, 4 tool-capable models, 1 seed): degenerate + harness-contaminated.** Only **Qwen-Coder** (purpose-built agentic coder) works (0.50, 8/16); gpt-oss (1/16), Ministral (1/16), and **DeepSeek-V3 (0/16)** solve ~nothing — despite all running full trajectories (94k–578k fresh tok/task, 0 env-errors, so not a $0 failure). **κ = 0.875 but that is one-model-dominance, not complementarity** (Δacc = **0.000** — the others contribute zero). **DeepSeek's 0/16 is a harness-fit red flag:** a strong model burning ~94k tok/task yet solving nothing means the scaffold (repro-first prompt + cascade tool-protocol) suits Qwen but not the others — so the non-Qwen results are **contaminated** (capability vs harness-fit is inseparable here).

**Verdict:** H3 not supported on the testable surfaces. Single-shot: substitutable (κ≈0.06). Agentic: degenerated to "only the agentic-coder-tuned model functions in this harness" — a statement about *model-specialization + harness-fit*, not clean task-complementarity. No diversity gain observed either way.

**Methodological lesson (docs/62 §8.3 recurring):** gate on *full agentic competence per model* (a per-model pilot confirming each solves some), not a toy tool-use check — a model can pass `get_weather` yet fail the real SWE loop (DeepSeek 0/16). And the agentic finding *is* real in one sense: a heterogeneous agentic swarm is hard because **most models can't drive the loop well** — agentic-SWE membership is a narrow, specialization-dependent set, which is itself a constraint on the docs/50 thesis. Tools: `eval/analysis/router-frontier.ts`, `eval/experiments/mbpp-signal.ts` (multi-model), `bedrock-toolcheck.ts`.

## 10. H4 — loadout diversity (same model, different loadouts): also not supported

Since model diversity failed, test **configuration diversity**: one working model (Qwen-Coder-30B) in k loadouts. A free 1-seed probe (plain vs repro-first on easy-16) *suggested* complementarity (κ=0.67, oracle +2 tasks) — but the proper test falsifies it.

**4 loadouts (direct / repro-first / explore-first / plan-first) × easy-16 × 3 seeds** (`CS_LOADOUTS`, arm-per-loadout; analyzed `router-frontier --by arm`):

| loadout | resolve (p≥0.5 over 3 seeds) | unique-solves |
|---|--:|--:|
| direct | 0.438 | 0 |
| repro-first | 0.438 | 0 |
| explore-first | 0.500 | 0 |
| **plan-first** | **0.625** | 0 |

**κ = 0.000, Δacc = 0.000.** The best loadout (plan-first) solves a **strict superset** — all 10 tasks any loadout solves (union=plan=10, non-plan-solves-plan-misses=0). No loadout complements it. **The 1-seed probe's κ=0.67 was seed noise:** apparent "unique solves" were single-seed flukes that wash out over 3 seeds — exactly the 1-seed hazard of docs/57 (5-seed inversion) and §8.4. A clean vindication of the ≥3-seed discipline.

**But loadout is a real *quality* lever, not a diversity lever:** plan-first (0.625) > explore (0.500) > direct = repro (0.438) — **+0.19 resolve from prompt strategy alone**. So loadout/prompt engineering meaningfully improves the *single* agent; the win is "find and use the best loadout," not "run a swarm of diverse loadouts."

**Diversity investigation closed (H3 + H4).** Neither **model diversity** (substitutable single-shot κ=0.06; harness-fit-contaminated agentic) nor **loadout diversity** (κ=0 at 3 seeds; best loadout dominates) produces exploitable complementarity on code tasks. The frontier-expanding levers are **cost-tiering with a genuinely small tier** (docs/62, ~1.3–3.5× FLOPs) and **single-agent loadout quality** (plan-first, +0.19) — not complementarity-based swarming.
