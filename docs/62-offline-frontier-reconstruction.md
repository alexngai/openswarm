# 62 — Offline frontier reconstruction + escalation-signal AUC

**Status:** methodology + Phase 0/1/1.5/2 results. First positive frontier expansion on a clean known-params pair, replicated across HumanEval + MBPP (§4.2, F5–F11); Phase 2 (§5.2, F12–F16) shows the oracle pre-check **transfers to agentic SWE** (Qwen-Coder 3B/35B, FAIL→PASS vs the dead haiku/Nova pairs) — a robust *structural* positive across hard-18 / easy-16 / combined-34 slices (oracle Pareto-dominates mono-large on FLOPs everywhere; ~1.3× magnitude). The first *deployable*-signal attempt (authored-repro, F16) degenerated (AUC 0.500) — a runnable agentic cascade is not yet demonstrated. Extends 50 (the thesis), 54/59/60/61 (the live-experiment line that reached "H2.1 not robustly supported").

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

### 4.3 Signal comparison — a 100%-coverage deployable signal (2026-07-25)

Caveat (b) resolved. Comparing oracle-free signals on Llama-8B × 164 HumanEval (`HE_SIGNALS=1`; each signal computed from the model's own output, no oracle):

| signal | AUC | coverage |
|---|--:|--:|
| `sig_visible` (docstring `>>>` examples) | 0.896 | 43% |
| **`sig_selftests`** (model writes asserts for its own function → run them) | **0.841** | **100%** |
| `sig_judge` (model self-scores P(correct)) | 0.662 | 100% |
| **combined** (visible where available, else self-tests) | **0.876** | **100%** |

**F15 — self-authored tests are a full-coverage deployable signal.** `sig_selftests` — the single-shot analog of the agentic **authored-repro** gate — discriminates the cheap tier's correct completions from its wrong ones at AUC 0.841 over *every* problem (0.812 even on the 57% with no docstring). The combined signal reaches 0.876 at 100% coverage, ≈ `sig_visible`'s 0.896 but everywhere. `sig_judge` is weak — the model is overconfident about its own code, so self-assessment barely beats chance. This validates the authored-test mechanism for the Phase 2 §5.2 deployable-signal work (open item a): route on the model's own test outcomes, not its self-rated confidence.

### 4.2 Phase 1.5 results — the clean known-params pair

Phase 1's FLOPs win rested on an *estimated* gpt-5.5 param count (§4.1 caveat a). Phase 1.5 removes it: both tiers are open-weight with **known** params — **Llama-3.1-8B** (C, 8B) vs **Llama-3.3-70B** (E, 70B), same `awsbedrock/` transport, all 164 HumanEval, single-shot, 1 seed. Analyzer: `eval/analysis/humaneval-frontier.ts` (durable + unit-tested; the §4.1 numbers had lived only in an ephemeral script).

| | resolve | mean FLOPs/task | mean fresh tok/task |
|---|--:|--:|--:|
| mono-C (Llama-8B) | 0.598 | 3.8 TFLOP | 236 |
| mono-E (Llama-70B) | 0.829 | 40.0 TFLOP | 286 |
| oracle cascade | 0.848 | 21.3 TFLOP | — |

Structure: both-solve=95, small-only=**3**, large-only=41, neither=25. `sig_visible` AUC = **0.887** (72/164 coverage). (2 cheap-tier cells were test-exec ETIMEDOUTs scored `correct=0` — a conservative bias *against* the cheap tier, so it can't inflate the result.)

**F8 — the oracle pre-check PASSES on a clean known-params pair.** `cost(C) 3.8 < resolve_C(0.598)·cost(E) 40.0 = 23.9 TFLOP`: the always-paid cheap compute is well under the expected large-tier compute it saves. The gate that killed both SWE pairs (F1) clears here with **no estimated param** — the FLOPs ratio is the exact 8/70. The oracle cascade Pareto-dominates mono-large (0.848 ≥ 0.829 at **1.88× fewer FLOPs**).

**F9 — the *deployable* signal cascade also Pareto-dominates mono-large, not just the oracle.** Sweeping τ on `sig_visible` (null signal ⇒ escalate), the real cascade reaches **0.835 quality @ 20.0 TFLOP** (τ≈0.25) — *above* mono-E's 0.829 and at ~half its 40.0 TFLOP. Phase 1 demonstrated only the oracle ceiling; here a signal you can compute at runtime wins outright. Escalation rate is 65%, inflated by the 56% of tasks with no doctest signal (all force-escalated) — so this is a floor, not the best achievable.

**F10 — unique ownership is not the mechanism; a real compute gap on the shared easy slice is.** small-only=3: the cheap tier owns almost nothing uniquely — the same signature as the dead SWE haiku pair (small-only=1, F3). Yet this pair expands the frontier, because Llama-8B is a genuine ~10× FLOPs discount on the **95 both-solve** tasks, whereas haiku's *fresh compute wasn't actually lower* (F2), so routing the shared slice to it saved nothing. The frontier win comes from cheaply clearing the easy slice, not from owning a unique one.

**MBPP replication (427 tasks) — the result holds and strengthens at scale.** Same pair, same harness, on the sanitized MBPP set (`eval/experiments/mbpp-signal.ts` + `mbpp_exec.py`; each problem's `test_list` is split — the first assert is shown to the model and becomes the signal, the rest are held out as the hidden oracle, so signal coverage is ~100% vs HumanEval's 44%).

| Llama-8B (C) / Llama-70B (E) | HumanEval (164) | MBPP (427) |
|---|--:|--:|
| resolve C / E | 0.598 / 0.829 | 0.677 / 0.838 |
| sig_visible AUC (on C) | 0.887 (44% cov) | 0.886 (**100% cov**) |
| oracle cascade | 0.848 @ 21.3 TFLOP (1.88×) | 0.869 @ 11.2 TFLOP (**2.23×**) |
| deployable signal cascade | 0.835 @ 20.0 TFLOP | **0.838 @ 9.5 TFLOP (2.63×)** |
| oracle pre-check | PASS | PASS |

**F11 — the positive replicates on a second benchmark; the *deployable* cascade matches mono-large quality at 2.6× less compute.** The cheap-tier signal AUC is essentially identical across benchmarks (0.886 vs 0.887) — it generalizes. With MBPP's ~100% signal coverage the deployable cascade (escalate iff the completion fails its one shown assert; the binary signal makes every τ∈(0,1] identical) recovers **mono-large's exact quality 0.838 at 9.5 TFLOP — 2.63× fewer FLOPs than the 24.9 TFLOP monolith**, escalating only 27%. Structure both=276, small-only=13, large-only=82, neither=56 — the same shape as HumanEval (cheap tier owns little uniquely, wins by clearing the shared easy slice cheaply, F10). 4/854 cells were exec ETIMEDOUT/SyntaxError, scored `correct=0` (conservative).

**Still open after 1.5:** (a) the large tier in this pair (Llama-70B, 0.83–0.84) is weaker than gpt-5.5 (0.970) — the *structural* claim now holds on clean known-params across two benchmarks, but a strong-large known-params pairing (Qwen-Coder 7B vs 32B) would pin both ends. (b) The 44%-coverage limit is resolved on MBPP (split-assert ⇒ ~100%), but the MBPP signal is *binary* (one shown assert) — a multi-assert or self-test signal would give a finer τ-curve and let more borderline cheap wins stay cheap. (c) Still single-shot, not agentic (Phase 2). (d) 1 seed; ≥3 seeds would harden the per-task labels.

## 5. Phase 2 — transfer to agentic SWE (only if Phase 1 signal is good)

Reuse the existing SWE harness, but run each model **once** and do the **offline** policy sweep instead of live per-policy runs; log the escalation signal we already build (authored-repro + compile gate). Same cost as one screen (~$40–100), then every τ/router is free — and the live-vs-offline cost gap directly quantifies handoff bloat (§2 decomposition).

### 5.1 Phase 2 pair selection + agentic gate (2026-07-24)

The clean Phase-1.5 Llama-8B/70B pair **cannot** be used agentically: Llama-3.1-8B is streaming-tool-use-blocked on Bedrock in our stack (commit 239cb4e), so the cheap tier can't drive the tool loop; and the only keyless tool-capable pairs already captured (haiku↔gpt-5.5, Nova↔gpt-5.5) are structurally dead (§3). Enumerating the Bedrock catalog surfaced a better option **with no new credential**: **Qwen3-Coder is on Bedrock on-demand** (`awsbedrock/qwen.qwen3-coder-30b-a3b-v1:0`, 3B active — and `…-480b-a35b-v1:0`, 35B active) — same-family agentic coders, a ~12× active-param FLOPs gap.

Gate results (all pass): both models stream via the `awsbedrock/` transport; **both drive tool-use** (`eval/scripts/bedrock-toolcheck.ts` — `tool-input-start → tool-call → finish`, valid parsed args) — the Llama-8B blocker is gone; and single-shot HumanEval confirms a Goldilocks pair — mono-C 0.811, mono-E 0.933, **oracle 0.945 @ 3.46× fewer FLOPs**, oracle pre-check PASS (1.6 < 0.811·19.4 TFLOP). (Small-tier resolve is understated by ~15 fence-extraction SyntaxErrors — a single-shot harness artifact the agentic loop doesn't share.) → cleared for the agentic offline-once run.

### 5.2 Phase 2 results — agentic SWE, the pre-check transfers (2026-07-24)

Ran the Qwen-Coder pair agentically on **18 baked SWE-bench-Verified instances** (self-hosted docker on the EC2 box, `CS_ARM=mono-small,mono-large`, 1 seed, `us-west-2`). Each model once; the offline oracle frontier + FLOPs pre-check via `eval/analysis/swe-cells-to-rows.ts` → `humaneval-frontier.ts` (SWE cell fresh tokens × active params — the honest axis `offline-frontier.ts` lacks).

| Qwen3-Coder 3B-A3B (C) / 480B-A35B (E) | value |
|---|---|
| resolve C / E | 0.333 / 0.333 (6/18 each) |
| mean FLOPs/task C / E | 3.46 / 74.6 TFLOP (**21.5×** — 12× params × ~1.85× agentic tokens) |
| oracle cascade | 0.389 @ 53.7 TFLOP |
| structure | both=5, small-only=1, large-only=1, **neither=11** |
| oracle pre-check (FLOPs) | **PASS** (3.46 < 0.333·74.6 = 24.9) |
| oracle dominates mono-large | YES (0.389 ≥ 0.333 at **1.4× fewer FLOPs**) |

**F12 — the oracle pre-check transfers to agentic SWE (FAIL→PASS vs the dead pairs).** haiku↔gpt-5.5 and Nova↔gpt-5.5 FAILED the pre-check on SWE (F1, structurally dead); the Qwen-Coder pair **PASSES** on the same agentic surface — a genuinely small tier (3B active) with a real FLOPs gap flips the inequality. First positive transfer of H2.1 beyond single-shot, and the agentic-loop pipeline itself works end-to-end for a small open-weight tool-driver (both tiers real usage, real scores; the Bedrock tool-use gate was the enabler).

**F13 — but the magnitude is modest and the slice is hard.** Only 7/18 instances are solved by anyone (**neither=11** — the baked slice skews hard); the oracle gain is **+1 task** (django-16032, large-only) and the small tier owns just 1 unique task (xarray-2905). The 1.4× FLOPs expansion is far below single-shot's 3.46×, because agentic escalation pays the large tier on 12/18 tasks — 11 of which fail anyway, wasting the compute. And this is the **oracle ceiling**: no deployable escalation signal yet (the SWE repro/compile-gate isn't extracted into the rows; `sig_visible=null` ⇒ the τ-sweep degenerates to the oracle).

**F14 — a less-hard slice firms up the transfer (structure is real, not a 1-task artifact).** The F13 slice was too hard (neither=11/18). Re-running on **16 easy-difficulty instances** (`difficulty="<15 min fix"`) lifts solve rates to mono-C 0.438 / mono-E 0.563 with genuine structure — both=5, **small-only=2**, large-only=4, neither=5 (11/16 solvable). The oracle cascade reaches **0.688 @ 47.8 TFLOP vs mono-E 0.563 @ 62.7 TFLOP — +0.125 quality AND 1.31× fewer FLOPs** (pre-check PASS: 3.67 < 0.438·62.7 = 27.4). Combined 34-instance frontier: mono-C 0.382 / mono-E 0.441 / oracle **0.529 @ 50.9 TFLOP** (1.35× fewer, +3 tasks; structure both=10/small-only=3/large-only=5/neither=16). The cheap tier now owns a real unique slice, and oracle Pareto-dominance holds on **every** slice (hard-18, easy-16, combined-34). The FLOPs magnitude (~1.3×) stays below single-shot's 3.5× — agentic escalation still pays the large tier on the ~55% escalated fraction — but the structural positive is now robust.

*(Infra note: baking SWE instances is disk-bound — the m7i.4xlarge's 194 GB root holds ~16 instances' base+template images; 34 thrashes it into unkillable-I/O and needs an EBS reboot to recover. Run ≤~16 instances per pass, or grow the volume. See [[hard-slice-run-ops]].)*

**F16 — the deployable authored-repro signal degenerates (honest negative).** Instrumented the mono arms to author a repro + log the compile/repro confidence (`CS_SIGNAL=1`, `cascade-adapter.ts` `signalCommands`), re-ran easy-16. Result: `sig_repro` is **constant 0.5 for all 16 small-tier cells** (compile-gate passes, repro-gate fails on *every* cell incl. the 5 correct ones) → **AUC 0.500, zero discrimination**; the τ-sweep degenerates to all-small (τ≤0.5) or all-escalate (τ>0.5) — no runnable cascade. Two contributing causes: (i) repro-first prompting *lowered* the 3B coder's solve rate (0.438→0.313 — it's capacity-strained); (ii) the post-hoc gate runs `REPRO_CMD` after the topology, when the untracked `/testbed/repro_test.py` has likely been git-cleaned (the docs/52 scratch-wipe hazard) or was never authored — so the repro gate fails regardless of correctness. Contrast single-shot `sig_selftests` on a lone function (AUC 0.841, F15): the agentic setting (large repo, git operations, a capacity-strained 3B coder) breaks the authored-test mechanism. **The oracle-ceiling result (F12–F14) stands; a *deployable* agentic cascade is NOT demonstrated.** To salvage: compute the confidence **in-topology** (as the live cascade arm does, at the moment the repro exists — needs the CLI to emit it), author the repro **outside** /testbed (git-clean-immune), or use a signal that doesn't depend on repro authoring (self-consistency).

**Still open after Phase 2:** (a) a *working* deployable signal (F16 negative — repro-gate degenerate; try in-topology confidence, git-clean-immune repro path, or self-consistency); (b) ≥3 seeds (all slices are 1-seed); (c) the offline cold-E cost excludes live handoff bloat (docs/61 F3), so a live cascade would cost more — bound it; (d) the ~1.3× agentic FLOPs magnitude is modest vs single-shot. The transfer is a robust *structural* positive (oracle ceiling); a deployable policy is not yet shown.

## 6. Build + cost

- **Reuse:** the transports, cost telemetry (per-model tokens + cache%, TE-14/15), E2B/local backends.
- **Build:** (a) a HumanEval/MBPP single-shot adapter in swarmkit-eval (generate → run tests → emit the row schema); (b) `eval/analysis/offline-frontier.ts` (reads `results.jsonl` → AUC + the four frontiers + the oracle pre-check). ~1 day.
- **Cost:** Phase 0 **free** (done); Phase 1 ~**$5–30**; Phase 2 ~**$40–100** if pursued.

## 7. The reusable contribution: the oracle pre-check gate

Independent of the frontier study: **before any cascade/routing study on a model pair, run the two monoliths once and check the oracle inequality `cost(C) < p_C · cost(E)` on an honest compute axis.** If it fails, the pair cannot support frontier expansion — stop before spending on signals, τ-sweeps, or seeds. Phase 0 shows this would have diagnosed both haiku↔gpt-5.5 and Nova↔gpt-5.5 immediately.
