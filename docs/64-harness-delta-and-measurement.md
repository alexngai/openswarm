# 64 — The Harness Delta and the Measurement Precondition

**Status:** Draft for discussion (design spike) · **Author:** (design spike) · **Date:** 2026-07-25

> Goal: make an openswarm **in-flight harness edit** (docs/63 "L0") a first-class, *attributable*,
> *promotable*, *measurable* object across the three-repo ecosystem — openswarm (runtime),
> **cognitive-core** (cross-episode learning), **autonomation** (cross-cohort optimization) — without
> breaking the attribution that cognitive-core learns from or the fixed-config precondition that
> swarmkit-eval measures under.
>
> Two designs, one dependency: **the `HarnessDelta` artifact** (§3) and **the measurement
> precondition** (§4). It is **not** a design lock. Extends [docs/63](63-live-harness-adjustment.md).

---

## 1. Why this doc exists

[docs/63](63-live-harness-adjustment.md) proposes that an openswarm agent adjust its own harness
in-flight. That doc treated openswarm as the whole world. It is not: openswarm sits in an ecosystem
whose other two members already implement the layers docs/63 was reaching toward, and **adding L0
naively breaks two of their invariants.**

This doc closes those two seams. Everything below is grounded in code read this session; file
references are load-bearing, not illustrative.

### 1.1 The ecosystem, by adaptation timescale

| Layer | Repo | Timescale | What adapts | Gate |
|---|---|---|---|---|
| **L0 in-flight** | openswarm — [docs/63](63-live-harness-adjustment.md) | within episode (sec–min) | ephemeral guards, fragments | in-loop: reality / verifier |
| **L1 cross-episode** | cognitive-core | across runs, same deployment | playbooks, knowledge, routing | `MutationGate` |
| **L2 cross-cohort** | autonomation | offline experiment runs | the *machinery* (config → prompt → code → topology) | held-out `gate()` + CI95 |
| **L−1 measurement** | swarmkit-eval | per fixed config | nothing — it measures | n/a |

This maps onto autonomation's own **three timescales**
(`design/autonomation-framework.md` §14.1: inner content updates · optimization · governance
release) with L0 as a *fourth, faster* inner tier.

### 1.2 What is already wired

The L0↔L1 loop is **closed today** — per `src/memory/providers/cogcore-playbook-provider.ts`:

> *openswarm records sessions → `cogcore run --once` (auto-consolidate) extracts playbooks → this
> provider surfaces them at the next turn.*

- openswarm → cognitive-core: `src/swarm/session-recorder.ts` deliberately maps
  `skillsUsed → appliedPlaybookIds` for downstream credit attribution;
  `src/memory/auto-consolidate.ts` spawns the `cogcore` binary on a cadence.
- cognitive-core → openswarm: `CogcorePlaybookProvider` (read-only) surfaces
  `<storage>/playbooks/<slug>/SKILL.md` into each turn.
- openswarm → L2: `swarmkit-eval@^0.0.11` (package.json), which autonomation **drives** as its
  measurement engine (`design/swarmkit-eval-boundary.md` §0).

**The only empty slot in the stack is L0's within-episode adaptation.** That is a much stronger
motivation for docs/63 than the one that doc states.

### 1.3 The two breakages

1. **Attribution.** `LearningEffectivenessTracker.annotate()`
   (`src/learning/effectiveness.ts:165`) records `knowledgeSurfaced`, `knowledgeApplied
   .playbookIdsUsed`, and `outcome.success` — and **nothing else**. `appliedSuccessRate` is
   "success rate when applied." An L0 guard that rescued a run has its success attributed to
   whatever playbook happened to be applied. → §3.
2. **Measurement.** autonomation's boundary doc (P1) has swarmkit-eval answer *"how good is this
   **fixed** config"*. A live L0 means every cell's harness differs — the thing measured is not the
   thing optimized. → §4.

---

## 2. Prior art inside the ecosystem (do not rebuild these)

Reading the code changed the design substantially. Four mechanisms already exist:

| Mechanism | Where | What it gives us |
|---|---|---|
| **`MutationGate`** | `cognitive-core/src/learning/mutation-gate.ts` | A GEPA `StrictImprovementAcceptance` port: sample a minibatch → score parent vs. candidate via `ReplayJudge` → accept iff `sum(child) > sum(parent)` → snapshot parent to version history, persist child with `parentPlaybookId` lineage. **This is docs/63's rung-2→3 promotion gate, already built.** |
| **Candidate lifecycle** | `ArtifactMechanismTraceEvent` (`mechanism-trace.ts`) | `action: 'candidate-created' \| 'promoted' \| 'rejected'` + `validationStatus` + `candidateId`. The promotion vocabulary exists. |
| **Multi-factor credit slot** | `AttributionMechanismTraceEvent.credit` (`mechanism-trace.ts:104`) | `Array<{id, weight, reason?}>` + `inference: 'usage'\|'presence'\|'judge'\|'heuristic'`. **Declared but no emission site found** — the slot is unclaimed. |
| **Eval-aware envelope** | `MechanismTraceBase` | carries `runId` / `benchmark` / `arm` — already the autonomation seam. |

### 2.1 Three fidelity ladders, independently derived

The strongest signal that this abstraction is real: three repos converged on the same principle
without coordinating.

| Repo | Ordering | Statement |
|---|---|---|
| cognitive-core | `live > verifier > llm-judge` (`replay.ts:25`, `EvalPriority`) | *"A faithful rollout outranks an LLM-judge guess."* |
| autonomation | eval-under-CRN-control > telemetry/human (ADR-0004) | *"Telemetry guides freely; scores only under control."* |
| openswarm | exact/free > costly/partial > judgment > offline ([docs/63](63-live-harness-adjustment.md) §4.2) | gate quality determines what is buildable |

**Decision: `HarnessDelta` reuses cognitive-core's `EvalPriority` verbatim** rather than minting a
fourth vocabulary. That type becomes the ecosystem's shared fidelity currency.

### 2.2 Attribution is a belief at L2, a verdict at L1

autonomation `design/autonomation-framework.md` §9:

> *"The gate never needs change-level attribution. It compares whole variants on measured signal…
> Attribution is **a belief, not a verdict** — a wrong attribution misguides the next proposal
> (self-correcting via flux) but never ships a bad variant."*

So mis-attribution is **benign at L2** and **harmful at L1**, where `appliedSuccessRate` → playbook
confidence → MoEGate routing *is* consequential: a mis-credited playbook gains confidence and gets
surfaced more, compounding. **The fix therefore belongs in cognitive-core's annotation, not in
autonomation's gate.**

---

## 3. Design 1 — the `HarnessDelta`

### 3.1 openswarm side — what an L0 edit *is*

```ts
/** An in-flight harness edit. Ephemeral by default; promotable as a candidate. */
export interface HarnessDelta {
  /** Content-addressed over {kind, body, targetTool} — stable across episodes. */
  id: string;
  kind: 'guard' | 'fragment' | 'contract' | 'macro';
  /** Weng's optimization chain (docs/63 §2.5) — the altitude this edit targets. */
  altitude: 'prompt-context' | 'workflow' | 'harness-code';
  /** Ephemeral (dies with the episode) vs. proposed for promotion. */
  scope: 'episode' | 'candidate';

  /** The predicate source / fragment text. */
  body: string;
  /** Guards only: which dispatch path it gates. */
  targetTool?: string;

  /** Why it exists — feeds L2's proposer and human review. */
  provenance: {
    failureSignature: string;
    proposedAtStep: number;
    proposedBy: 'agent' | 'operator';
    rationale: string;
    /** Machinery version this delta was synthesized against — see §5. */
    machineryVersion: string;
  };

  /** What it survived — reuses cognitive-core's fidelity ladder (§2.1). */
  validation: {
    gate: 'reality' | 'verifier' | 'advisory' | 'none';
    priority: EvalPriority;                    // 'live' | 'verifier' | 'llm-judge'
    status: 'pending' | 'passed' | 'failed' | 'skipped';
    evidence: { firedCount: number; preventedCount: number; falsePositives: number };
  };

  /** Literal type — encodes docs/63's "narrow, never widen" invariant in the compiler. */
  effect: 'restrictive';
}
```

Two deliberate choices:

- **`effect: 'restrictive'` is a literal type, not an enum.** docs/63's rule — *an in-flight
  self-edit may constrain the agent, never liberate it* — becomes a compile-time property rather
  than a convention. A widening edit cannot be represented by this type at all; widening goes
  through the operator-brokered `request_permissions` path instead.
- **`priority: EvalPriority` is imported, not redefined** (§2.1).

### 3.2 cognitive-core side — three additions

```ts
// 1. mechanism-trace.ts — the missing artifact type (the load-bearing change)
export type MechanismArtifactType =
  | 'experience' | 'knowledge' | 'playbook' | 'metaPlaybook'
  | 'shortTerm' | 'frontier' | 'diagnostic'
  | 'harnessDelta';                                    // NEW

// 2. populate the already-declared credit[] with competing causal factors
//    AttributionMechanismTraceEvent.credit
credit: [
  { id: 'pb-42',      weight: 0.3, reason: 'playbook applied' },
  { id: 'hd-guard-7', weight: 0.7, reason: 'guard blocked 3 malformed edit_file calls' },
]

// 3. effectiveness.ts — TaskAnnotation.knowledgeApplied
knowledgeApplied: {
  playbookIdsUsed: string[];
  anyKnowledgeUsed: boolean;
  harnessDeltasApplied?: string[];                     // NEW
}
```

### 3.3 The confidence fix — deliberately dumb

**Do not attempt causal inference.** Isolate clean cells instead:

- `appliedSuccessRateCleanCells` — computed over trajectories where **no** harness delta fired.
- `appliedSuccessRateAllCells` — the existing metric, retained.

A divergence between the two **is itself the diagnostic** that L0 is confounding L1. This is a
handful of lines, needs no judge call, and degrades gracefully to today's behavior when L0 is off.

Credit weights start at `inference: 'heuristic'` (presence/co-occurrence), **not** a judge call —
§2.2 says a wrong belief at this layer is self-correcting. Escalate to `'judge'` only for deltas
whose `blast_radius` / `reversibility` warrant it, reusing autonomation's existing policy fields.

### 3.4 The promotion path — reuse, do not rebuild

```
L0 delta (scope:'episode')
   └─ survives in-loop gate ─────────────► scope:'candidate'
        └─ ArtifactMechanismTraceEvent{action:'candidate-created'}
             └─ MutationGate  (minibatch · parent-vs-child · lineage)
                  └─ 'promoted' → cognitive-core playbook store
                     'rejected' → dies, retained in trace for L2's proposer
```

**This resolves the three-writer problem.** cognitive-core's playbook store already had two writers
(dream/consolidation extraction and the maintenance mutation loop); it solved that not by timing but
by routing **every** write through `MutationGate` with lineage. L0 becomes a **proposer, not a
writer** — a third proposer into an existing gated path, not a third writer to a shared surface.

**Corollary — a correction to [docs/63](63-live-harness-adjustment.md):** validated edits must *not*
promote into openswarm's `memory_manage`. That store is a small curated fact/preference buffer
(2500 char project / 1500 user) with no consolidation, no attribution, and no confidence tracking.
Durable harness knowledge belongs in cognitive-core, arriving as a candidate through the
session→consolidate path that already exists.

---

## 4. Design 2 — the measurement precondition

### 4.1 The resolution: overlay vs. snapshot

autonomation `design/autonomation-framework.md` §6.3 already draws the needed line:

> *"An overlay is the optimizer's decision; a snapshot is the accumulated consequence. Overlays are
> authored (by proposers/humans); snapshots are **grown by traffic**. The optimizer proposes overlays
> and chooses which snapshot to fork from — **it never proposes a snapshot**."*

L0 deltas are *grown by traffic* → they are **snapshot content, not overlay content**. The fixed-config
precondition is preserved because **the overlay is what is fixed**; deltas generated inside a cell are
arm *stochasticity*, like sampling noise. No new concept is required.

| | **Overlay** — fixed per cell, the optimizer's decision | **Snapshot** — forked, grown by traffic |
|---|---|---|
| **L0** | `selfHarness.enabled`, `.budget`, `.dialPosition`, `.gateThreshold`, `.altitudes[]` | promoted deltas carried into the run |
| **L1** | `learning.creditStrategy`, `minTrajectories`, … | playbooks, knowledge, confidence |

This also keeps faith with the ecosystem invariant (`design/cognitive-core-substrate.md` §2):
**autonomation optimizes the learning machinery, never the learned parameters.** L0's *governing
policy* is a Variable; L0's *output* never is.

### 4.2 Three eval modes

| Mode | L0 | Deltas | Measures | docs/63 hypothesis |
|---|---|---|---|---|
| **frozen** | off | — | the control arm | baseline |
| **live** | on | ephemeral, discarded at cell end | L0's *within-episode* value | LH1 |
| **warm** | on | forked from a promoted snapshot (read-only for the cell) | the **flywheel** | LH4 / LH7 |

`warm` is where the ecosystem's real claim lives — that promoted harness knowledge compounds
(docs/63 §6.1). It is also the mode most exposed to §5.

### 4.3 Two hazards to design for, not discover

**H1 — CRN breakage.** autonomation scores only under common-random-number control (ADR-0004). An
L0 proposal is a fresh LLM call → breaks CRN. **Requirement: the L0 proposal step must be seeded from
the cell's seed.** If it cannot be made deterministic under seed, L0 cells may only *guide* (R1), never
*score* (R2) — which would sever the L0→L2 path entirely. This is the single highest-leverage
implementation constraint in this doc.

**H2 — cross-cell contamination.** If deltas persist to a shared bank mid-run, cell N+1 inherits cell
N's deltas and cell independence is destroyed. **openswarm has been bitten by this exact shape before**
— the advisor scratch-wipe fixed in `39125f7` ([docs/59](59-powered-frontier-findings.md)).
**Mandate:** in `live` mode, deltas live in the cell's worktree/scratch and never touch the shared
bank; in `warm` mode the forked snapshot is read-only for the cell's duration.

### 4.4 Variance cost, stated honestly

L0 adds within-cell variance. [docs/61](61-composition-sweep-findings.md) already found 1-seed
screening too noisy to classify difficulty, so `live`/`warm` need **more seeds than `frozen`** — a real
cost that must be budgeted, not discovered mid-study. Mitigation: log **delta-fired rate as a per-cell
covariate** so cells can be stratified rather than blindly averaged.

---

## 5. The invalidation gap (`machineryVersion`) — currently unowned

L2 changes the machinery — a tool schema, the compaction policy, a dispatch path. L1's playbooks were
learned under the old machinery; L0's guards were *synthesized against the old schema*. **Nothing
invalidates them.** autonomation's `stateful()` model explicitly carries state across cohorts, which is
precisely when this bites, and no layer currently owns the problem.

Minimum viable ownership, and the reason `provenance.machineryVersion` is in the §3.1 type:

- Every delta is stamped with the **machinery version** it was synthesized against — at minimum a hash
  over `{tool schemas, dispatch contract, permission model}`.
- On an L2 machinery change, deltas whose stamp no longer matches are **invalidated, not deleted** —
  demoted to `validation.status: 'pending'` and required to re-earn their gate.
- Same discipline should eventually extend to L1 playbooks; out of scope here, flagged as OQ3.

This is deliberately conservative: invalidation is cheap, silent staleness is not.

---

## 6. Cross-repo asks

| Repo | Change | Size |
|---|---|---|
| **openswarm** | `HarnessDelta` type (§3.1); guard evaluation in `ToolDispatcher.dispatch`; emit deltas into the session record so they survive to `cogcore run` | the docs/63 P0 |
| **cognitive-core** | `'harnessDelta'` artifact type; populate `credit[]`; `TaskAnnotation.harnessDeltasApplied`; `appliedSuccessRateCleanCells` | small, additive |
| **autonomation** | `selfHarness.*` as overlay Variables; the three eval modes as arms; seeded-proposal (CRN) requirement | config + arm plumbing |
| **swarmkit-eval** | per-cell delta isolation (H2); delta-fired rate as a logged covariate | small |

Every change is **additive and degrades to today's behavior when L0 is off** — no repo has to move
first, and `frozen` mode is exactly the current system.

---

## 7. Open questions

1. **CRN determinism (H1).** Can an LLM-authored guard proposal be made reproducible under a seed in
   practice (temperature 0 + fixed prompt + pinned model), or does L0 permanently sit at R1 "guide
   only"? This gates the entire L0→L2 path and should be answered empirically before P0 ships.
2. **Credit weight source.** Heuristic co-occurrence is the §3.3 default. When does a delta warrant a
   judge call, and does the `blast_radius`/`reversibility` policy from autonomation §9 transfer
   unchanged?
3. **Invalidation scope (§5).** Should `machineryVersion` invalidation extend to L1 playbooks, and who
   owns the stamp — the substrate adapter or the runtime?
4. **Snapshot granularity.** Is the `warm`-mode snapshot per-repo, per-task-class, or global? Too
   global and deltas from unrelated work pollute; too narrow and the flywheel never spins up.
5. **Does `warm` beat `live` beat `frozen`?** The empirical question the whole design exists to ask.
   If `live` ≈ `frozen`, L0 is not paying for itself and docs/63's P0 should stop at guards.

---

## Sources

- **Internal:** [docs/63](63-live-harness-adjustment.md) (the L0 design this extends);
  [docs/45](45-adaptive-orchestration-design.md) §6b (dynamic-latitude findings);
  [docs/59](59-powered-frontier-findings.md) (the scratch-wipe contamination precedent, `39125f7`);
  [docs/61](61-composition-sweep-findings.md) (seed-noise floor).
- **cognitive-core:** `src/learning/effectiveness.ts` (`TaskAnnotation`, `annotate()`);
  `src/learning/mechanism-trace.ts` (`MechanismArtifactType`, `AttributionMechanismTraceEvent.credit`,
  `ArtifactMechanismTraceEvent`); `src/learning/mutation-gate.ts` (GEPA acceptance port);
  `src/learning/replay.ts` (`EvalPriority`).
- **autonomation:** `design/autonomation-framework.md` §6.3 (overlay vs. snapshot), §9 (attribution &
  disjointness), §14.1 (three timescales); `design/swarmkit-eval-boundary.md` (P1 measurement vs.
  search); `design/ladder-of-learnability.md` + ADR-0004 (controllability routing);
  `design/cognitive-core-substrate.md` §2 (inner-CL / outer-HPO).
