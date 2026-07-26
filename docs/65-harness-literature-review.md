# 65 — Harness Self-Improvement: literature review, and two directions we scoped out

**Status:** Draft for discussion (literature review + design directions) · **Date:** 2026-07-26

> Goal: a map of the harness self-improvement literature as of mid-2026, and an honest assessment of
> two directions [docs/63](63-live-harness-adjustment.md)/[docs/64](64-harness-delta-and-measurement.md)
> deliberately scoped **out** and that the literature says are load-bearing:
> **(A) experimentation as a *search* problem, not only an optimization problem**, and
> **(B) co-evolving the harness with the model** (`chorus` in our ecosystem) so the model is optimized
> for optimizing itself.
>
> **Headline:** two independent results say our current scope has a measured ceiling. HarnessX reports
> **+14.5% from harness-only evolution and a further +4.7% only from co-evolution**; the
> quality-diversity line says **dense scoring does not transfer to open-ended settings** — which is
> precisely the regime docs/63 §4.2 admits coding is in at task altitude.

---

## 0. Method, and a source limitation to state up front

**`lilianweng.github.io` is blocked by this session's egress policy** (HTTP 403 through the proxy; not
transient, and not routed around). Everything attributed to Weng's *Harness Engineering for
Self-Improvement* (2026-07-04) below therefore comes from **secondary sources** — search summaries,
the latent.space AINews writeup, and commentary — **not from reading the post.** Treat those specific
claims as medium-confidence and verify against the original before relying on them. Everything else
is from abstracts, HTML versions, and project pages reachable this session.

Confidence is marked per entry: **[H]** read substantively · **[M]** abstract/summary only ·
**[L]** secondhand commentary.

---

## 1. The canonical taxonomies

### 1.1 ETCLOVG — *Agent Harness Engineering: A Survey* **[M]**
The field now has a canon: a seven-layer taxonomy — **E**xecution, **T**ooling, **C**ontext,
**L**ifecycle, **O**bservability, **V**erification, **G**overnance — with 500+ references and a living
catalog of open-source harnesses coded against it
([RUCAIBox/awesome-agent-harness](https://github.com/RUCAIBox/awesome-agent-harness),
[survey](https://openreview.net/forum?id=3hXEPbG0dh)).

E/T/C/L are the **structural pillars**; **O** is system-wide monitoring; **V** is evaluation and
feedback across components; **G** enforces governance and security over the whole system.

> **Why this matters to us:** it is a ready-made completeness check on
> [docs/63](63-live-harness-adjustment.md) §5's editability table. Our seven surfaces map onto
> E/T/C/L cleanly, but **O and V are treated in docs/63 as *gates on* edits rather than as *editable
> surfaces themselves*** — and G (governance) is where our "L0 may narrow, never widen" invariant
> lives. Mapping openswarm onto ETCLOVG is a cheap, high-value exercise (§6).

### 1.2 Weng's optimization chain **[L]**
`prompt → structured context → workflow → harness code → optimizer code`, each rung a strictly larger
design space and strictly harder to validate; the endpoint is RSI without touching weights. Adopted as
the *altitude* axis in [docs/63](63-live-harness-adjustment.md) §4.4.

Two further claims, both secondhand but consequential:
- **"Self-improvement is a search problem, and the harness is the search space."**
- **The evaluator is the bottleneck** — "one of the current bottlenecks on the path to implementing RSI
  is that the evaluator is too weak and ambiguous," alongside weakness mining, evolutionary search, and
  the need for human oversight.

The second **independently corroborates docs/63's reward-first thesis** (§4.2). The first is the seed
of §4 below — and cuts against a purely optimization-shaped reading.

---

## 2. The map

### 2.1 Offline harness optimization (the Self-Harness family)
| Work | Mechanism | Conf. |
|---|---|---|
| **Self-Harness** ([2606.09498](https://arxiv.org/abs/2606.09498)) | weakness mining → minimal proposal → regression-validated promotion; Terminal-Bench 2.0; 40.5→61.9 / 23.8→38.1 / 42.9→57.1 | **[M]** |
| **Adaptive Auto-Harness** ([2606.01770](https://arxiv.org/abs/2606.01770)) | sustained self-improvement over *open-ended task streams*; names A-Evolve, GEPA, Meta-Harness | **[M]** |
| **DemoEvolve** ([2605.24539](https://arxiv.org/abs/2605.24539)) | densifies **sparse feedback** in harness evolution using demonstrations | **[M]** |
| **ACE / Meta-Harness** | prompt/context optimization; a stronger external model guiding a weaker one (the contrast Self-Harness defines itself against) | **[L]** |

**Common shape:** propose → validate → promote, *between* episodes. This is
[docs/64](64-harness-delta-and-measurement.md)'s rung 3–4 and it is well covered.

### 2.2 In-flight / mid-task adaptation (our L0)
| Work | Mechanism | Conf. |
|---|---|---|
| **HarnessX** ([2606.14249](https://arxiv.org/abs/2606.14249), Xiaomi) | harness as a **composable typed object**; diagnoses its own failure and **rewrites scaffolding mid-task**; +14.5% avg (up to +44%) over ≤15 evolution rounds, 5 benchmarks, 3 agent families | **[M]** |
| **Schema** ([site](https://schema-harness.github.io/)) | fixed harness, mutable *executable world model*; ~99% ARC-AGI-3 public (self-reported) | **[M]** |
| **Continual Harness** | reset-free test-time self-improvement | **[L]** |

**HarnessX is the closest published system to [docs/63](63-live-harness-adjustment.md)'s L0** and it
validates the premise: mid-task scaffolding rewriting works, and works *best where baselines are
lowest*. Two findings we should absorb:

- **"Gains largest where baselines are lowest"** and **smaller models benefit more** — frontier models
  can overcome poor scaffolding through raw capability; smaller models are scaffolding-dependent. This
  independently reproduces **AutoHarness**'s small-model result and lands directly on
  [docs/50](50-heterogeneous-cost-scaling.md)'s cost-frontier thesis. It also sharpens
  [docs/63](63-live-harness-adjustment.md) §6.1: self-harnessing is *most* valuable exactly where the
  bitter-lesson objection is *weakest* (cheap models), which is a better position than the doc argues.
- **Harness-as-typed-object** is the same instinct as `HarnessDelta`
  ([docs/64](64-harness-delta-and-measurement.md) §3.1).

### 2.3 Code-synthesis guards
**AutoHarness** ([2603.03329](https://arxiv.org/abs/2603.03329)) — covered in
[docs/63](63-live-harness-adjustment.md) §2.4. The constrained↔code-as-policy dial, REx
Thompson-sampling search, and the free/dense/exact reward precondition.

### 2.4 Self-referential and open-ended
| Work | Mechanism | Conf. |
|---|---|---|
| **Darwin Gödel Machine** ([2505.22954](https://arxiv.org/abs/2505.22954), ICLR 2026) | agent rewrites its **own code**, validated **empirically** rather than by proof; grows an **archive** of agents, samples from it, self-modifies → a growing tree of diverse high-quality agents; SWE-bench 20.0→50.0%, Polyglot 14.2→30.7% | **[M]** |
| **ADAS / AlphaEvolve** | automated discovery of agent designs / evolutionary program search | **[L]** |
| **SIA** ([2605.27276](https://arxiv.org/abs/2605.27276)) | co-updates **harness *and* weights** | **[M]** |

**DGM is the single most important entry for §4.** Its central design choice is not the self-modification
— it is the **archive**. Open-ended exploration over a growing population of *diverse* agents, with
empirical validation replacing proof. Our design has a gate and no archive (§5.3).

### 2.5 Search-based (quality-diversity)
| Work | Mechanism | Conf. |
|---|---|---|
| **Gated Semantic Quality-Diversity (GSME)** ([2607.13683](https://arxiv.org/abs/2607.13683)) | **separates proposing from crediting**: an LM diagnoses failures and proposes patches; **all sampling, measurement, and significance testing are owned by deterministic code**, so every credited improvement is "trustworthy by construction." Patches populate a gated categorical QD archive keyed on the **(WHERE × WHY) pathology** an edit addresses — *not* the tasks it fixes — as an **anti-overfitting inductive bias**. Generalization measured on a **sealed test** scored only after evolution | **[M]** |
| **Heuresis** ([2606.25198](https://arxiv.org/abs/2606.25198)) | six search strategies across **Quality / Diversity / Novelty**: MAP-Elites, Go-Explore (archive), Islands (evolutionary), Curiosity, Omni (divergent) | **[M]** |

**GSME is independent convergence on our design, and it is two weeks old.** Its propose/credit split —
LM proposes, deterministic code decides — is *exactly*
[docs/64](64-harness-delta-and-measurement.md) §3.4's "L0 is a proposer, not a writer," and its stated
motivation is ours verbatim: *"the hard part is not generating changes but knowing which one truly
helped, since self-generated feedback is noisy, and an apparent gain can be a measurement artifact or
an edit that merely overfits."* That is doc 64 §3.3 and autonomation's `gate()` in one sentence.

**What GSME has that we do not: the archive, and the key.** See §5.

### 2.6 Co-evolution (model × harness)
| Work | Mechanism | Conf. |
|---|---|---|
| **HarnessX cross-harness GRPO** ([2606.14249](https://arxiv.org/abs/2606.14249)) | pools an agent's trajectories **for the same task across entirely different harness versions**, so the model internalizes *high-level strategy shifts* (new API endpoint, budget management) rather than prompt-phrasing variants. **+4.7% over harness-only**, GAIA 37.4→41.7, WebShop 49.0→54.0 | **[M]** |
| **EvoTrainer** ([2606.03108](https://arxiv.org/abs/2606.03108)) | first to treat the **training-side diagnostic harness** as an evolving object; diagnoses rollout evidence, revises diagnostics, backtests interventions, accumulates reusable skills | **[M]** |
| **HarnessForge** ([2606.01779](https://arxiv.org/abs/2606.01779)) | joint harness + policy evolution | **[L]** |
| **CoEvolve** ([2604.15840](https://arxiv.org/abs/2604.15840)) | agent–data mutual evolution | **[L]** |

**The load-bearing claim:** *"Each single-optimization route stalls at its own ceiling: harness-only at
the scaffolding ceiling, model-RL-only at the training-signal ceiling."*

---

## 3. Two live debates

### 3.1 Reward-first vs. search-first

| | **Reward-first** | **Search-first** |
|---|---|---|
| Claim | the evaluator is the bottleneck; build better reward | dense scoring **does not transfer** to open-ended settings |
| Evidence | Weng ("evaluator too weak and ambiguous") **[L]**; AutoHarness/Schema both win on free dense reward | "meaningful signals are diffuse and long-delayed"; "LLM evaluators often fail to rank ideas reliably, accuracy barely exceeding random"; "LLMs saturate — unique ideas plateau" |
| Method | optimize toward a scalar | populate an **archive** keyed by a *behavior descriptor*; reward novelty/diversity, not a single objective |
| Our doc | [docs/63](63-live-harness-adjustment.md) §4.2 + OQ1 | **absent** |

**This is not a contradiction — it is a regime split, and it maps exactly onto our own build order.**
[docs/63](63-live-harness-adjustment.md) §5.1 ranks capabilities by reward availability and finds a
cliff: positions 1–4 have free/exact signal; positions 5–7 do not. The reward-first program says
*manufacture reward for 5–7* (OQ1). The search-first program says **you may not need to** — below the
cliff, stop optimizing and start searching.

> **Revision to docs/63 OQ1.** OQ1 framed "manufacturing dense reward" as *the* unlock. That is one of
> **two** options, and the literature currently favors the other in exactly the regime we care about.
> The honest statement: *above the reward cliff, optimize; below it, search.*

### 3.2 Harness-only vs. co-evolution — the two ceilings

[docs/63](63-live-harness-adjustment.md)/[64](64-harness-delta-and-measurement.md) explicitly declare
frozen weights and cite SIA as "the boundary openswarm deliberately does not cross." The literature now
**quantifies the cost of that boundary**: harness-only saturates at the *scaffolding ceiling*, and
co-evolution buys a further **+4.7%** on top of harness evolution's +14.5%.

That does not invalidate the scope decision — harness-only is the right *first* program, and +14.5%
before touching weights is the larger share. But it reframes it: **frozen weights is a staging
decision, not a principle**, and the docs should say so.

---

## 4. Direction A — experimentation as search

What an archive buys that a gate does not:

1. **A gate is a filter; an archive is a memory.** Our design (doc 64 §3.4) has `promoted | rejected`.
   A *rejected* delta is discarded except as trace. DGM and GSME both keep everything and sample from
   the population — because a variant that loses today may be the parent of tomorrow's winner. **We
   currently throw away our search history.**
2. **Diversity is a hedge against a weak evaluator.** When the reward is noisy — which §3.1 says is the
   norm below the cliff — maintaining diverse candidates is more robust than committing to the argmax
   of a bad signal. This is exactly why DGM validates *empirically over a population* rather than
   proving one change correct.
3. **The key matters more than the archive.** GSME's central trick is keying on the **(WHERE × WHY)
   pathology** an edit addresses rather than the **tasks it fixes** — an explicit anti-overfitting
   inductive bias. Two edits that fix the same tasks but address different pathologies are *different*
   entries; two that fix different tasks via the same pathology **compete**.

> **This is directly adoptable.** `HarnessDelta.provenance.failureSignature`
> ([docs/64](64-harness-delta-and-measurement.md) §3.1) is already half a pathology key — it captures
> *WHY*. Adding *WHERE* (the surface/tool the edit targets, which `MachineryStamp.touched` already
> records) yields a `(WHERE × WHY)` cell for free. **We can have a QD archive keyed on pathology
> without inventing a single new field** — we already log both halves for other reasons.

**And a sealed test.** GSME scores generalization on a test sealed until after evolution. autonomation's
held-out `gate()` is precisely this instrument, already built — so the discipline transfers with no new
machinery.

---

## 5. Direction B — co-evolution with `chorus` (L3)

### 5.1 The stack gains a rung

| Layer | Repo | Timescale | Adapts |
|---|---|---|---|
| L0 | openswarm | within episode | ephemeral guards/fragments |
| L1 | cognitive-core | across episodes | playbooks, knowledge, routing |
| L2 | autonomation | across cohorts | the machinery (config → … → topology) |
| **L3** | **`chorus`** | **across model generations** | **weights** |

This completes Weng's chain: L2 is "harness code," and **L3 is where "optimizer code" stops being a
metaphor** — a model trained to be better at proposing harness edits *is* the optimizer improving
itself.

### 5.2 The mechanism is already in our design — by accident

Cross-harness GRPO requires trajectories **labeled by which harness version produced them**. That label
is exactly **`MachineryStamp`** ([docs/64](64-harness-delta-and-measurement.md) §5.3), which we designed
for *invalidation*.

> **One artifact, two uses: the stamp that decides whether a delta is stale is the label that makes
> cross-harness training possible.** Doc 64's §5 is therefore load-bearing for a direction it never
> anticipated, and its design (structured `surface`/`fieldPath` rather than one opaque hash) happens to
> be the right shape for grouping trajectories by strategy rather than by phrasing.

### 5.3 It dissolves the bridge-or-crutch dilemma

[docs/63](63-live-harness-adjustment.md) §6.1 framed the bitter-lesson objection as a split between
scaffolds that decay and infrastructure that compounds. **Co-evolution offers a third relationship:**
instead of the next model *obsoleting* the harness, the harness's discoveries are *distilled into* the
next model — and the harness moves on to discovering the next thing. The harness becomes a **curriculum
generator**, not a compensator.

That is a strictly better answer to "bridge or crutch?" than doc 63 gives: **neither — it's a pump.**
The scaffolding ceiling and the training-signal ceiling break each other.

### 5.4 What this would require of the ecosystem

- **Trajectory export labeled by `MachineryStamp`** — openswarm already records sessions; the stamp
  needs to ride along (it does, per doc 64 §3.1).
- **Grouping by *strategy*, not phrasing** — HarnessX's stated benefit. Our `(WHERE × WHY)` key (§4) is
  a plausible grouping variable.
- **A hard governance line.** L3 crosses from "the optimizer cannot rewrite what judges it"
  (autonomation's frozen tier, `design/autonomation-framework.md` §14.1) into territory where it can.
  **The frozen tier and the governance release must remain outside `chorus`'s reach**, or the
  ecosystem loses its only stable reference. This is the single most important safety constraint in
  this doc.

---

## 6. What this changes for docs/63 and 64

| Finding | Change |
|---|---|
| GSME's propose/credit split | **Independent convergence — cite as validation** of doc 64 §3.4 |
| GSME `(WHERE × WHY)` archive key | **Adopt.** Derivable from existing fields (§4) |
| DGM's archive-over-gate | **Gap.** We discard rejected candidates; add a population |
| Search-vs-reward regime split | **Revise docs/63 OQ1** — dense reward is one of two options |
| HarnessX: gains largest where baselines lowest; small models benefit most | **Strengthens docs/63 §6.1** and ties to [docs/50](50-heterogeneous-cost-scaling.md) |
| HarnessX/EvoTrainer co-evolution ceiling | **Reframe frozen weights as staging, not principle** |
| `MachineryStamp` = cross-harness training label | Note the dual use in doc 64 §5 |
| ETCLOVG taxonomy | Map openswarm's editable surfaces onto E/T/C/L/O/V/G as a completeness check |

---

## 7. Open questions

1. **Does the archive pay for itself at our scale?** DGM and GSME run large populations over many
   rounds. openswarm's L0 budget is one episode. An archive may only be meaningful at L1/L2 — in which
   case it belongs in cognitive-core (which already has clustering and a frontier) rather than openswarm.
2. **Is `(WHERE × WHY)` the right key for *coding* pathologies?** GSME's descriptor is validated on its
   own domain. Ours would be `(tool/surface × failureSignature)` — plausible, unvalidated.
3. **Where is the reward cliff, empirically?** §3.1 asserts a regime split; docs/63 §5.1 asserts where
   it falls. Neither is measured. This is testable with existing eval machinery and would settle how
   much of the search program we actually need.
4. **Can cross-harness GRPO work with `chorus`'s training setup at all?** Assumed here, unverified — I
   have not read `chorus`.
5. **Does the frozen tier survive L3?** §5.4. If a co-evolved model is used to judge its own harness
   proposals, the independence autonomation's §14 relies on is gone.

---

## Sources

Surveys/taxonomy: [Agent Harness Engineering: A Survey](https://openreview.net/forum?id=3hXEPbG0dh) ·
[RUCAIBox/awesome-agent-harness](https://github.com/RUCAIBox/awesome-agent-harness) ·
[ai-boost/awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering) ·
Weng, *Harness Engineering for Self-Improvement* (blocked this session; via
[latent.space](https://www.latent.space/p/ainews-lilian-weng-summarizes-35)).
Offline: [Self-Harness 2606.09498](https://arxiv.org/abs/2606.09498) ·
[Adaptive Auto-Harness 2606.01770](https://arxiv.org/abs/2606.01770) ·
[DemoEvolve 2605.24539](https://arxiv.org/abs/2605.24539).
In-flight: [HarnessX 2606.14249](https://arxiv.org/abs/2606.14249) ·
[Schema](https://schema-harness.github.io/) ·
[Continual Harness](https://sethkarten.substack.com/p/continual-harness-an-efficient-self).
Guards: [AutoHarness 2603.03329](https://arxiv.org/abs/2603.03329) · [REx](https://haotang1995.github.io/projects/rex).
Open-ended: [DGM 2505.22954](https://arxiv.org/abs/2505.22954) · [SIA 2605.27276](https://arxiv.org/abs/2605.27276).
Search: [GSME 2607.13683](https://arxiv.org/abs/2607.13683) · [Heuresis 2606.25198](https://arxiv.org/abs/2606.25198).
Co-evolution: [EvoTrainer 2606.03108](https://arxiv.org/abs/2606.03108) ·
[HarnessForge 2606.01779](https://arxiv.org/abs/2606.01779) ·
[CoEvolve 2604.15840](https://arxiv.org/abs/2604.15840) ·
[VentureBeat on HarnessX](https://venturebeat.com/orchestration/xiaomis-harnessx-rewrites-its-own-ai-scaffolding-mid-task-and-smaller-models-gain-the-most).
Internal: [docs/63](63-live-harness-adjustment.md) · [docs/64](64-harness-delta-and-measurement.md) ·
[docs/50](50-heterogeneous-cost-scaling.md) · [docs/45](45-adaptive-orchestration-design.md).
