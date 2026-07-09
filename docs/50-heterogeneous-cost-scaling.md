# 50 — Heterogeneous cost-scaling: does compute-optimal allocation expand the Pareto frontier?

**Status:** Draft for discussion · **Author:** (design spike, w/ Claude) · **Date:** 2026-07-07 · **Extends:** [45](45-adaptive-orchestration-design.md) §4/§6, [47](47-h1-experimental-findings.md)

> Goal: test whether a **heterogeneous** swarm of small local models (4B/8B) with **dynamic escalation**
> to a larger reasoning core (~30B) can occupy points on the (quality × cost × throughput) Pareto
> frontier that **no monolithic model reaches** — even when it does *not* win on raw accuracy. The
> deliverable is a frontier, not a single win: "for budget range [B₁,B₂], the swarm resolves more per
> dollar / per GPU-hour than any single-model configuration or its test-time-scaling curve."

This doc reframes the multi-agent question from **accuracy dominance** (which [docs/47](47-h1-experimental-findings.md) already answered: *parity*) to **cost/throughput Pareto expansion**, and specifies the experiment + the harness gaps that expansion requires. It is the sharpened, cost-first instantiation of the unrun **H2 (heterogeneous roster)** arm from [docs/45 §6](45-adaptive-orchestration-design.md).

---

## 1. The reframe (why parity does not kill the thesis)

[docs/47](47-h1-experimental-findings.md) established, across two model families on hard SWE-bench-Verified:

- A *functioning* multi-agent coordinator team reaches **parity** with a single long-lived agent — no better, no worse (1/9 = 1/9). The strong-single-agent-baseline result (arXiv 2601.12307) reproduces.
- **Best-of-N ensemble beat coordination at equal compute** (2/9 > 1/9): the value of "multi-agent" showed up as *trajectory variance + selection*, not within-task message-passing.
- But the ensemble gain was **bounded** — it only recovers the *stochastically-solvable* slice. On hard SWE, "most failure is capability, not variance," so best-of-N plateaus fast.

Crucially, **H1 held the model constant** ([`h1-single-vs-team.ts:47`](../eval/experiments/h1-single-vs-team.ts) pins one model across all arms — "H1 isolates topology, not model"). It never tested *heterogeneity* — the one regime [docs/45 §3.1](45-adaptive-orchestration-design.md) argues the literature grants multi-agent a durable edge. **This doc is that untested axis.**

Parity-on-accuracy is fully compatible with **dominance-on-cost-at-fixed-quality**. The monolith gives you *one* point per decoding config; best-of-N traces *one* curve, always at the monolith's tokens/s and $/token. A heterogeneous fleet has knobs — fleet composition, escalation threshold, parallelism — and each setting is a different operating point. The bet: those points fill in the **high-throughput / low-cost region** the monolith structurally cannot occupy, because most SWE subtasks (localization, test synthesis, syntactic fixes) do not need 30B-quality tokens.

### 1.1 Redefining "value of coordination"

docs/47 showed *conversational* coordination (architect delegates, teammates chat) did not help; *selection over diverse attempts* did. So we do **not** defend message-passing. We define:

> **Coordination = a routing/escalation policy that allocates heterogeneous model compute to subtasks.**

This is the **AgentTTS / cascade-routing / Router-R1** thesis ([§10.2](#102-conditional-optimist-camp--heterogeneous-allocation-done-right)), and it is compatible with the ensemble finding (best-of-N is the *dumbest* allocation policy; a threshold-gated cascade or a trained router is a smarter one). Our contribution is showing the *policy* moves you along — and beyond — the frontier, on repo-level code where the routing literature has not yet been tested.

---

## 2. Formal problem statement

Let a **configuration** `c` be a (model pool, topology, allocation policy, parallelism) tuple. For a task set `S`, each config yields:

- **Quality** `Q(c)` — resolve-rate (or pass@k) on `S`.
- **Cost** `C(c)` — *dual axis*, reported both ways, never conflated:
  - `C$` = dollars/task (API pricing; the practitioner's axis).
  - `C_gpu` = GPU-seconds/task (self-hosted vLLM; the iso-compute axis, immune to the "local is free" confound).
  - `C_flops` = estimated FLOPs/task (hardware-agnostic fallback when neither GPUs nor a priced API is available).
- **Throughput** `T(c)` — *fleet* tasks/GPU-hour (headline) and/or per-task wall-clock latency (secondary). See [§7](#7-open-questions) on which is the headline.

**The frontier claim (H2.1).** The set of achievable `(Q, C)` points for heterogeneous configs is not dominated by the monolith's achievable set — including the monolith's own test-time-scaling curve (best-of-N, extended thinking). Formally: ∃ a heterogeneous `c*` and a budget `B` such that `Q(c*) ≥ Q(monolith config with cost ≤ B)` and `C(c*) < B`, for some non-trivial range of `B`.

**The knee (H2.2).** The escalation threshold `τ` parametrizes a curve `{(Q(τ), C(τ))}`. There exists a **compute-optimal `τ*`** (the knee) that dominates the monolith over a budget band. Low `τ` → rarely escalates (cheap, fast, lower Q); high `τ` → escalates often (approaches monolith Q and C).

**Escalation ROI (H2.3).** `ΔQ / Δ(30B-tokens)` is positive and interpretable — the routing policy spends expensive tokens where they buy the most quality. This is the mechanistic evidence that allocation, not raw scale, is doing the work.

**Iso readings.** Report both: *iso-compute* (fix `C`, compare `Q`) and *iso-quality* (fix `Q`, compare `C`). Pareto dominance = win on at least one at no loss on the other.

---

## 3. Hypotheses as arms (with kill criteria)

Continues the [docs/45 §6](45-adaptive-orchestration-design.md) H1–H4 spine. H1 is done (parity). This doc is **H2, run as a cost/throughput study**, decomposed:

| # | Hypothesis | Arm | Kill criterion |
|---|---|---|---|
| **H2.0** | *Sanity:* the swarm actually spawns N heterogeneous workers with the assigned models | any hetero arm | If spawn-count/model-assignment assertions fail, **stop** — you're re-running the docs/47 spawn bug. |
| **H2.1** | Heterogeneous cascade **Pareto-expands** vs monolith-30B and its best-of-N curve | cascade(τ*) vs monolith TTS curve | If no `τ` beats the monolith curve on *either* iso-axis, the thesis fails on this arena. |
| **H2.2** | A **compute-optimal knee** `τ*` exists and dominates over a budget band | τ-sweep | If the τ-curve is monotone-parallel to the monolith curve (no crossing), there's no knee → no operating-point advantage. |
| **H2.3** | **Escalation ROI** is positive and localizes to hard subtasks | per-escalation trace analysis | If ROI ≈ 0 or escalations fire randomly, "coordination" is not allocating compute — it's noise. |
| **H2.4** | *(stretch)* a **mid-trajectory router** (Router-R1-style) beats the terminal-threshold cascade at equal cost | router arm vs cascade(τ*) | If the router doesn't beat a well-tuned static τ, terminal cascading is the honest recommendation. |

### 3.1 Research objectives & quantitative success criteria

Targets are anchored to the routing/cascading literature ([§10](#10--prior-work-whats-verified-and-how-it-shapes-the-design)) and re-calibrated after P1, not fabricated certainties. Each maps to a hypothesis.

> **Chosen posture (2026-07-07): a *conservative claim* — any statistically-resolved frontier expansion — backed by *publication-grade power* (MDE ≈ 5pp). Magnitude is measured and reported, not gated.** This deliberately inverts the docs/47 failure mode (a bold claim on underpowered data): a modest true effect is allowed to clear significance rather than a large effect being demanded to overcome noise.

| RO | Objective | Success criterion (proposed bar) | Lit anchor |
|---|---|---|---|
| **RO1** | **Frontier expansion** on repo-level code | ∃ an operating point `(Q,C)` that **Pareto-dominates the monolith frontier** (incl. its best-of-N curve) — `Q ≥ Q_mono(C)` at strictly lower `C` — with the dominance resolved **outside the joint CI**. *No fixed magnitude bar* (the chosen posture): the efficiency ratio (×-cost at iso-quality; Δ-resolve at iso-compute) is **reported, not gated** | RouteLLM / cascade-routing (2–3× on easier domains — reference, not our bar) |
| **RO2** | A **compute-optimal knee** `τ*` exists | the τ-curve **crosses/dominates** the monolith best-of-N curve, with the crossing **outside the CI** on the mixed set | cascade-routing optimality proof |
| **RO3** | **Allocation, not scale**, drives the win | escalation ROI (`ΔQ / 30B-token`) > 0 **and** the τ-gated cascade beats a **random-escalation control at the same escalation rate** (the mechanism ablation) | Router-R1 cost reward |
| **RO4** | The **cheap τ signal is valid** | on SWT-Bench, 8B-tier cross-validation flags failing patches at precision/recall above a calibrated bar → escalation fires when (and only when) it should | TEX cross-validation |
| **RO5** *(stretch)* | **Learned router > static τ** | a Router-R1-style mid-trajectory router Pareto-dominates the best static `τ*` at equal cost | Router-R1 |

**Methodological gates — must hold or the result is invalid (the docs/47 lessons made explicit):**
- **G-spawn:** spawn + model-assignment assertions pass on **100%** of heterogeneous cells (H2.0). A non-spawning "swarm" invalidates the cell.
- **G-power:** the confirmatory run is sized for **MDE ≈ 5pp** — ≈ **200–280 instances × 5 seeds** (paired, α=0.05, power 0.8, assuming per-instance paired-quality-diff σ_d≈0.3 from docs/47's high disjoint coverage; the P1 pilot measures real σ_d to finalize). docs/47's MDE (~0.3–0.47 at N=9/1-seed) was ~7× too coarse. Because the claim is "any margin," high power is precisely what lets a *modest* true expansion clear significance. Cost-axis CIs come nearly free (large, consistent effect); quality non-inferiority drives N. Multi-seed (binary→graded per instance) is the primary power lever.
- **G-axis:** the dual cost axis is reported; `$/task` is **never headlined alone** (§8.1).
- **G-kv:** the KV-cache penalty (§6 G4) is reported **both ways**.

### 3.2 What a negative result looks like (and why it still ships)

If **no** config Pareto-expands — the τ-curve runs parallel to, never crossing, the monolith curve — that is itself a publishable finding: *on long-horizon repo-level code, the heterogeneity edge the single-agent-baseline paper concedes does not materialize even under compute-optimal allocation.* It would pin down exactly where the AgentTTS / cascade-routing / RouteLLM wins (demonstrated on QA, chat, multi-hop) **do and don't transfer** to agentic SWE. The §3 kill criteria are designed so a null result is *interpretable*, not merely disappointing — the same discipline docs/47 applied to the parity result.

---

## 4. Experimental design

**Frame it as a policy sweep tracing a frontier, not "swarm vs monolith."**

### 4.1 Benchmark suite
Tiered by *what each benchmark proves*, not by convenience. The primary arena is repo-level code (the thesis domain); the others validate the **mechanism** and **generalization**, and position the result against the literature ([§10](#10--prior-work-whats-verified-and-how-it-shapes-the-design)).

| Tier | Benchmark | What it proves here | Anchor | Phase |
|---|---|---|---|---|
| **Primary** | **SWE-bench Verified** — mixed-difficulty subset | the Pareto frontier: resolve-rate vs cost/throughput | docs/47 arena; faithful grader shipped | P1–P2 |
| **Mechanism** | **SWT-Bench** (test generation) | the cascade's load-bearing assumption — that the 8B *tester* tier writes *discriminating* tests, i.e. the τ cross-validation signal is real (RO4) | TEX (§10.2) | P2 |
| **Generalization** | **GAIA** subset (via HAL) | does the allocation win survive **beyond code**? | docs/45 / eval plan | P3 |
| **Position vs lit** | **General-AgentBench** (`2602.18998`) | run the cascade inside their parallel/sequential-scaling harness → show it beats *naive* parallel/sequential by closing the verification gap on their own turf | §10.1 | P3 (opt.) |
| **Cross-check** | **MARBLE** (multi-agent); **ContextBench** (retrieval, only w/ G5) | coordination-value cross-check; repo-map validation | swarmkit-eval | P4 (opt.) |

**Why not a single benchmark:** docs/47 showed one benchmark at one difficulty gives no discriminating power (the hard-9 set's 11% floor capped the ensemble gain at *one* instance). Two disciplines follow: **(1)** the primary SWE subset is **mixed-difficulty** (~40–60% single-agent solvable) to maximize the *stochastic* slice where allocation policy can separate — reuse [`eval/scripts/prep-swe-subset.sh`](../eval/scripts/prep-swe-subset.sh), with N set by the **G-power** calc (§3.1), not a guess; **(2)** **SWT-Bench is non-optional** — it isolates whether the verification signal the entire cascade depends on actually works, decoupled from end-to-end resolve noise. (Terminal-Bench is a viable alternative agentic arena if a non-SWE code surface is wanted.)

### 4.2 Model pool
- **Small:** 4B and/or 8B open-weight (e.g. Qwen-3-4B/8B or Llama-3.1-8B), self-hosted **vLLM**.
- **Core:** a ~30B (dense or MoE — record *active* params for FLOPs), self-hosted vLLM; API endpoint as the `C$` fallback.
- All routed through the existing [`LiteLLMTransportProvider`](../src/providers/litellm-transport.ts) via `LITELLM_BASE_URL` — heterogeneity is already `MemberSpec.model` per role.

### 4.3 Arms = a curve, not points
| Arm | Role |
|---|---|
| `mono-8B` | cheap floor |
| `mono-30B` | quality target (single point) |
| `mono-30B-bestN` | **the honest thing to beat** — the monolith's own TTS curve (N = 1,3,5,…) |
| `cascade(τ)` | **the Pareto curve** — 8B attempt → gate on `τ` → escalate 30B; sweep `τ` |
| `hetero-roles` | 8B coder + 8B tester + 30B escalation/judge (functional specialization) |

### 4.4 Per-cell metrics
resolve-rate · per-model {input, output} tokens · `C$` · `C_gpu` · `C_flops` · **escalation rate** · wall-clock split `{inference | tool/sandbox | queue-wait}` · **spawn-count + model-assignment assertion** (H2.0).

### 4.5 Deliverable plots
1. `Q` vs `C$/task` — practitioner view.
2. `Q` vs `C_gpu/task` — iso-compute view (the defensible claim).
3. `Q` vs **tasks/GPU-hour** — the "scale to perform tasks" framing.
4. **The τ-sweep curve** with its knee `τ*`, monolith best-of-N curve overlaid — *the money plot*.
5. Escalation-ROI: `ΔQ` vs cumulative 30B-tokens.

```
   Q (resolve-rate)
   ^
   │                       ● mono-30B                     ← one point
   │                 ╭───── best-of-N (monolith TTS curve)
   │            ╭────╯  ○ τ=hi
   │        ○ τ*        ← knee: cascade dominates in this band
   │     ○ τ=lo
   │  ● mono-8B
   └──────────────────────────────────────────────▶  cost  (C$  or  GPU-s,  log scale)
        the swarm curve (○) bulges up-and-left of the monolith curve
        over [B₁,B₂] ⇒ Pareto expansion  ⇒  H2.1 / H2.2 confirmed
```

### 4.6 Controls (the docs/47 lessons, operationalized)
- **Spawn assertion first** (H2.0) — a 0-score arm that never spawned is indistinguishable from a bad policy until you check ([`swarm-modes.ts:11`](../eval/harness/swarm-modes.ts) already ⚠-flags this risk).
- **Separate inference from environment time** — SWE instance latencies (179–706s in docs/47) are dominated by sandbox test execution, not decode. The wall-clock split (§4.4) is mandatory or throughput is fiction.
- **KV-cache penalty reported both ways** — see [§6 G4](#6-harness-gaps--build-plan-g1g4).
- **Provider-harness confound** — Claude runs on the SDK engine, non-Claude on the native engine; docs/47 found a native-engine spawn bug. Keep the engine an explicit, labeled axis; don't compare across engines without a same-engine control.

### 4.7 Run staging & budget
The publication-grade N is the **confirmatory** tier — *not* the first thing to run. Gate it behind cheaper signal-finding so we never burn thousands of cells before knowing the frontier crosses at all:

1. **Pilot** (P1) — baselines on ~25 inst × 3 seeds → measure real σ_d, validate the harness end-to-end (grader, cost model, spawn assertions), sketch the first frontier.
2. **Coarse τ-sweep** (P2) — ~40 inst × 3 seeds × ~6 τ points → locate `τ*` cheaply.
3. **Confirmatory** (P2/P3) — ~200–280 inst × 5 seeds × ~5 arms **at `τ*`** → the definitive frontier with ~5pp CIs (≈5,000+ cells). The formal Pareto test runs here, at `τ*` only (the sweep is curve-fitting, not a multiple-comparison family).

docs/47's E2B etiquette holds (namespaced `sh-*` templates, kill-only-own-sandbox, bounded concurrency). Self-hosted vLLM makes small/core inference **GPU-time, not API $** — so the dominant spend is the 30B **best-of-N** arm and sandbox wall-clock, not the swarm. Budget the confirmatory tier explicitly before launching it.

---

## 5. The cost/throughput accounting model (the measurement spine)

This is the load-bearing addition. Today [`budget.ts:41`](../src/core/budget.ts) `MODEL_PRICING` is a **5-row hardcoded $ table** (Claude + GPT only); [`usageCostUsd()`](../src/core/budget.ts) returns **0 for any open-weight model**. No FLOPs, no GPU-seconds, no throughput. But it is a **single clean seam** — the only function [`SwarmUsageAggregator`](../src/swarm/usage-aggregator.ts) calls for pricing.

### 5.1 `CostModel` interface (replaces the pricing lookup)
```ts
interface CostSample { model: string; inputTokens: number; outputTokens: number;
                       cacheReadTokens?: number; wallClockMs?: number; gpuSeconds?: number; }
interface CostModel {
  cost(s: CostSample): { usd?: number; gpuSeconds?: number; flops?: number };
}
```
- **`ApiCostModel`** — `usd` from a (extended) pricing table; `flops ≈ 2 · N_active · (inputTokens + outputTokens)` (dense-forward approximation; **caveats**: ignores the attention quadratic term — negligible at these context lengths vs the MLP — and requires *active* params for MoE). Works with no GPUs.
- **`SelfHostCostModel`** — `gpuSeconds` measured from the vLLM serving layer (see §5.3); optional `usd = gpuSeconds/3600 · $/GPU-hr`. The iso-compute ground truth.

`SwarmUsageAggregator`'s per-agent-subtree + team roll-up (issue #17) already exists — extend its output type with `gpuSeconds`/`flops` and a **per-model breakdown** (needed because the whole point is *which tier spent what*), and swap the pricing call for `CostModel.cost()`.

### 5.2 Throughput reconstruction (mostly offline — the encouraging finding)
Runs already emit `output: { trace: true }` ([`h1:116`](../eval/experiments/h1-single-vs-team.ts)); every lane event carries `ts`, `worker_spawned` carries the model, `message_stop` carries usage ([docs/05](05-swarm-model.md)). So from **existing traces** we can compute, offline:
- per-model **tokens/s** (output tokens between `turn_start`/`message_stop` spans);
- the wall-clock split (`inference` = turn spans − tool spans; `tool/sandbox` = `tool_use_*` spans; `queue-wait` = spawn→`worker_ready` + pool-acquire gaps).

New `eval/analysis/throughput.ts` consumes the trace; **no new in-loop instrumentation** except GPU-seconds. *(To verify live: that the persisted trace actually retains `tool_use_start/end` spans with `ts`, not just text deltas.)*

### 5.3 GPU-seconds (the one genuinely new signal)
The honest denominator is **fleet-level GPU-hours to clear the task set**, not per-request attribution (batching makes per-request GPU-time ambiguous). Measure: total (GPUs × wall-clock) the vLLM server(s) were occupied serving the run, divide by tasks resolved → **tasks/GPU-hour**. Per-task `C_gpu` is a secondary, batch-normalized estimate. vLLM exposes request/throughput metrics (`/metrics`, per-request timings) to feed both.

---

## 6. Harness gaps & build plan (G1–G5)

| # | Gap | Seam | Size |
|---|---|---|---|
| **G1** | `CostModel` interface + `ApiCostModel`/`SelfHostCostModel`; aggregator gains `gpuSeconds`/`flops` + per-model breakdown | [`budget.ts`](../src/core/budget.ts) `usageCostUsd` → `CostModel`; [`usage-aggregator.ts`](../src/swarm/usage-aggregator.ts) output type | **Small** — 1 fn, 1 caller. Load-bearing. |
| **G2** | Offline throughput analyzer (per-model tokens/s, wall-clock split) + vLLM GPU-seconds capture | new `eval/analysis/throughput.ts`; vLLM `/metrics` | **Small–med** — mostly post-hoc on captured traces |
| **G3** | Parametric cascade — tunable escalation threshold `τ` as a swept config axis. **v1:** terminal gate (tests-pass / critic-disagreement / self-confidence) via existing `escalationPolicy: handoff`. **v2:** mid-trajectory router (H2.4) | [`retry-policy.ts`](../src/swarm/retry-policy.ts) (today: terminal/failure-only) + new gate; `τ` in the matrix | **Medium** — the novel core |
| **G4** | KV-cache honesty control | shared vLLM prefix-cache backend for the swarm, *or* measure+report the re-prefill penalty | **Medium** — fairness fork |
| **G5** | *(stretch)* compressed repo-map for small-context nodes — feed 8B a concise file/symbol map, not raw trees ([§10.3](#103-repository-context-for-small-context-nodes)) | context-construction tool; out of P0–P2 scope, tracked | **Medium** — quality lever, not measurement |

**G4 is the sharpest fairness call.** Subprocess-per-worker ([`subprocess-spawner.ts`](../src/swarm/subprocess-spawner.ts); [docs/45 §3.1](45-adaptive-orchestration-design.md)) means the swarm re-prefills shared repo context on every spawn while the single agent reuses its KV-cache. Left unaddressed, the cost axis measures *OpenSwarm's process model*, not *the approach* — and it biases against the thesis. Either give the swarm a **shared vLLM server with prefix caching** (production-realistic) or **measure the penalty and report frontiers with and without it**. Decide before P2.

Cross-repo note: measurement data is emitted by **openswarm**; the matrix runner, grading, and Pareto/pass^k report live in **`swarmkit-eval`** (sibling dev-dep). G1/G3 land in openswarm; G2 and the report plumbing span both.

---

## 7. Phased rollout

- **P0 — Instrument (G1 + G2 offline half).** `CostModel` + aggregator extension + trace analyzer. Re-price an existing docs/47 run to prove the cost axis is no longer blank. *Exit:* a `(Q, C$, C_flops)` table from already-captured traces.
- **P1 — Self-host + baselines.** vLLM serving 8B + 30B behind LiteLLM; run `mono-8B`, `mono-30B`, `mono-30B-bestN` on the mixed set. *Exit:* the monolith TTS curve, with `C_gpu` + tasks/GPU-hour.
- **P2 — Cascade sweep (H2.1/H2.2).** G3 v1 terminal gate; sweep `τ`; overlay on the monolith curve. Resolve G4 first. *Exit:* the money plot; knee identified or thesis killed.
- **P3 — Router (H2.4).** G3 v2 mid-trajectory router; compare to `τ*`.
- **P4 — Hetero-roles + learned priors.** Functional-specialization arm; feed outcomes to the [docs/45 T3](45-adaptive-orchestration-design.md) MAB priors (swarmkit-eval MAB driver).

---

## 8. Threats to validity

1. **The "local is free" trap.** A `C$`-only win is confounded (local 8B ≈ $0 vs API 30B). The defensible claim rides on `C_gpu`/`C_flops`. Report `C$` for practitioners, but never headline it alone.
2. **Sandbox latency swamps throughput** unless inference is separated from tool/test time (§4.6).
3. **KV-cache penalty (G4)** — can invert a cost conclusion; report both ways.
4. **Small-N power** — docs/47 ran N=9/1-seed (MDE ~0.3–0.47). The mixed set + multi-seed is required to detect frontier crossings, not just floor effects.
5. **FLOPs estimate is an approximation** — fine for *relative* comparison across arms on the same pool; not billing-accurate. MoE needs active-param counts.
6. **Spawn/engine confounds** — assert the swarm is real (H2.0); keep the SDK-vs-native engine an explicit axis.

---

## 9. Open questions (for iteration)

1. **Throughput headline:** fleet *tasks/GPU-hour* (matches "scale to perform tasks") vs per-task *latency*? They imply different vLLM batching setups (max-throughput batched serving vs low-latency single-request). Leaning **fleet tasks/GPU-hour**.
2. **G4 fork:** *fix* the KV-cache penalty (shared prefix cache) or *measure+subtract* it? Fixing is more work but measures the approach; measuring is cheaper but leaves a caveat. Leaning **measure both ways in P2, fix in P3** if the penalty is decision-relevant.
3. **`τ` signal:** what gates escalation in v1 — test-failure, self-reported confidence, critic-disagreement (TEX execution cross-validation, [§10.2](#102-conditional-optimist-camp--heterogeneous-allocation-done-right)), or a budget-threshold (AgentTTS)? Leaning **test-failure + TEX-style cross-validation** first (cheapest, most objective, and it doubles as the verification signal that closes General-AgentBench's parallel-scaling gap — [§10.4](#104-synthesis--the-through-line)).
4. **Model pool:** which exact 4B/8B/30B? Want a clean capability gap so the 30B escalation is *worth* its cost on the hard slice.
5. ~~**Source verification:** confirm the motivating papers before citing.~~ **Resolved (2026-07-07)** — all eight verified; contributions + design mapping in [§10](#10--prior-work-whats-verified-and-how-it-shapes-the-design). Two carry caveats that shape scope: **Router-R1** is validated on QA, not SWE (porting to agentic code is our contribution); **General-AgentBench** shows parallel scaling has a *verification gap* — which is why τ doubles as a verification signal (§10.4).

---

## 10 — Prior work: what's verified and how it shapes the design

All eight motivating sources were **verified** (web pass, 2026-07-07): real papers, accurately described. They split into two camps this design deliberately bridges — a *skeptical* camp (multi-agent rarely beats a strong single agent) and a *conditional-optimist* camp (heterogeneous routing/allocation wins **iff** selection/verification is solved). The mapping below is the experiment's intellectual spine: each row ties a paper to the specific design decision it informs.

### 10.1 Skeptical camp — why naive multi-agent doesn't win
| Work | Contribution | Shapes |
|---|---|---|
| Strong Single-Agent Baseline (arXiv 2601.12307) | homogeneous MAS ≈ single agent and cheaper (KV reuse); a *potential* edge survives **only** in the heterogeneous case | the whole framing — we test heterogeneity, the one conceded regime (§1) |
| MAST (arXiv 2503.13657) | 14 failure modes; tactical/prompt fixes cap at ~+14%; failures are structural | verification-first design; the H2.0 spawn/model-assignment assertion (§3, §4.6) |
| **General-AgentBench** — *Benchmark TTS of General LLM Agents* (arXiv 2602.18998, CMU, Feb 2026) | parallel scaling (K independent trajectories) **and** sequential scaling (longer horizon) both under-deliver: **context ceiling** (sequential) + **verification gap** (parallel) | reframes best-of-N — the binding constraint is *selection/verification*, not sampling (§2, §4.3). Independent corroboration of docs/47's "ensemble needs a good selector." |
| *Scaling TTC for Agentic Coding* (arXiv 2604.16529, Kim et al.) | "TTS for long-horizon agents = representation, selection, reuse"; Recursive Tournament Voting; **frontier** models 70.9→77.6% SWE-Bench-Verified | the selection mechanism for our best-of-N/committee arms; a deliberate **contrast** — it scales frontier models, we scale small ones |

### 10.2 Conditional-optimist camp — heterogeneous allocation done right
| Work | Contribution | Shapes |
|---|---|---|
| **AgentTTS** (arXiv 2508.00890, NeurIPS 2025) | an agent that searches **compute-optimal model + budget allocation across heterogeneous multi-stage subtasks**; allocations are interdependent, search space combinatorial | **the closest prior work to this thesis** — the formal backbone of §2 and the τ/router objective (§3). Our delta vs AgentTTS: repo-level *code* tasks, a runnable OSS harness, and the $/GPU-second dual axis |
| **Cascade Routing** — *A Unified Approach to Routing & Cascading* (arXiv 2410.10347, ETH SRI, ICLR 2025) | derives the **optimal cascading strategy**, proves routing optimality, unifies both; 2–3× speedup at equal accuracy; [code](https://github.com/eth-sri/cascade-routing) | the theory under H2.1/H2.2 — *why* a swept-τ cascade traces a frontier, and the upfront-route-vs-cascade choice (§4.3). Their optimum generally *combines* both → the H2.4 router should use upfront signal **and** cascade |
| **Router-R1** (arXiv 2506.09033, Jun 2025) | the router **is** an LLM doing multi-round `think`/`route` via RL; reward = format + **outcome + cost** | the blueprint for H2.4's mid-trajectory router (§3); its cost-penalized reward *is* our escalation-ROI objective (§2). Nuance: validated on QA/multi-hop, **not** SWE — porting to agentic code is part of our contribution |
| **RouteLLM** (arXiv 2406.18665, LMSYS 2024) | binary strong/weak router from Chatbot-Arena preference data; **85% cost cut at 95% GPT-4 quality** (MT-Bench); transfers across model pairs | the cost-quality-boundary methodology + the practitioner `$` baseline (§2). Nuance: 2-model *binary* routing on chat — we generalize to an N-tier cascade on agentic code |
| **TEX** — *Execution-based Cross-Validation* (Salesforce Research, 2026) | K parallel agents each emit a test + patch; **every patch is cross-run against every generated test**, feeding the next round; SWE-Bench + SWT-Bench | the concrete **escalation signal** for §9.3 — cross-validation disagreement is a cheap, objective τ gate needing *no* 30B call, and it closes General-AgentBench's verification gap |

### 10.3 Repository context for small-context nodes
| Work | Contribution | Shapes |
|---|---|---|
| Multi-Vocal LR on MAS for Code (arXiv 2604.16321) | 114 studies; functional specialization (MetaGPT/ChatDev/AgentCoder/…) mitigates context dilution on multi-file repos | academic grounding for the role split in `hetero-roles` (§4.3) |
| Agents Can See Code Repositories (arXiv 2606.14061) + ContextBench (2602.05892), FastContext (2606.14066) | repo exploration is a major token-budget sink; **over-orchestration can *degrade* retrieval**; a dedicated parallel-search sub-agent returns concise paths | motivates **G5** (§6): small 8B nodes need a compressed repo-map, not raw trees — and a caution that more agents ≠ better retrieval (echoes docs/47) |

### 10.4 Concurrent first-party work — the Advisor tool (advise-don't-redo)
Anthropic's **Advisor tool** (beta `advisor-tool-2026-03-01`; Claude API + Claude Platform on AWS, *not* Bedrock/GCP/Foundry) ships the same heterogeneous-cost bet as this thesis, as a product — which makes it the **incumbent our cascade is measured against**. A cheap **executor** (Haiku/Sonnet) generates the entire deliverable at its low rate; mid-generation it calls a server-side `advisor` sub-inference on a **stronger** model (Opus/Fable/Mythos) that reads the full transcript, returns a bounded plan/course-correction (~400–700 text tokens; ~1,400–1,800 with thinking), runs **without tools**, and **never touches the deliverable**. Executor tokens bill at the executor rate, advisor tokens at the advisor rate; per-model tokens surface in `usage.iterations[]` (the same split our `usage.byModel()` / G2 frontier already consume).

**The architectural fork.** The advisor and our cascade split the cheap×expensive tradeoff on *opposite* axes:

| | Advisor tool | Our cascade (H2.1/H2.2) |
|---|---|---|
| Strong model's job | **advises** (bounded output) | **re-executes** (full output) |
| Deliverable author | always the cheap model | cheap model, or strong model on escalation |
| Cost of a *wrong* invoke | a few hundred wasted advisor tokens | **a full redundant strong-model run** |
| Trigger | executor self-consults (LLM judgment / nudge / `tool_choice`) | external test-gate (τ on repro/TEX signal) |
| Reach | Anthropic models only | cross-provider (Bedrock + Azure), open-weight-capable |
| Bet | cheap model's bottleneck is **planning** | cheap model's bottleneck is sometimes **execution** |

Advise-don't-redo is a direct fix for our sharpest failure mode. The Stage-1 pilot (sympy-11618, §7) over-escalated: the τ-gate false-negatived and the cascade paid **$2.46** where mono-haiku solved it alone for **$0.05** — a ~50× penalty, because escalation re-does *everything*. The advisor's penalty for the same misjudgment is bounded to a few hundred advisor tokens. This is the central design tension the study must confront.

**We can — and should — reproduce it**, because reproducing beats only citing on two counts: (1) *apples-to-apples* — a reimplementation holds the model pair fixed (haiku executor + gpt-5.5/Opus advisor) across the cascade arm and the advisor arm, so the frontier compares **collaboration modes**, not model choices; (2) it *generalizes past the first-party tool's limits* — the real tool is Anthropic-only and off-Bedrock, whereas a reimplementation runs cross-provider and can advise from an **open-weight** model, exactly this thesis's differentiator (and the co-training target). Mechanically it is a **configuration of the existing team layer, not a bespoke tool** — the advisor is an *agent*, and collaboration is what topologies express. The `critic-loop` topology is *already* advise-don't-redo: a read-only critic reviews, the executor authors and revises, the critic never writes (`branchPolicy: {kind:"none"}`). Reproducing the advisor is then a two-member team — cheap executor (haiku) + strong critic (gpt-5.5/Opus) — with the critic **bounded to advise**: a no-tools/read-only role (via the role→`allowedTools` map), a per-member `budget` cap, and a "keep guidance brief" prompt mirroring the tool's `max_tokens`. The *trigger* (H2.3) becomes a topology choice: `critic-loop` (scheduled review) vs a `coordinator`/`peer-team` with a `role:advisor` the executor consults over the message bus (self-triggered, matching the real tool). This is **more** general than the closed tool — the critic can optionally read the worktree for *grounded* advice, the pair is cross-provider, and the advisor can be open-weight — and measurement is free (`usage.byModel()` already splits per-agent, per-model tokens). A bespoke in-process `consult` tool is worth building **only** for bit-faithful parity with the server-side sub-inference (transcript auto-forward, thinking-dropped); for the study, the team structure is the vehicle. In parallel we can still run the **genuine tool** as a first-party reference on an Anthropic-only pair (haiku + Opus) to confirm the team-based advisor tracks it.

**Three design consequences:**
- **New baseline arm** — `advisor` (cheap executor + bounded read-only critic, via `critic-loop`) joins mono-small / mono-large / cascade on the frontier (§4.3); it is the incumbent point, not a straw man.
- **A cheaper middle rung** — insert advise-don't-redo *between* the cascade's tiers: `haiku-solo → haiku+critic → gpt-5.5-solo` (the middle rung *is* `critic-loop`). On low confidence, spend a bounded critic review and let haiku revise before paying for full escalation; this converts the sympy $0.05→$2.46 cliff into $0.05→$0.05+ε→(rarely) full.
- **The trigger becomes a first-class question (H2.3).** The advisor *punts* on the verification-signal problem this thesis centers — it self-consults on LLM judgment rather than a test-gate. Our harness can measure the two head-to-head: test-gate (τ on repro / TEX cross-validation) vs self-triggered consult vs hybrid. *How a heterogeneous system should decide when to spend the expensive model* is precisely the contribution the first-party tool leaves open.

### 10.5 Synthesis — the through-line
One signal repeats across both camps: **selection/verification is the binding constraint — not raw sampling, not raw scale.** General-AgentBench *names* it (verification gap), docs/47 *measured* it (ensemble needs a selector), Scaling-TTC-Coding *built* RTV around it, and TEX *supplies a cheap mechanism* for it (execution cross-validation). That is precisely why this thesis routes through **allocation-with-verification** rather than "more small agents": the escalation gate τ is simultaneously (a) the compute-allocation lever (AgentTTS / cascade-routing) and (b) the verification signal (TEX) that closes the parallel-scaling gap. The heterogeneity edge the single-agent-baseline paper concedes is real **only if** the router spends the 30B's tokens exactly where cheap verification shows the 8B failed — which is a testable claim (H2.3).

**Reference list** (arXiv IDs, verified 2026-07-07): RouteLLM `2406.18665` · Cascade-Routing `2410.10347` (ICLR'25) · Router-R1 `2506.09033` · AgentTTS `2508.00890` (NeurIPS'25) · General-AgentBench `2602.18998` · Scaling-TTC-Coding `2604.16529` · Multi-Vocal-LR `2604.16321` · Agents-See-Repos `2606.14061` · ContextBench `2602.05892` · FastContext `2606.14066` · TEX (Salesforce Research blog, 2026). **In-repo prior art:** Single-Agent-Baseline `2601.12307` · MAST `2503.13657` · GPTSwarm `2402.16823` (ICML'24) · Fugu (Sakana 2026: TRINITY `2512.04695` / Conductor `2512.04388`). **First-party concurrent work:** Anthropic Advisor tool (docs, beta `advisor-tool-2026-03-01`, 2026 — advise-don't-redo heterogeneous pairing; §10.4).
