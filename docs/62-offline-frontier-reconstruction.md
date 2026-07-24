# 62 — Offline frontier reconstruction + escalation-signal AUC

**Status:** methodology proposal + Phase 0 results (retroactive validation). Extends 50 (the thesis), 54/59/60/61 (the live-experiment line that reached "H2.1 not robustly supported").

## 1. Why a new methodology

docs/54, 59–61 tested H2.1 (a heterogeneous cascade Pareto-expands the cost/quality frontier vs the monolith) with **live, end-to-end, per-policy** runs on SWE-bench Verified, and landed on *not robustly supported*. The approach is expensive and, worse, **confounded** — a single run entangles four independent things and reports the noisiest possible output:

1. **Model capability** — is there exploitable task structure at all?
2. **Escalation-signal quality** — can a cheap signal tell *when* the small tier is wrong?
3. **Agentic-loop competence** — can the small model even drive tools? (Nova-Lite: 0/14; it drove loops but solved nothing.)
4. **Cost axis** — cross-provider `$` vs honest compute (the §8.1 "local is free" trap).

...measured as **binary resolve at n=1**, which docs/61 confirms is too noisy to even classify task difficulty. Every full policy run costs $-and-hours, and you need many of them (τ-sweep × seeds × model pairs).

**Reframe.** H2.1 reduces to two measurable questions that don't require running any policy live:

- **(Q1) Structure:** is there a set of tasks the cheap tier solves *at genuinely lower compute* than the large tier? (A property of two mono runs.)
- **(Q2) Signal:** can a cheap, oracle-free signal detect those tasks? (A classification metric.)

If Q1 is no, no policy helps — full stop. If Q1 is yes, the achievable frontier is determined by Q2. Both are far cheaper to measure than a live cascade, and neither is confounded by the other.

## 2. The method: measure once, evaluate every policy offline

Run each model on each task **once** (or *k* seeds), and write one flat table (`results.jsonl`, one row per `(task, model, seed)`):

| field | meaning |
|---|---|
| `task, model, seed` | keys |
| `correct` ∈ {0,1} | oracle label. **Analysis-only — never visible to a policy** |
| `tok_in, tok_out, tok_cacheRead, tok_cacheWrite` | cost, split so the axis can be made honest (fresh compute vs cache-reads) |
| `signal_*` | one column per cheap escalation signal, computed from the model's *own* output with **no oracle** |

A cascade is then a pure function over the table: *run cheap C; accept if `signal ≥ τ`, else escalate to E.*
- **Q(τ)** = mean `[ correct(C) if sig≥τ else correct(E) ]`
- **C(τ)** = mean `[ cost(C) + (sig<τ ? cost(E) : 0) ]` — always pay C; pay E only on escalation

Everything below is free arithmetic over the table:

1. **Oracle-cascade frontier** — escalate iff `correct(C)=0`. The *ceiling*, needs **no signal**. Pareto-expands only if the **key inequality** holds:
   > `cost(C)  <  p_C · cost(E)`  — the cheap tier's cost must be less than the expected large-tier cost it saves.
2. **Signal AUC** — for each `signal_*`, AUC over `(signal, correct)` on the cheap tier. AUC≈0.5 ⇒ useless trigger ⇒ no cascade works; AUC→1 ⇒ near-oracle routing. *The crux we had never measured.*
3. **Real-signal frontier** — sweep τ. Its gap below the oracle frontier = signal loss.
4. **Controls** — random escalation at matched rate (the RO3 mechanism ablation) and the monolith's own best-of-N curve.

**Cost decomposition.** The offline cascade cost uses *cold* C and *cold* E (each run once), so it excludes handoff bloat. That makes the three losses separable:
`live cascade cost = [oracle structural cost] + [signal loss: AUC<1] + [handoff bloat: live E > cold E]`.
docs/61's "escalation costs ~2× a cold monolith" is the third term; Phase 0 below shows the *first* term already fails, before signal or handoff even enter.

## 3. Phase 0 — retroactive validation (free, from existing cells)

Computed the oracle-cascade frontier on the mono cells already in `.eval-runs/cache/` — no new spend. (Analyzer: `scratchpad/phase0_oracle.mjs`; to be promoted to `eval/analysis/offline-frontier.ts`.)

**haiku ↔ gpt-5.5** (N=26): structure both-solve=15, small-only=**1**, large-only=1, neither=9.

| | Quality | fresh tok (in+out+cacheWrite) | total tok (incl cache-read) |
|---|--:|--:|--:|
| mono-small (haiku) | 0.577 | 0.07M | 1.91M |
| mono-large (gpt-5.5) | 0.615 | 0.06M | 0.64M |
| oracle-cascade | 0.662 | 0.10M | 2.24M |

**Nova-Pro ↔ gpt-5.5** (N=13): structure both-solve=1, small-only=**0**, large-only=8, neither=4.

| | Quality | fresh tok | total tok |
|---|--:|--:|--:|
| mono-small (Nova-Pro) | 0.077 | 1.98M | 1.98M |
| mono-large (gpt-5.5) | 0.692 | 0.07M | 0.65M |
| oracle-cascade | 0.692 | 2.04M | 2.60M |

### Findings

**F1 — Both pairs are structurally dead; the oracle inequality fails on *both* cost axes.** For neither pair does the oracle cascade Pareto-dominate mono-large — provable from two mono runs, with no signal, no τ-sweep, no seed-selected slice. This one check would have pre-empted the entire docs/54, 59–61 effort.

**F2 — On honest compute, the small tier is not cheaper.** haiku uses ~the *same* fresh compute as gpt-5.5 (0.07M vs 0.06M) at *lower* quality → it is **Pareto-dominated**, so there is no cost reason to route to it. Its apparent 3× cheapness (1.91M vs 0.64M total) is **96% cache-reads** — a $-price artifact of haiku's long cache-heavy trajectories, exactly the §8.1 "local is free" confound. Nova-Pro is worse: **28× the fresh compute** for near-zero quality.

**F3 — The cheap tier solves ~nothing *uniquely*.** small-only = 1 (haiku) and 0 (Nova). Frontier expansion requires the cheap tier to *own* a real slice of tasks it solves cheaply; here it owns essentially none. haiku's failures are a superset of gpt-5.5's; Nova solves a strict subset of ~nothing.

**F4 — The method reproduces *and explains* the negatives.** docs/61 found "cascade tied-to-dominated; cost driven by handoff bloat." Phase 0 shows the structural cost already loses before handoff bloat is added — the cheap tier costs more than it saves even when run cold and escalated by an oracle. Handoff bloat is a second, additive problem, not the root cause.

## 4. Phase 1 — the real experiment: single-shot code-gen + test signal

Measure Q1/Q2 cleanly on a **cheap, single-shot, graded, code-relevant** surface — no agent loop, no sandbox-per-trial, no binary-at-n=1 noise: **HumanEval / MBPP**.

- **Tasks:** 164 HumanEval (+ ~500 MBPP to scale); each = prompt + hidden tests.
- **Models:** cheap C (a genuinely small *coder* — Qwen-Coder if reachable; else the current pool) vs E (gpt-5.5); *k*=5 samples each.
- **Per generation log:** `correct` (hidden tests), tokens (split), and signals — `sig_visibletests` (docstring examples pass), `sig_selftests` (model's own generated tests pass — the TEX / RO4 mechanism), `sig_selfconsistency` (agreement across k), `sig_confidence`, `sig_judge`.
- **Analyze** with §2: signal AUC → oracle frontier → real-signal frontier → controls.

This isolates the mechanism: the small model only writes one function, so "can it drive the loop" stops masking "is there signal," and test-execution is local and free.

### 4.1 Phase 1 results — the first positive signal

Ran `eval/experiments/humaneval-signal.ts` on all 164 HumanEval, llama-3.1-8b (cheap) vs gpt-5.5 (large), 1 seed, single-shot.

| | resolve | mean fresh tok/problem | sig_visible AUC |
|---|--:|--:|--:|
| Llama-3.1-8B | 0.604 (99/164) | 234 | **0.874** |
| gpt-5.5 | 0.970 (159/164) | 394 | 0.951 |

Structure: both-solve=98, llama-only=1, **gpt-only=61**, neither=4. Oracle-cascade quality = 0.976.

**F5 — the first Goldilocks pair.** Unlike every SWE pairing (haiku too strong / Nova too weak), the small tier solves the **majority** (0.60) with a real gap to the large (0.97). Llama-8B clears the easy slice; the 61 gpt-only tasks are the exploitable gap.

**F6 — the escalation signal works (Q2 answered positively for the first time).** `sig_visible` AUC = **0.874** on Llama-8B — the cheap docstring-example signal discriminates its correct completions from its wrong ones, so a cascade can route on it. (Coverage 72/164 — only problems with `>>>` examples; self-test / self-consistency signals would extend the other 56%.)

**F7 — frontier expansion on the honest compute axis, not token-count.** On raw token COUNT the cascade loses (single-shot tokens are ~equal; oracle 418 > gpt 394 — you always run the cheap tier then escalate). But on **FLOPs (params × tokens)** — the iso-compute axis (§8.1) — Llama-8B (8B params) is ~10–50× cheaper per token, so the oracle cascade Pareto-dominates mono-gpt at every plausible gpt-5.5 size: same 0.976 quality at **~2× fewer FLOPs** (gpt≈70B: 15k vs 28k; gpt≈400B: 75k vs 157k). The win lives entirely on the compute axis — exactly what the honest-cost mandate predicts, and the opposite of the SWE pairings where the oracle inequality failed on *both* axes (F1).

**Why it worked where SWE didn't:** single-shot removes the agentic token bloat that erased haiku's compute advantage (docs/61), and Llama-8B is a genuinely small open-weight model — a real param gap → a real FLOPs gap the cheap tier can bank on the easy slice.

**Caveats (what Phase 1 does *not* yet show):** (a) the FLOPs win uses an *estimated* gpt-5.5 param count (proprietary) — the clean claim needs two **open-weight** models with known params (Phase 1.5: e.g. Qwen-Coder-7B vs 32B, or Llama-8B vs 70B). (b) The signal covers 44% of problems. (c) Single-shot code-gen, not agentic SWE — transfer is Phase 2.

## 5. Phase 2 — transfer to agentic SWE (only if Phase 1 signal is good)

Reuse the existing SWE harness, but run each model **once** and do the **offline** policy sweep instead of live per-policy runs; log the escalation signal we already build (authored-repro + compile gate). Same cost as one screen (~$40–100), then every τ/router is free — and the live-vs-offline cost gap directly quantifies handoff bloat (§2 decomposition).

## 6. Build + cost

- **Reuse:** the transports, cost telemetry (per-model tokens + cache%, TE-14/15), E2B/local backends.
- **Build:** (a) a HumanEval/MBPP single-shot adapter in swarmkit-eval (generate → run tests → emit the row schema); (b) `eval/analysis/offline-frontier.ts` (reads `results.jsonl` → AUC + the four frontiers + the oracle pre-check). ~1 day.
- **Cost:** Phase 0 **free** (done); Phase 1 ~**$5–30**; Phase 2 ~**$40–100** if pursued.

## 7. The reusable contribution: the oracle pre-check gate

Independent of the frontier study: **before any cascade/routing study on a model pair, run the two monoliths once and check the oracle inequality `cost(C) < p_C · cost(E)` on an honest compute axis.** If it fails, the pair cannot support frontier expansion — stop before spending on signals, τ-sweeps, or seeds. Phase 0 shows this would have diagnosed both haiku↔gpt-5.5 and Nova↔gpt-5.5 immediately.
