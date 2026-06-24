# 45 — Adaptive Orchestration: from rigid YAML to a reasoning Conductor

**Status:** Draft for discussion · **Author:** (design spike) · **Date:** 2026-06-23

> Goal: let swarm-harness assemble multi-agent teams that *adapt to the task* instead of
> being frozen in a hand-written YAML topology — while staying unobtrusive (the YAML
> remains a valid, fast path) and defensible against the standard multi-agent critiques.

This doc consolidates four external sources — **Sakana Fugu**, **GPTSwarm**, the **MAST
failure taxonomy**, and the **"Strong Single-Agent Baseline"** paper — into a concrete
design direction for swarm-harness, grounded in the current code
([team-spec.ts](../src/swarm/team-spec.ts), [orchestrator.ts](../src/swarm/orchestrator.ts),
[topologies-types.ts](../src/swarm/topologies-types.ts), the
[openteams loader](../src/swarm/openteams/loader.ts)).

---

## 1. The problem with the YAML topology

Today a team is **fully materialized before the task is seen**. The openteams YAML
(`test/fixtures/openteams/gsd-style/team.yaml`) declares `roles`, a `topology.root`,
static `spawn_rules`, and `communication` channels. The loader maps this to a `TeamSpec`
(`name`, `topology ∈ {fanout,pipeline,coordinator,peer-team,committee,critic-loop}`,
`members[]`, `coordination`) and `Orchestrator.runTeam(spec)` runs it.

Two consequences:

1. **The team shape is independent of the task.** A `gsd-style` lead+researcher+implementer
   fires the same way for "rename a variable" and "design a migration". There's no step
   that *reasons about the task* and decides how many agents, which roles, which models,
   and how they should talk.
2. **The interesting decisions are hardcoded.** `spawn_rules`, the aggregator, the
   completion rule, and the (today signal-only) communication graph are author-time
   constants, not task-time outputs.

We already have the missing ingredient: **agents that can reason and route.** The design
below turns that capability into a first-class orchestration stage without throwing away
the YAML path.

---

## 2. What the literature actually says

### 2.1 Sakana Fugu — *learned, query-adaptive orchestration*
A trained orchestrator emits an **agentic scaffold per query** over a pool of frontier
models, behind one interface. Two operating points: **Fugu** = a decision-only router that
picks *one* worker per turn (latency ≈ single call); **Fugu-Ultra** = a *Conductor* that
writes a natural-language workflow of up to 5 steps, each `{subtask, assigned-worker,
access-list}`, producing chains/trees/best-of-N. Key ideas we can steal **without training a model**:
- **Access-list as the unit of context routing** — each step sees *exactly* the prior
  outputs the orchestrator grants it.
- **Intra-workflow isolation + inter-workflow shared memory** — workers are isolated on the
  current subtask (prevents "orchestration collapse"/herding) but share tool/environment
  memory across turns (so they don't re-discover artifacts).
- **Dynamic aggregator** — the synthesizer model is chosen *per task* (trivia→one model,
  math→another). Fixed-aggregator systems are bottlenecked by the aggregator's expertise.
- **Two tiers** — a cheap router for the common case, a deliberate workflow for the hard case.

### 2.2 GPTSwarm — *agents as an optimizable graph*
Source read: [graph/node.py](../) `Node{predecessors,successors,execute()}` reads
predecessor outputs from a shared memory; `Swarm.organize()` builds a `CompositeGraph` and,
when `edge_optimize=True`, enumerates **all inter-agent node connections as candidate
edges** plus edges to a `FinalDecision` node. `EdgeWiseDistribution` gives **each candidate
edge a logit**; `realize()` Bernoulli-samples a concrete **DAG** (with a cycle check) and
returns `log_prob`. `optimize()` is plain **REINFORCE with a moving-average baseline**:
`loss = -(log_prob · (utility − baseline)).mean()`, Adam on the edge logits.
- **Signature result:** in a swarm of truthful + adversarial agents, edge optimization
  **learns to prune the edges to the adversarial agents**, recovering ~single-good-agent
  accuracy. *Structure can be learned from task reward, and learning structure is also a
  robustness mechanism.*
- **Transferable patterns (not the Python):** (a) clean separation of *graph structure*
  (edges) from *node execution*; (b) a "sample a concrete graph → evaluate → update edge
  preferences" loop; (c) a `FinalDecision`/aggregation node as a first-class graph element.

### 2.3 MAST — *why multi-agent systems fail* (arXiv 2503.13657)
14 failure modes in 3 categories, from 150+ annotated traces (κ=0.88). Distribution is
**not** dominated by any one bucket (~**42% / 37% / 21%**):

| Category | ~share | Modes |
|---|---|---|
| **FC1 Specification & System Design** | ~42% | disobey task spec · disobey role spec · step repetition · loss of conversation history · unaware of termination conditions |
| **FC2 Inter-Agent Misalignment** | ~37% | conversation reset · fail to ask for clarification · task derailment · information withholding · ignored other agent's input · reasoning-action mismatch |
| **FC3 Task Verification & Termination** | ~21% | premature termination · no/incomplete verification · incorrect verification |

**The headline finding that should drive our design:** tactical/prompt-level fixes gave only
a **~+14%** improvement in their ChatDev case study and "remained insufficiently low for
real-world deployment." They argue failures need **structural** fixes — standardized
communication protocols, strong verification, and learned coordination — not prompt-tweaking.

### 2.4 Strong Single-Agent Baseline (arXiv 2601.12307)
The sharpest critique for *us specifically*. Most MAS are **homogeneous** (every agent is the
same base LLM, differing only in prompt/tools/position). Across 7 benchmarks, a **single agent
role-playing the roles sequentially in one multi-turn conversation matches or beats the
homogeneous multi-agent system, and is cheaper via KV-cache reuse**. Multi-agent retains a
*potential* edge **only in the heterogeneous case** (genuinely different base models), and even
that they frame as an open direction. Their method (OneFlow) discovers a workflow then executes
it with a *single* agent.

---

## 3. Is swarm-harness subject to these criticisms? (honest self-assessment)

**Yes, and one critique bites harder than the rest.**

### 3.1 The homogeneity problem is our biggest exposure
Our atomic unit has been "one Claude agent" and our default teams are homogeneous Claude
workers. Worse than the paper's setup: we spawn **separate subprocess workers**
([subprocess-spawner.ts](../src/swarm/subprocess-spawner.ts)), so we get **zero KV-cache
reuse** across agents — exactly the cost the Single-Agent paper says is wasted. **A
homogeneous swarm-harness team is, on their evidence, strictly more expensive than one
long-lived multi-turn agent for no quality gain.**

There are only three honest justifications for keeping it multi-agent, and our design should
deliberately lean on them:
1. **Heterogeneity** — different *models / frameworks / effort tiers* per role. We already
   support this: `MemberSpec.model` and `MemberSpec.framework: "claude-agent-sdk" |
   "codex-chatgpt"` ([team-spec.ts:43-45](../src/swarm/team-spec.ts)). This is the Fugu thesis
   and the *only* regime where the literature grants multi-agent a durable edge.
2. **True parallelism** — concurrent workers on independent subtasks for **wall-clock**
   speedup, which a sequential single agent cannot match. (Value is latency, not quality.)
3. **Isolation for verification** — an independent verifier that *did not see* the builder's
   reasoning is a structurally stronger check than self-review. (Directly attacks FC3.)

> Design rule: **a team must earn its existence via heterogeneity, parallelism, or
> isolation-verification.** If a task offers none of the three, the right answer is to fall
> back to a single long-lived worker — and our orchestrator should be allowed to decide that.

### 3.2 MAST modes mapped to current swarm-harness behavior

| MAST mode | Exposure today | Structural lever we have |
|---|---|---|
| FM-1.4 loss of conversation history | Context shared by broadcast/signals, not curated | **Access-lists** (new) |
| FM-1.3 step repetition | No cross-agent memory of tool calls → re-discovery | **Shared environment memory** ([memory/](../src/memory/)) |
| FM-1.5 unaware of termination | `CompletionRule` exists but author-set | Planner sets it per task |
| FM-2.3 task derailment / FM-2.5 ignored input | Broadcast context invites herding | **Intra-workflow isolation** |
| FM-2.4 information withholding | No explicit producer→consumer routing | Access-lists make routing explicit |
| FM-3.1/3.2/3.3 verification | `critic-loop`/`committee` exist but opt-in by author | Planner makes verification mandatory for non-trivial tasks; **dynamic judge model** |

The pattern: **most of the levers already exist as topology/coordination primitives** — they're
just (a) author-time constants and (b) signal-level, not content-level. The work is to make
them *task-time outputs* and to add **content routing**.

---

## 4. Core proposal — the Conductor seam

**One idea, stated precisely:** insert an optional **Planner (Conductor)** stage that consumes
`(user task, available roles/models, optional template-as-prior)` and **emits a validated
`TeamSpec`**, which the existing `Orchestrator.runTeam(spec)` runs unchanged.

This is the unobtrusive seam because **`TeamSpec` is already the universal input** to the
runtime. We are not rewriting the orchestrator; we are adding a new *source* of `TeamSpec`
alongside the YAML loader. The YAML template becomes a **prior/hint** the Planner may adopt,
adapt, or discard — never a cage.

```
                       ┌─────────────────────────────────────────────┐
  user task  ─────────▶│  TeamSpec source (pick one by tier)          │──▶ TeamSpec ──▶ Orchestrator.runTeam()
                       │   T0  static YAML loader      (today)        │        ▲
  template (optional) ▶│   T1  cheap router  → pick template + models │        │ validated by TeamSpecSchema
  roles/model registry▶│   T2  Planner agent → bespoke TeamSpec       │        │
  learned priors ─────▶│   T3  priors bias T1/T2 from past outcomes   │────────┘
                       └─────────────────────────────────────────────┘
```

### 4.1 Tiers (mirrors Fugu's two operating points, plus a learned layer)

- **T0 — Static (today).** `/swarm <template>` → YAML → `TeamSpec`. Keep as the deterministic
  fallback and as the prior for higher tiers.
- **T1 — Router (Fugu-lite, decision-only).** A *cheap* call (small model or even a
  classifier/heuristic over task features) picks a topology template **and** per-role models
  from the registry. Low latency; good default for everyday tasks. Can also decide
  **"single long-lived worker"** when the task fails the heterogeneity/parallelism/isolation
  test (§3.1).
- **T2 — Planner / Conductor (Fugu-Ultra).** A reasoning agent (Opus-class) runs once up front
  and emits a bespoke `TeamSpec`: members with per-member prompts + models + framework,
  topology, completion rule, aggregator (incl. **judge model chosen for this task**), and
  **access-lists**. Output is validated by `TeamSpecSchema` ([team-spec.ts:300](../src/swarm/team-spec.ts)).
  Higher latency; reserved for hard/long-horizon tasks.
- **T3 — Learned priors (the GPTSwarm/Fugu idea, no gradients).** Log per-`(task-class,
  topology, role→model)` terminal outcomes from [events.ts](../src/swarm/events.ts) and use them
  as **bandit/Bayesian priors** that bias T1/T2. This is the non-differentiable analog of
  GPTSwarm's edge logits and Fugu's SFT-on-measured-reward — and, as in GPTSwarm's adversarial
  experiment, it should *learn to stop using* role/model/edge choices that don't pay off.

The Planner is exactly "an agent that can reason and route" — we already have the agent; we're
giving its output a typed destination (`TeamSpec`) and a validator.

### 4.2 New `TeamSpec` capabilities the Planner needs

These are additive extensions to existing types:

1. **Access-lists (content routing).** Extend the member/coordination model so each member
   declares which prior members' outputs enter its context. Today
   `TeamCommunicationRules` ([team-spec.ts:178](../src/swarm/team-spec.ts)) routes *signals*
   (DONE/BLOCKED); we add a *content* edge set — the access-list — which is the GPTSwarm edge
   and the Fugu access-list unified. Default = today's broadcast (back-compat); Planner emits
   a curated DAG.
2. **Isolation flag.** A per-member/topology bit: "this member sees only its own transcript +
   its access-list, never the global broadcast." Implements Fugu intra-workflow isolation →
   attacks FM-2.3/2.5.
3. **Shared environment memory scope.** Make `mapScope`/[memory/](../src/memory/) carry
   tool-call/artifact memory *across* workflow turns but *not* leak peer reasoning within a
   turn → attacks FM-1.3 step repetition without re-introducing herding.
4. **Dynamic aggregator model.** `Aggregator.kind: "judge"` already takes a `role`
   ([team-spec.ts:158](../src/swarm/team-spec.ts)); let the Planner also pin the *model* for
   that judge per task → Fugu dynamic-aggregator.
5. **Mandatory verification policy.** A coordination flag the Planner sets for non-trivial
   tasks that forces an isolated verifier step (reuses `critic-loop`/`committee`).

None of these change `Orchestrator.runTeam`'s contract; they enrich the spec the topologies
consume.

---

## 5. Structural fixes, mapped to MAST (so we attack the right ~80%)

Because MAST shows tactical fixes top out at ~+14%, every item here is **structural**:

- **FC1 (~42%): the Planner writes the spec.** Per-member explicit task+role text, explicit
  `CompletionRule`, and explicit termination conditions become *generated artifacts*, not
  author guesses. Access-lists eliminate FM-1.4 (each member's context is curated, not lossy
  broadcast). Shared env-memory eliminates FM-1.3.
- **FC2 (~37%): content routing + isolation.** Replace broadcast with explicit producer→consumer
  access-lists (a "standardized communication protocol" — exactly MAST's recommendation).
  Isolation prevents herding/derailment.
- **FC3 (~21%, most under-served): verification as a first-class, isolated, dynamically-judged
  step.** This is our highest-ROI structural change: an independent verifier that didn't see the
  builder's trajectory, with a judge **model** chosen for the task. (Fugu's build-and-debug and
  dynamic-aggregator patterns are precisely this.)

---

## 5b. Resolved decisions (2026-06-23)

- **Approach is experimental.** We aim to *reproduce* the multi-agent failure findings (MAST +
  the homogeneity null) on swarm-harness, then show structural fixes overcome them. Data-first.
- **Heterogeneity is the default.** Teams are heterogeneous by construction (different base models
  per role) — the only regime the literature grants multi-agent a durable edge. We'll measure
  whether diversity actually pays.
- **The planner is the main orchestrator.** The entry agent decides *whether* to fan out at all —
  default is to do the task itself (single agent) and spend nothing extra; it constructs a
  `TeamSpec` only when heterogeneity / parallelism / isolation justifies it. We **ablate**
  planner-as-coordinator (reactive spawn, already in [coordinator.ts](../src/swarm/topologies/coordinator.ts))
  vs a separate plan-then-execute planner.
- **Roster + models first, access-list DAG later.** De-risk: adapt the roster (who + which model)
  before adapting the content-routing graph.
- **Engine abstraction (substrate for heterogeneity) already exists.** `MemberSpec.{model,
  framework}` → `src/engine/{claude-agent-sdk,native}` + `src/providers/routing.ts` (`resolveProvider`)
  + aliases, with an `auto` mode that routes Claude via the SDK and non-Claude (LiteLLM-gateway)
  models via `NativeEngine`. Work = clean per-member plumbing + a roster contract, not a new engine.
- **Eval engine = `swarmkit-eval`** (dev dependency), not a bespoke harness — see §6.

## 6. Evaluation & benchmarking (the co-equal deliverable)

Built on **`swarmkit-eval`** (live-linked dev dependency; see [eval/README.md](../eval/README.md)),
which already provides the `(task × arm × model × seed)` matrix runner, ground-truth grading,
sandboxed backends (E2B is our backend), the SWE-bench / GAIA(HAL) / **MARBLE multi-agent**
benchmarks, LiteLLM-gateway routing for heterogeneity, a MAB driver for the T3 priors layer, and
paired-CI / pass^k / Pareto statistics. swarm-harness is a registered harness there
(`swarmHarness()` → `swarm-harness --single …`, the single-agent baseline arm).

**The experimental spine — four hypotheses, each an arm with a kill criterion:**

| # | Hypothesis | Arm | Reproduces / proves |
|---|---|---|---|
| **H1** | Homogeneous Claude team ≤ single long-lived agent, at higher cost | homogeneous team vs single | **Negative control** — reproduces arXiv 2601.12307. If it fails, the harness/metrics are wrong. |
| **H2** | Heterogeneous roster (different base models/role) beats best single model + homogeneous team | heterogeneous roster, same topology | The diversity-value question (Fugu) |
| **H3** | Isolation + access-lists + first-class verification beat the **~+14%** tactical ceiling and shift the MAST histogram | heterogeneous + structured | "Overcome" the MAST limitation |
| **H4** | An orchestrator that *decides* whether to fan out is Pareto-better | planner-decided | Selective fan-out |

What "reproduce MAST" means honestly: not their exact 42/37/21 split (different system/tasks), but
(a) their **methodology** — the 14-mode taxonomy + LLM-as-judge over traces; (b) the **qualitative**
finding that failures spread across all three categories on our homogeneous arm; (c) the
**tactical-ceiling** finding. H2/H3 are the "overcome."

**Disciplines:**
1. **Always vs the strong single-agent baseline.** Headline metric = **value-add = team −
   single_agent** at known cost (the 2601.12307 discipline). Hold the scaffold constant, swap only
   the policy (non-Claude models run through `NativeEngine`/swarm-harness's *own* tool loop — Fugu's
   "minimal harness to expose the model"; the Codex-own-harness path is a separate, labeled arm).
2. **Primary metric = terminal task success**; secondary = tokens, wall-clock, $/task.
3. **Task arenas:** SWE-bench subset (coding = our domain, build-vs-debug heterogeneity story) +
   GAIA subset (cross-domain). **MAST-Data** is not a task arena — it's the labeled ground truth to
   **validate our MAST judge** before we trust our own histogram.
4. **MAST judge:** LLM-as-judge tagging each cell's trace with the 14 modes → a per-mode failure
   histogram *for our system*, telling us which structural fix to build next.
5. **Adversarial probe (GPTSwarm-style):** inject a deliberately weak member; confirm the T3 priors
   learn to route around it.

**Success criteria ("overcome"):** H1 reproduces; H2 shows positive value-add at acceptable cost;
H3 yields **>+14%** over baseline *and* a measurable FC2/FC3 drop in the MAST histogram; H4 is Pareto-better.

---

## 6b. First experimental results (2026-06-24)

H1 ran on Bedrock Sonnet-4.5 over SWE-bench-Verified via the `eval/` harness (E2B sandboxes, faithful swebench grader, no local Docker). Arms: `single`, `team` (homogeneous coordinator: architect+executor+reviewer), `hetero` (architect-lead + implementer + dedicated verification engineer + adversarial critic — targets MAST FC3).

**Easy set (5 instances, mostly <1h):** single 4/5 → saturates; useless for discrimination. Lesson: pick on difficulty.

**Hard set (9 instances, `1-4h`+`>4h`):** the headline.

| Arm | Resolve | Latency p50 | Resolved instance |
|---|--:|--:|---|
| single | **1/9 (11%)** | 447s | xarray-3993 |
| homo team | **1/9 (11%)** | 290s (terminates early) | sympy-13878 |
| hetero team | **1/9 (11%)** | 706s (most work) | sklearn-25102 |

- **All three identical on aggregate (11%); paired Δ = 0, not significant, MDE 0.47** (N=9, 1 seed → underpowered).
- **Coverage is DISJOINT** — each config solves a different instance; union = **3/9 (33%)**.

**Reading:** confirms the strong-single-baseline thesis (§3.1, arXiv 2601.12307) — neither adding agents nor heterogeneity/verification-specialization lifts aggregate accuracy on hard tasks (hetero did 1.5× the work for the same yield). The live signal is the disjoint coverage: the value of "multi-agent" here looks like **trajectory variance / ensemble diversity** (union over independent diverse attempts ≈ 3×), **not within-task coordination**. This reframes the Conductor seam (§4) toward **best-of-N / ensemble-select across diverse configs** over coordinated message-passing teams.

**Caveats / next:** disjoint coverage at N=9/1-seed could be noise. The decisive follow-up is **multi-seed** per config to test (a) whether union grows with diverse attempts (the ensemble hypothesis) and (b) whether any config systematically wins. Also pending: a mixed-difficulty set (~40–60% single, better power than the 11% floor) and **team/hetero token accounting** (the coordinator surfaces no usage today — needs a swarm-harness change to aggregate spawn-tree usage; cost axis currently blank).

### 6b.1 Cross-family replication on GPT-5.5 (Azure)

To test whether the finding is Claude-specific, the whole 3-way was re-run on **Azure GPT-5.5** (a reasoning model) via a new swarm-harness direct-Azure transport (`azureoai/`). gpt-4.1 was unusable — it plans in text and never calls tools on open-ended SWE tasks; gpt-5.5 engages the agentic loop natively (validated: 323s, 105 tool calls).

| Arm | Sonnet-4.5 | GPT-5.5 | GPT-5.5 latency p50 |
|---|--:|--:|--:|
| single | 1/9 | **1/9** (same instance: xarray-3993) | 179s |
| homo team | 1/9 | **0/9** | 65s |
| hetero team | 1/9 | **0/9** | 74s |

- **single agrees across families** — both resolve exactly xarray-3993, fail the other 8. The hard set is hard for both frontier families.
- **Teams don't beat single on either family; on GPT-5.5 they are *worse*** (paired Δ = −0.111, CI [−0.33, 0]). The homo team failed xarray-3993 in **39s** — the instance single *solved* in 179s.
- **Mechanism: premature termination.** GPT-5.5 team cells terminate ~3× faster than single (p50 65–74s vs 179s) — the coordinator + `completion: all` declares done before doing the thorough investigation single does. This is the concrete "teams add coordination overhead that destroys value" failure, now visible in two families.

**Robust conclusion:** across two model families, no multi-agent configuration beats the single-agent baseline; on the stronger reasoning model, coordination actively hurts via early convergence. Strengthens the §4 reframe toward ensemble-select over coordinated teams. (Real swarm-harness improvements banked: direct Azure transport, OpenAI-compatible auth-gate recognition.)

---

## 7. Phased rollout

- **P0 — Eval infra (eval-first).** `swarmkit-eval` wired + smoke-verified ([eval/](../eval/)). Three
  immediate steps, in order: **(1)** point the `swarmHarness` adapter at the locally-built CLI (iterate
  without publishing); **(2)** make H1 run on E2B (single-agent vs homogeneous team on a SWE-bench
  subset); **(3)** the MAST judge (validated against MAST-Data). Reproduce H1.
- **P1 — Heterogeneity + roster (H2).** Roster contract `{role, engine, model}`; heterogeneous arm
  (GPT-builder / Opus-verifier, dynamic judge model) vs homogeneous vs single.
- **P2 — Planner + ablation (H4).** Planner-as-orchestrator that may decline to fan out; ablate
  reactive coordinator vs separate plan-then-execute planner. YAML becomes a prior.
- **P3 — Structure (H3).** Access-list DAG + isolation + first-class verification in `TeamSpec`.
- **P4 — T3 priors.** Outcome logging → bandit priors (the MAB driver) biasing P1/P2; adversarial-pruning test.

---

## 8. Open questions

Resolved (§5b): heterogeneity-as-default (was Q5); roster-before-DAG (was Q3); planner-is-the-
orchestrator-and-may-decline. Still open:

1. **Planner realization for the ablation** — reactive coordinator-as-planner
   ([coordinator.ts](../src/swarm/topologies/coordinator.ts), already built) vs a separate
   plan-then-execute planner stage in [cli/swarm.ts](../src/cli/swarm.ts). P2 builds both to ablate.
2. **Latency/cost gate for the planner.** A full plan pass is one extra Opus call before work starts.
   Gate it behind a task-size/complexity heuristic (cheap router decides whether to escalate)?
3. **Access-list as the unification point** — collapse "GPTSwarm edge" + "Fugu access-list" + our
   signal channel into *one* content-routing primitive, or keep signals and content separate? (P3.)
4. **T3 credit assignment.** Terminal reward only (Fugu/GPTSwarm) vs per-step attribution — how to
   attribute a team success to specific role/model/edge choices for the priors? (The MAB driver
   assumes arm-level reward; per-edge credit needs more.)
5. ~~E2B local-harness transport.~~ **Resolved.** No publishing needed: the E2B SDK Template builder
   supports `.copy(localFile, dest)` (server-side upload). Added a `copyFiles` option to swarmkit-eval's
   template builder; `HARNESS=local` packs the CLI and stages the tarball into each template, then
   `npm i -g`s it in-sandbox. (Other harnesses don't hit this — they install published npm/pip artifacts.)

---

## Sources
- Fugu technical report — `Fugu_technical_report.pdf` (Sakana AI, 2026); methods: TRINITY
  ([2512.04695](https://arxiv.org/abs/2512.04695)), Conductor ([2512.04388](https://arxiv.org/abs/2512.04388)).
- GPTSwarm — *Language Agents as Optimizable Graphs* ([2402.16823](https://arxiv.org/abs/2402.16823), ICML 2024);
  code: [github.com/metauto-ai/GPTSwarm](https://github.com/metauto-ai/GPTSwarm).
- MAST — *Why Do Multi-Agent LLM Systems Fail?* ([2503.13657](https://arxiv.org/abs/2503.13657)).
- Strong Single-Agent Baseline — *Rethinking the Value of Multi-Agent Workflow* ([2601.12307](https://arxiv.org/abs/2601.12307)).
