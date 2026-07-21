# 57 — Composition sweep: the cascade win doesn't replicate on a random slice

**Status:** findings (eval results). The workload-composition sweep docs/56 §5 called for.
Extends 50 (cost-frontier study), 54 (hard-slice), 55 (powered), 56 (gap-regime).
**Run:** 2026-07-21, cascade-swe on the docker backend (m7i.4xlarge), harness at `01730a7`. Two 5-arm ×
5-seed pools of 4 tasks each = **200 cells** (98% real-token): a "cheap-solvable" pool
(django-12858, matplotlib-14623, scikit-25931, sympy-24213) + the reused docs/56 gap pool.

## 1. Design and the methodological catch

Goal: trace cascade-vs-mono-large cost as a function of the cheap-solvable fraction `f`. Aggregate cost
is exactly linear in composition, so the plan was to measure two endpoints — a reliably-cheap pool
(`f=0`) and the gap pool (`f=1`) — and re-weight.

**It didn't separate.** The pools were selected by the docs/56 **1-seed** screen, but at 5 seeds the
"cheap-solvable" tasks scored `mono-small` **0.30** and the "gap" tasks **0.475** — nearly inverted.
`mono-small`'s per-task resolve-rate on this bucket is ~0.4 with large seed variance; **no task is
reliably cheap-solvable** (all ≤ 0.6, median 0.40). So the composition axis is truncated to the
low-`mono-small` regime, and 1-seed difficulty screening is revealed as **too noisy to classify** for
this model pair (a finding in itself).

## 2. Per-task result (8 tasks, sorted by mono-small resolve-rate)

| Task | m-sm q | cascade-τ0.5 (q, $) | mono-large (q, $) | cascade saves |
|---|--:|--:|--:|--:|
| matplotlib-14623 | 0.00 | 1.00, $2.40 | 1.00, $1.33 | **−$1.07** |
| django-11206 | 0.40 | 1.00, $0.98 | 1.00, $0.80 | −$0.19 |
| django-12858 | 0.40 | 1.00, $1.70 | 1.00, $3.05 | **+$1.34** |
| django-16938 | 0.40 | 0.60, $1.61 | 1.00, $1.73 | +$0.12 |
| scikit-25931 | 0.40 | 1.00, $1.93 | 1.00, $0.97 | **−$0.96** |
| sympy-20590 | 0.50 | 1.00, $1.17 | 1.00, $1.22 | +$0.05 |
| sympy-24213 | 0.50 | 1.00, $1.08 | 1.00, $0.99 | −$0.09 |
| django-13820 | 0.60 | 1.00, $1.17 | 1.00, $1.27 | +$0.10 |

Per-arm over all 8 tasks × 5 seeds: mono-small **q0.40 $0.21**, advisor **q0.42 $0.64**,
advisor-resident **q0.45 $0.77**, cascade-τ0.5 **q0.95 $1.51**, mono-large **q1.00 $1.42**.

## 3. Findings

**F1 — no reliably-cheap-solvable tasks for haiku on this bucket.** `mono-small` ≤ 0.6 everywhere,
median 0.40, high seed variance. haiku is a coin-flip, not a dependable cheap tier — so the cascade
rarely gets a clean "small tier solves it cheaply, skip the big model" win.

**F2 — cascade-τ0.5 does NOT beat mono-large on the random sample.** Aggregate q0.95 vs 1.00 (≈ equal,
one hard task) at **~6% higher cost** ($1.51 vs $1.42). It is weakly **dominated**. **docs/55's
dominance (equal quality, ~15% cheaper) did NOT replicate** — that result was favorable task selection
(the continuity holdovers), not a robust property.

**F3 — per-task cost is driven by handoff bloat, not by the cheap tier's success rate.** Savings ranged
−$1.07 to +$1.34 with no clean correlation to `mono-small`'s rate. When `mono-small` burns tokens and
fails, the escalated large tier inherits its whole diff+trajectory (docs/52 handoff) — so on
matplotlib and scikit the escalated tier cost **~2× a cold mono-large**. **Escalation can cost more
than just starting with the big model.** The handoff that helped in docs/56 F3 (roughly cancelling the
wasted cheap attempt) can invert into a net penalty when the cheap tier did a lot of futile work.

**F4 — the cascade needs a small tier that reliably solves a meaningful fraction; haiku doesn't.** This
is docs/54's capability-gap worry resurfacing from the cost side: the cheap tier is neither reliable
enough to avoid frequent wasteful escalation, nor cheap enough that its failed attempts + handoff bloat
stay negligible. The lever is a **cheaper and/or more reliable small tier** (the Qwen coder work,
docs/50 §9.4) — not more routing tuning.

## 4. Implications for the study

- **H2.1 (cascade Pareto-expands vs monolith): NOT robustly supported.** The evidence across three runs:
  dominant on a favorable holdover mix (docs/55), tied on a 1-seed-selected gap slice (docs/56),
  tied-to-dominated on a random bucket sample (here). The honest position: **the cascade expands the
  frontier only when the small tier reliably solves a meaningful fraction AND its handoff doesn't bloat
  — neither holds for haiku on SWE-bench Verified.** The docs/55 headline is tempered accordingly.
- **Method:** difficulty screening needs **≥3 seeds**; 1-seed labels are noise at this variance.

## 5. Next steps

1. **Trace the reliably-cheap end.** Screen the `<15 min` bucket (194 instances, multi-seed) for tasks
   `mono-small` reliably solves, to measure the regime where the cascade *should* win and complete the curve.
2. **Qwen coder small tier** (docs/50 §9.4): cheaper per token and plausibly more reliable on code —
   the most direct attack on F1/F3/F4. Groundwork already staged (uncommitted `cost-model.ts` +
   `DASHSCOPE_API_KEY`).
3. **Bound handoff cost** (F3): cap or summarize the diff+trajectory the escalated tier inherits, so a
   futile cheap attempt can't inflate the large tier past a cold run.
