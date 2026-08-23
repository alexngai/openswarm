# 54 — Hard-slice findings: the capability gap that wasn't

**Status:** findings (eval results). Extends 50/51 (cost-frontier study), 52 (handoff fidelity), 53 (token-efficiency telemetry).
**Run:** 2026-07-10/11, cascade-swe on E2B, 13 instances × 6 arms × 2 seeds = 156 cells, harness packed from `359b9c5` (includes docs/52 Phase A+B, docs/53 TE-1..18). Raw cells in `.eval-runs/cache/`; analyzer: `tsx eval/analysis/cost-frontier.ts`.

## 1. Why this run

The docs/50 discrimination runs and the 2026-07-09 re-baseline both saturated: every mono arm at 1.00, cascades never escalating — no headroom to measure whether coordination expands the frontier. This run moved to a **gap-selected hard slice**: 20 candidates from SWE-bench Verified's `1–4 hours` difficulty bucket were screened with a mono-small-only pass (`CS_ARM=mono-small`); mono-small solved **5/20 (25%)**. The final slice: 8 screened mono-small-failures + 4 continuity holdovers (pytest-6197, django-12708, sympy-11618, astropy-7336) + sphinx-9229 as a too-hard anchor.

Arms: mono-small (haiku/Bedrock), mono-large (gpt-5.5/Azure), cascade-τ0.3, cascade-τ0.5 (authored-repro + compile composite gate), advisor (cold critic-loop), advisor-resident (docs/52 Phase B ①a, `CS_RESIDENT=1`). Gate semantics: escalate when confidence < τ — **τ0.3 is the *reluctant* setting, τ0.5 the eager one.**

## 2. Results

| Arm | Success (95% CI) | Tokens (13 tasks × 2 seeds) | Escalated |
|---|---|---|---|
| mono-small | 0.31 [0.08–0.54] | 75.2M | — |
| mono-large | 0.31 [0.08–0.54] | 22.6M | — |
| cascade-τ0.3 | 0.31 [0.08–0.54] | 54.1M | 9/21 recorded (~43%) |
| cascade-τ0.5 ★ | 0.31 [0.08–0.54] | 21.9M | 22/25 recorded (~88%) |
| advisor | 0.19 [0.04–0.38] † | 28.3M | — |
| advisor-resident | 0.04 — **INVALID** ‡ | 2.1M | — |

★ non-dominated on the report's accuracy–tokens frontier. † infra-confounded (§5). ‡ malfunction (§6).

Per-task quality (mean of 2 seeds; screened gap tasks first):

| Task | m-small | m-large | τ0.3 | τ0.5 | advisor |
|---|--:|--:|--:|--:|--:|
| astropy-13398 | 0 | 0 | 0 | 0 | 0 |
| django-10554 | 0 | 0 | 0 | 0 | 0 |
| django-11400 | 0 | 0 | 0 | 0 | 0 |
| pylint-4551 | 0 | 0 | 0 | 0 | 0 |
| pytest-10356 | 0 | 0 | 0 | 0 | 0 |
| **scikit-25102** | **0** | **0** | **1.0** | **1.0** | 0.5 |
| sphinx-11510 | 0 | 0 | 0 | 0 | 0 |
| sympy-13852 | 0 | 0 | 0 | 0 | 0 |
| pytest-6197 (holdover) | 1.0 | 1.0 | **0** | **0** | 0 |
| django-12708 (holdover) | 1.0 | 1.0 | 1.0 | 1.0 | 0.5 |
| sympy-11618 (holdover) | 0.5 | 1.0 | 1.0 | 1.0 | 1.0 |
| astropy-7336 (holdover) | 1.0 | 1.0 | 1.0 | 1.0 | 0.5 |
| sphinx-9229 (anchor) | 0 | 0 | 0 | 0 | 0 |

## 3. Findings

**F1 — The small↔large capability gap is ~zero on the 1–4h bucket.** mono-small and mono-large tie at 0.31 with identical CIs. Screening guaranteed mono-small fails these tasks; mono-large fails them too. The regime escalation architectures need — cheap fails, expensive rescues — barely exists here: of 8 screened tasks, mono-large rescued **zero**. Model scale (haiku → gpt-5.5) does not buy resolve-rate on this difficulty bucket; the binding constraint is something else (task comprehension, exploration strategy, repo scale).

**F2 — Cascades tie the monoliths; doubling the escalation rate changed nothing on quality and *reduced* tokens.** τ0.5 escalated ~88% of gated cells, τ0.3 ~43% — quality identical (0.31 both, = both monos). Escalation neither rescued nor harmed on net. Notably τ0.5 (more escalation) used ~2.5× fewer tokens than τ0.3: handing off early terminates the cheap tier's long unproductive exploration, and the large tier resolves-or-fails quickly. **Escalation is a cost-shaping lever even when it is quality-neutral.** cascade-τ0.5 is the token-frontier point of the run (21.9M vs mono-large's 22.6M at equal quality — a wash vs. just starting with the large model, per F1).

**F3 — Coordination changes outcomes in BOTH directions; net zero, n too small to attribute.** scikit-25102: both cascades solved (both seeds consistent on τ0.5) what both monoliths failed — the single frontier-expanding cell of the run; plausibly the authored-repro prompt discipline, not escalation per se (advisor, which shares the repro prefix, got 0.5 there too). pytest-6197 inverted the other way: both monos 1.0 this run, both cascades 0. Combined with the seed-to-seed flips (pytest-6197 was mono-small 0.25 in the 07-09 run, 1.0 now), per-task variance is comparable to any architecture effect at n=2 seeds.

**F4 — The docs/53 telemetry chain validated in production.** Fresh mono-large cells run **88–95% cache-read** (structurally 0% before TE-16/18). Gap-task mono-large cells cost ~$1.2–3.5 despite million-token contexts, vs $9.6–21 for equivalent pre-fix cells. All cost/token numbers above are the first from a fully honest pipeline (cache capture TE-16/18, disjoint usage normalization + cache-aware pricing TE-17).

**F5 — Advisor (cold) is infra-confounded, read as ≤0.19, not =0.19.** A minority of advisor cells are zero-token env-error records (E2B sandbox deaths, contained per-cell by `359b9c5` instead of crashing the sweep) that count as failures. Its consult log elsewhere shows healthy behavior (mostly approvedAt=1 on solvable tasks). Re-run the arm after the sandbox-stability items land before comparing.

**F6 — advisor-resident (docs/52 Phase B ①a) did not run: 22/26 cells zero-token with empty output.** The resident-dialogue path silently no-ops in the packed CLI under `openswarm topology critic-loop`. The coordination-fidelity A/B is **unanswered, not negative**. Debug task filed; re-run both advisor arms (~$30–60) once fixed.

## 4. Implications for docs/50

- **H2.1 (cascade Pareto-expands vs monolith):** not supported on this slice — but the slice turned out to test the wrong regime. The honest restatement: *within a difficulty bucket where the model pair has no capability gap, no routing policy between them can expand the frontier.* The hypothesis needs a slice with a demonstrated gap (see §5).
- **H2.3 (escalation ROI localizes):** the τ-sweep now has real signal — escalation rate is a strong *cost* lever (F2) with per-tier attribution available (`perModelCost`), but ΔQ ≈ 0 here, so ROI on quality is undefined on this slice.
- The scikit-25102 cell is the study's first coordination-rescues-task observation; worth a transcript autopsy before drawing anything from it.

## 5. Next steps

1. **Dual-screen slice selection**: the necessary regime is mono-small-fails AND mono-large-succeeds. This run shows the 1–4h bucket yields ~0 such tasks for this model pair; screen the `15 min–1 hour` bucket (261 instances) instead — run BOTH mono screens (~$40) and keep the intersection. If that bucket also yields few, the honest conclusion is that this model pair has no exploitable gap on SWE-bench Verified, and the study pivots to a wider capability spread (e.g., a small open-weight model vs gpt-5.5, per docs/50 §9.4).
2. **Fix + re-run the advisor pair** (F5/F6) for a valid coordination A/B.
3. **Transcript autopsy of scikit-25102** (both cascade cells) and pytest-6197 (cascade failures): what did the repro-first discipline change?
4. Seeds ≥3 on any future decisive run — F3's variance swamps n=2.

## Appendix — run reliability notes

Five launches were needed: (1) stale-cwd launch error; (2) E2B template-build status-poll timeout crashed the process; (3) one sandbox death (`SandboxError: terminated`) crashed the whole sweep → fixed by per-cell containment in both adapters (`359b9c5`); (4) `CS_SANDBOX_TIMEOUT_MS` above E2B's 1-hour cap → 400 at provision; (5) E2B 20-concurrent-sandbox rate limit from **474 orphaned sandboxes** accumulated by the crashed runs (a crashed parent never releases in-flight sandboxes) → bulk-killed via SDK, then clean completion. Follow-ups: orphan-sandbox cleanup at experiment start; provision-time errors are still uncontained (upstream of the adapters, in swarmkit-eval's `runCell`).
