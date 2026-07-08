# 51 — Eval execution plan: running the heterogeneous cost-scaling study

**Status:** Draft for discussion · **Author:** (design spike, w/ Claude) · **Date:** 2026-07-08 · **Extends:** [50](50-heterogeneous-cost-scaling.md) · **Harness:** [`eval/`](../eval) + `swarmkit-eval`

> The operational companion to [docs/50](50-heterogeneous-cost-scaling.md). docs/50 is *what* we're
> testing (the thesis, hypotheses, success criteria); this is *how it runs* — the cell/arm/grader
> structure on swarmkit-eval, the per-cell measurement contract, and the staged rollout
> (fixit-local → SWE-E2B → vLLM-GPU). The build items map back to docs/50's G1–G5 gaps.

---

## Decisions locked (2026-07-08)

1. **A cascade is ONE matrix cell** — a `CascadeAdapter`, sibling of the h1 `SwarmCoordinatorAdapter`. Reuses the whole matrix runner (resume cache, paired stats, backends). Not a bespoke chained-cell driver.
2. **Coarse τ-sweep** — 3–4 `cascade@τ` arms to locate the knee; the confirmatory run pins `τ*`.
3. **Stage order: fixit+local → SWE-subset+E2B → vLLM.** Plumb the whole pipeline cheaply first, then the real target, then the honest GPU axis.
4. **Extend G2** for per-tier cost breakdown + escalation count + wall-clock split.
5. **Cost axis by stage:** `$`/FLOPs (ApiCostModel) through Stages 0–1; GPU-seconds (SelfHostCostModel) added at Stage 2.

---

## 1. The unit of evaluation — a cascade is one cell

Building `CascadeTopology` resolved the earlier fork (matrix-arm vs custom driver) in favour of **matrix-arm**: the cascade runs as a single cell, exactly like h1's `team` arm was one `SwarmCoordinatorAdapter` cell. The topology owns the multi-tier orchestration *inside* the cell; swarmkit-eval runs the cell and grades the final workspace. The matrix keeps its familiar shape:

> **task × arm × core-model × seed**

with the *structure carried by the arm*. A cascade cell uses multiple models internally, so the matrix `model` axis is pinned (a label / the core-tier id) for cascade arms, not swept — the tier fleet lives in the arm's adapter config.

## 2. The two-grader architecture (the integrity backbone)

Every cascade cell runs **two graders with different visibility**:

```
        ┌──────────────────── one cascade cell ────────────────────┐
 tier₀ ──▶ VISIBLE grader (ScoreEvaluator.ScoreFn) ──partial<τ?──▶ tier₁ ──▶ …
           runs IN the workspace, drives escalation                   │
           visible tests / checkpoints only — never held-out          ▼
                                              SCORING grader (held-out, runs ONCE)
                                                      → the cell's quality Q
```

- **Visible grader** = a `ScoreEvaluator` whose `ScoreFn` runs a visible-only grader over the tier workspace (`confidence = Score.partial`). Drives escalation; never sees held-out.
- **Scoring grader** = swarmkit's `SweGrader`/`CheckpointGrader`, run once on the final workspace → the cell outcome.

Same benchmark, two grader configs. The visible/held-out split is the only per-benchmark piece (docs/50 §8.1); the architecture is general.

**Per-benchmark visible config:**

| Benchmark | Visible grader (confidence) | Scoring grader (outcome) |
|---|---|---|
| **fixit** | a **visible SUBSET** of checkpoints (CheckpointGrader over the subset) — graded | full CheckpointGrader (sealed post-agent checks) |
| **SWE** | **new** graded visible-regression grader: run repo tests w/o hidden patch → fraction of `PASS_TO_PASS` holding (+ optional authored repro test) | `SweGrader` (installs hidden `FAIL_TO_PASS` patch) |
| open-ended (GAIA) | verifier / self-consistency `ScoreFn` (no execution signal) | benchmark-native / self-score |

## 3. The arms

`task × arm × core-model × seed`, arms carry the treatment:

| Arm | Role | docs/50 |
|---|---|---|
| `mono-8B`, `mono-30B` | single-agent floor + target point | baselines |
| `mono-30B-bestN` | the monolith's own TTS curve — the honest thing to beat | §4.3 |
| `cascade@τ=0.3 … 0.7` | **the τ-sweep** (each τ a distinct arm) | H2.1/H2.2 |
| `hetero-roles` | 8B coder + 8B tester + 30B escalation | §4.3 |
| `cascade-random@τ*` | **RO3 control** — escalate randomly at the same rate; cascade must beat it | §3.1 |
| `cascade-selfreport@τ*` | **signal control** — self-report vs graded evaluator; shows the signal matters | §3.1 |

**Mechanism vs thesis:** Stage 0/1 heterogeneity can be *API-tier* (e.g. haiku→sonnet or gpt-4o-mini→gpt-4o) — real heterogeneity that plumbs the whole pipeline on the `$` axis without vLLM. The *small-local-model* thesis (chorus-trained Qwen 4–8B → 30B core) arrives at Stage 2 with the GPU-seconds axis.

## 4. The `CascadeAdapter` (swarmkit integration)

Sibling of `SwarmCoordinatorAdapter` ([`eval/harness/`](../eval/harness)). Per cell it:

1. Builds a `TeamSpec` — `topology: "cascade"`, ordered tier `members` (each with its `model`), `coordination.escalationTau`, `coordination.escalationEvaluator`.
2. Injects `ctx.escalation = { registry, exec, task }` — a registry holding the benchmark's `ScoreEvaluator`, `exec = workspace.run` (so the visible grader runs in the cell's E2B/local workspace), and the sealed `EvalTask`.
3. Runs `Orchestrator.runTeam(spec)`; the topology drives the tiers + escalation.
4. Returns a `RawRun` whose `submission` carries **per-tier usage, escalation count, and the confidence trace** (see §5) — so the scoring grader + G2 can price and analyse it.

The scoring grader (`GraderSpec { kind: "swe" | "checkpoint" }`) runs separately on the finished workspace, exactly as today.

## 5. The per-cell measurement contract

Every cell emits (into `RawRun.submission` / `Score.metrics` / the trace):

- **quality `Q`** — from the scoring grader.
- **per-tier usage** `[{ model, inputTokens, outputTokens, gpuSeconds? }]` — from `SwarmUsageAggregator`'s spawn-tree rollup (G1), subscribed off the cascade's lane stream. The cost side.
- **escalation count** + accepted tier id.
- **confidence trace** — each tier's visible `partial` (for RO3 ROI + RO4 signal-validity).
- **wall-clock split** `{ inference | tool/sandbox | wait }` — reconstructed from lane-event `ts` (needs `--trace-output`, docs/47 commit 5647c75).
- `{ τ, arm, model, seed, task }`.

## 6. Offline analysis (G2 extended)

[`eval/analysis/cost-frontier.ts`](../eval/analysis/cost-frontier.ts) gains:

- **per-tier cost** = Σ `CostModel.cost(tierUsage)` — dual axis (`$`/FLOPs now, GPU-s at Stage 2).
- **the frontier** — `Q` vs cost per arm; the τ-sweep curve with its knee; monolith best-of-N overlaid (docs/50 §4.5).
- **σ_d** — paired `Q` across arms/seeds (already in G2; now on real cascade data).
- **escalation-ROI** — `ΔQ / core-tier-token`; and the `cascade` vs `cascade-random` delta (RO3).
- **RO4 signal-validity** — correlate each tier's visible `partial` against the eventual cell outcome (does the cheap signal predict correctness?).

## 7. Staged rollout

Each stage is a small delta on a proven pipeline; each has an exit gate.

| Stage | Setup | Proves | Exit gate |
|---|---|---|---|
| **0 — Plumb** | **fixit + local**, API tiers (haiku→sonnet), `$`/FLOPs, coarse τ, ~2 seeds | every seam end-to-end: CascadeAdapter → aggregator → CostModel → visible-checkpoint ScoreFn → escalation → scoring grader → G2 frontier | a `(Q, $)` frontier + σ_d render from real cascade cells; escalation count varies with τ |
| **1 — Target** | **SWE-subset + E2B**, graded visible-SWE grader, API or vLLM tiers, `$`/FLOPs | the thesis on repo code; H2.1/H2.2 first signal; RO4 on SWT-Bench | a τ-sweep curve on SWE; knee identified or nulled |
| **2 — Honest cost** | **self-hosted vLLM** (Qwen 4–8B → 30B), GPU-seconds axis | the iso-compute claim; the small-local-model thesis | GPU-s frontier; the confirmatory N (docs/50 §3.1 G-power) |

## 8. Build checklist (ordered; maps to docs/50 gaps)

- [ ] **B1 — `CascadeAdapter`** ([`eval/harness/`](../eval/harness)) — §4. *(Stage 0)*
- [ ] **B2 — fixit visible-checkpoint `ScoreFn`** — a `ScoreEvaluator` over a visible checkpoint subset. *(Stage 0; docs/50 G3 follow-on)*
- [ ] **B3 — per-tier usage → `RawRun`** — subscribe `SwarmUsageAggregator` off the cascade lane stream, emit per-model totals + escalation count into `submission`. *(Stage 0; G1↔eval)*
- [ ] **B4 — G2 extensions** — per-tier cost, τ-sweep curve, escalation-ROI, RO4 signal-validity, wall-clock split. *(Stage 0; G2)*
- [ ] **B5 — graded visible-SWE regression grader** — repo tests w/o hidden patch → `PASS_TO_PASS` fraction. *(Stage 1; docs/50 G3 follow-on)*
- [ ] **B6 — vLLM serving + GPU-seconds emission** — self-host Qwen tiers; stamp `gpuSeconds` onto samples so `SelfHostCostModel` lights up. *(Stage 2; G2 self-host half)*
- [ ] **B7 — power calc → confirmatory N** — from Stage-1 σ_d. *(Stage 2; docs/50 §3.1 G-power)*

## 9. Open questions

1. **Per-tier workspace handoff.** Does tier₁ build on tier₀'s filesystem (same worktree, iterative) or start fresh with tier₀'s output as context (current topology behaviour)? Iterative is more realistic but complicates the visible-grader (which workspace state to grade). *Lean: fresh + output-context for v1; iterative as an ablation.*
2. **Confidence-trace persistence.** `RawRun.submission` is the channel swarmkit already reads for cost/steps — confirm it round-trips arbitrary per-tier arrays, or add a dedicated artifact.
3. **fixit visible/held-out split.** Which checkpoints are "visible"? Needs a principled rule (e.g. the module's own unit tests visible, the behavioral/integration checks held out) so the confidence signal is honest.
4. **best-of-N as an arm vs a post-hoc union.** `mono-30B-bestN` can be N independent cells unioned offline (cheaper, reuses seeds) rather than an in-cell arm. *Lean: post-hoc union over seeds.*

## 10. Sources / cross-refs

docs/50 (design, hypotheses, success criteria) · docs/47 (h1 harness patterns, E2B etiquette) · swarmkit-eval `grade/graders.ts` (Grader/Score), `core/types/execution.ts` (Workspace), `benchmarks/fixit-selfcheck.ts` (LocalWorkspace shim) · openswarm `src/swarm/{escalation-gate,escalation-evaluator,topologies/cascade,usage-aggregator}.ts`, `src/core/cost-model.ts`.
