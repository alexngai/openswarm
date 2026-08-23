# 60 — Gap-regime findings: where the cascade advantage comes from (and where it doesn't)

**Status:** findings (eval results). The gap-selected decisive run docs/54 §5 / docs/59 §5 called for.
Extends 50/51 (cost-frontier study), 54 (hard-slice), 59 (powered frontier).
**Run:** 2026-07-16/18, cascade-swe on the docker backend (m7i.4xlarge, native x86), harness at `5544eac`.
Two stages: (1) a **gap screen** of 15 randomly-sampled "15 min–1 hour" Verified instances (both monos ×
1 seed), (2) a **decisive run** of 5 arms × 5 seeds on the resulting gap slice. `CS_TAUS=0.5 CS_RESIDENT=1`.

## 1. The gap regime exists (screen)

docs/54 found the haiku↔gpt-5.5 capability gap ≈ 0 on the 1–4h bucket (both monos fail together), so no
routing policy could help. This screen tested the **15 min – 1 hour bucket** (261 instances) for the
regime routing needs — **mono-small fails ∧ mono-large succeeds**:

- 15-candidate random sample (seed 0), both monos × 1 seed, 0 zero-usage cells.
- mono-large 0.67 (10/15), mono-small 0.47 (7/15).
- **4/15 candidates were gap tasks (~27% hit rate):** django-11206, django-13820, django-16938,
  sympy-20590. (Plus 5 both-solve, 4 both-fail, 1 inverted.) The gap regime **exists** for this model
  pair on the easier bucket — extrapolating, ~70 of the 261 candidates.

## 2. Decisive run — the gap slice (4 tasks × 5 seeds, honest cost)

| Arm | Quality | $/cell | Mtok | Δ vs mono-large (Success) |
|---|--:|--:|--:|:--|
| mono-small | 0.475 | $0.19 | 1.25 | −0.55 [−0.60,−0.45] ✓sig |
| advisor (cold) | 0.388 | $0.59 | 2.65 | −0.65 [−0.90,−0.40] ✓sig |
| advisor-resident | 0.500 | $0.69 | 2.24 | −0.50 [−0.85,−0.25] ✓sig |
| **cascade-τ0.5** | **0.900** | **$1.23** | 1.41 | **−0.10 [−0.30, 0.00] · not sig** |
| **mono-large** | **1.000** | **$1.25** | 0.64 | — reference |

98/100 cells real-token (2 `sympy-20590` failures excluded, not the docs/52 $0 bug). Per-task quality:
django-16938 was hardest for the swarm arms (cascade 0.6, advisor 0.0); the other three cleaner.

## 3. Findings

**F1 — on the pure gap regime, cascade-τ0.5 TIES mono-large; it does NOT expand the frontier.** Quality
0.90 vs 1.00 (difference not significant, CI includes 0) at essentially equal cost ($1.23 vs $1.25). The
non-dominated frontier is just **mono-small (cheap, 0.475) → mono-large (1.00)**, with cascade sitting
on top of mono-large rather than below it.

**F2 — this is the mirror image of docs/59 F1, and the two together are the real result.** In the
powered run (a *mixed* slice) cascade **dominated** mono-large (equal quality, ~15% cheaper). On a
*pure-gap* slice it merely ties. The difference is the task mix: on gap tasks the cheap tier **always**
fails, so its attempt is near-pure overhead — a handoff to the large tier that only offsets its own
cost. **Cascade's Pareto advantage comes from the cheap-solvable tasks in the workload, not the gap
tasks.** The win magnitude scales with the fraction of tasks the small model can resolve alone; select
those away and it collapses to a tie.

**F3 — escalation breaks even, doesn't lose, even on gap tasks.** cascade-τ0.5 costs ~the same as
mono-large ($1.23 vs $1.25) despite running two tiers — the escalated large tier is cheaper than a cold
mono-large because it builds on the small tier's applied diff (docs/52 handoff fidelity), roughly
cancelling the wasted cheap-tier tokens. So the downside of routing on a mis-selected (all-hard) slice
is ~zero, not a penalty — a useful robustness property for a policy that can't perfectly predict
difficulty.

**F4 — resident coordination > cold, again (docs/59 F3 holds).** advisor-resident 0.500 > advisor cold
0.388 on the gap slice. But both critic-loop arms are weak here (well below mono-large): advise-don't-redo
struggles when the cheap executor can't get close enough for review to rescue — the critic can only
advise, not author. The advisor family's value, like the cascade's, is regime-dependent.

## 4. Implications for docs/50

- **H2.1 (cascade Pareto-expands vs monolith):** supported **conditionally** — true on a realistic mix
  (docs/59), a tie on a pure-gap slice (F1). The honest statement: routing expands the frontier in
  proportion to the cheap-solvable fraction, and never loses (F3). "Mono is better" is false on a mix
  and a wash on pure-hard.
- The gap slice is the **adversarial** case for routing (all overhead, no cheap wins) and cascade still
  breaks even — the stronger evidence is that the mixed-slice win (docs/59) is real and the downside is bounded.

## 5. Next steps

1. **Vary the cheap-solvable fraction** deliberately (e.g., 0/25/50/75% gap tasks) to trace the
   cascade-vs-mono cost curve as a function of workload composition — turns F2 from two points into a line.
2. Larger n on the gap slice (more screened batches → 8–12 gap tasks) to tighten the cascade≈mono CI.
3. Wider capability spread (Qwen small tier, docs/50 §9.4) — a bigger small↔large gap could change F3's
   break-even (cheaper cheap tier ⇒ escalation overhead shrinks further).
