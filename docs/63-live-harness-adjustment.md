# 63 — Live Harness Adjustment: agents that author and revise their own running harness

**Status:** Draft for discussion (design spike) · **Author:** (design spike) · **Date:** 2026-07-25
(rev. 2 — reframed around the reward signal as the binding constraint; rev. 3 — corrected for the
three-repo ecosystem, see [docs/64](64-harness-delta-and-measurement.md))

> **Read [docs/64](64-harness-delta-and-measurement.md) alongside this.** This doc treats openswarm as
> the whole world; it is not. cognitive-core (cross-episode learning) and autonomation (cross-cohort
> optimization) already implement the layers this doc reaches toward, and two claims here are
> corrected as a result: the **rung-3 promotion target** (§4.3) and **OQ1** (§9).

> Goal: explore whether openswarm can become a harness whose agents make **on-the-fly
> adjustments to their own running harness** — tools, prompts, verification rules, control
> flow — and do so *safely*, without regressing into the multi-agent failure modes openswarm
> already measured in [docs/45](45-adaptive-orchestration-design.md) §6b. This is a design
> spike: a mapping from external evidence onto openswarm's real seams, plus a phased,
> eval-gated plan. It is **not** a design lock.
>
> **The organizing conclusion:** self-improvement is a *search*, the harness is the *search space*,
> and therefore the **reward signal — not the mutable surface — is the binding constraint**. That
> inverts the naive roadmap. Build order runs from where openswarm already has free, exact rewards
> (tool-call compliance) toward where reward must first be *manufactured* (open-ended coding
> quality), which is the central open problem (§9 OQ1).

This doc consolidates a fast-moving external literature — **Schema** (Impossible Research),
**Self-Harness** (arXiv 2606.09498), **AutoHarness** (Google DeepMind, arXiv 2603.03329), the
**adaptive/continual auto-harness** line (A-Evolve, GEPA, Meta-Harness, SIA, DemoEvolve), and Lilian
Weng's **Harness Engineering for Self-Improvement** survey — and grounds it in the current code, using
a file-level inventory of every openswarm primitive that already lets an agent change its own
operating environment at runtime.

---

## 1. The idea, and why it is worth a spike now

**Schema** is the provocation. A *fixed*, hand-designed harness lifts frontier models from a
~42.8% Claude Code baseline to **~99%** on the ARC‑AGI‑3 public set — **zero weight changes**. The
mechanism: make the model act like a physicist. **Ground state** (raw observations → objects,
variables, relations) and **discover mechanism** (write the world's transition rule as an
*executable program*, not a vector), then run a contradiction→experiment→revise loop and **plan
inside the verified program**. The latent world model is a *program* — interpretable, verifiable,
replayable.

The reading that matters for us: **structure dominates.** If a *static* structure can express that
much latent capability, a structure that **fits itself to the task in front of it** has a strictly
larger ceiling. That is the argument for in-flight adaptation, and it is a good one.

But there is a trap in the extrapolation. Schema is evidence for *good, fixed, hand-tuned*
structure. It says structure matters; it does **not** say *self-authored* structure is easy.
In-flight self-harnessing asks the agent to do two hard things at once: (a) *discover* the good
structure, and (b) not destabilize the loop it is **currently running inside** while editing it.
Schema sidesteps (b) entirely — it holds the harness rigid and mutates only a **world-model
program** (a data artifact), never its own tooling. That separation is the whole trick.

A control-theoretic framing places the main reference points on one axis:

| | What is mutated | When | Feedback |
|---|---|---|---|
| **Schema** | a world-model *program* (data artifact) | in-episode | open-loop on the harness; closed-loop on the artifact |
| **Self-Harness** | the *harness* (prompts, tools, rules) | between episodes | closed-loop, **offline**, regression-gated |
| **This doc's target** | the *harness*, **in-flight** | in-episode | closed-loop, **online** |

The target is strictly more powerful **and** strictly more prone to oscillation/divergence. The
entire design problem is how to get the power without the divergence — and openswarm's own history
(§3, §6) says that is a real, measured risk, not a hypothetical.

And there is a second constraint, which the rest of this doc treats as co-equal. If **self-improvement
is a search and the harness is the search space** (Weng, §2.5), then a search is only as good as its
**fitness function**. Every result in this literature is downstream of a reward the system could
actually compute: Schema's next-observation prediction, AutoHarness's legal-move rate, Self-Harness's
regression suite. **The binding constraint on live self-harnessing is therefore not what we can make
mutable — it is what we can cheaply score.** §4.2 makes this a first principle and §7 derives the
build order from it.

---

## 2. What the literature actually shows

### 2.1 Schema — a fixed scaffold, an executable world model
Two formalized sub-problems: **state grounding** (observations → trackable objects/variables/
relations) and **mechanism discovery** (how state changes under an action, written as an executable
program). Representation and transition rule are built *jointly*; each contradicting observation
forces a real-world experiment and a representation change; once the program is verified the agent
plans inside it, using far fewer actions than humans. **The harness is fixed; the world model is
the mutable artifact.** Reported ~99% with Opus 4.8 + Fable 5, ~95.35% with GPT‑5.6 Sol — *self-
reported on the public set, not independently verified.*

### 2.2 Self-Harness — the agent as its own harness engineer (offline)
An LLM agent improves its **own** operating harness with no human engineer and no stronger external
model. A harness here is explicitly: *system prompts, tools, runtime mechanisms, verification
rules, orchestration logic, failure-recovery procedures.* The loop is three stages:
1. **Weakness mining** — run tasks, detect model-specific failure patterns.
2. **Harness proposal** — generate a *minimal* modification tied to a specific failure mechanism.
3. **Proposal validation** — regression-test; promote only if it improves without measurable
   degradation.

Reported held-out gains: 40.5→61.9%, 23.8→38.1%, 42.9→57.1% across three models. **Crucially, the
loop is between-task/offline** — the regression gate is too slow to sit inside a single episode.

### 2.3 Continual / self-evolving harnesses
The Continual Harness and SEAGym line push toward *reset-free, test-time* self-improvement — the
agent learns hidden dynamics during the run. Numbers are early and far below Schema, but the
direction (online, in-episode adaptation) is exactly this doc's target, and the results are a
sober reminder that the online regime is hard.

### 2.4 AutoHarness — the harness as a synthesized *code constraint*
(Google DeepMind, [arXiv 2603.03329](https://arxiv.org/abs/2603.03329).) The sharpest single mechanism
in this literature for us. The motivating failure is not bad strategy but *illegal actions*: in Kaggle
GameArena chess, **78% of Gemini-2.5-Flash losses were illegal moves.** AutoHarness has the model
**synthesize a code harness** — runtime constraints that make prohibited actions impossible — by
framing harness synthesis as **search over program space**: a REx **tree search with Thompson
sampling**, the LLM acting as a **mutation operator** that refines candidate harness code, and
**environment feedback** (legal-action accuracy) as the reward. ~14.5 iterations to a 100% legal rate
across **145 TextArena games**. The headline: a *smaller* model plus a self-synthesized harness
**beats larger models** (Gemini-2.5-Pro, GPT-5.2-High) at lower cost.

**The harness is a dial, not a fixed artifact.** This is the detail that matters most for us. The
synthesized template can sit anywhere on a spectrum of *how much of the policy is compiled into code*:

- **Constrained end** — a fixed rejection-sampling loop in which only a small **conditioning function**
  is synthesized. The LLM still proposes every action; the code filters illegal ones. Model = policy,
  harness = guardrail.
- **Flexible end — "code-as-policy"** — the synthesized code proposes the action directly and there are
  **zero LLM calls at execution time.** The model has been *compiled out* of the loop. (This variant
  out-scores Gemini-2.5-Pro and GPT-5.2-High on 16 single-player games.)

The search that fills in that code is **REx** ([Tang et al.](https://haotang1995.github.io/projects/rex)) —
code repair framed as an explicit **exploration-exploitation tradeoff**: *explore* = try a structurally
different control loop, *exploit* = refine one that partly works, with Thompson sampling arbitrating.

Four conclusions transfer:

1. **It moves correctness from the stochastic layer to the deterministic layer.** A prompt ("don't emit
   illegal moves") is a probabilistic nudge that lowers an error rate but never to zero; a synthesized
   guard is a **hard invariant** that makes the error structurally impossible. The 78% statistic is the
   tell — the model *knew* chess and still could not reliably *comply* under generation pressure. The
   harness adds no knowledge; it adds **compliance that sampling cannot buy.** (Sharpens §5 #4b.)
2. **Synthesis is a fixed cost amortized over executions.** Pay once to write the harness, then execute
   cheaply — or, at the code-as-policy end, LLM-free — thereafter. That, not model quality, is why the
   small model wins: the compiled artifact runs at ~zero marginal inference cost with 100% compliance,
   which dominates repeated big-model sampling. **Corollary: amortization only pays when the structure
   recurs** — one-shot tasks cannot recoup synthesis; a *repeated* environment (the same repo, test
   suite, or API) can. (Feeds LH6 and [docs/50](50-heterogeneous-cost-scaling.md).)
3. **Self-improvement is a search with a cheap reward.** LLM-as-mutation-operator + free environment
   signal + Thompson-sampling selection is a concrete algorithm for generating *and choosing* harness
   edits — the disciplined form of best-of-N. (Feeds §4.5.)
4. **The result is downstream of a free, dense, ground-truth reward — and coding does not have one.**
   Games hand you legal-move accuracy and score, checkable every step at zero cost. "Does this code
   work" is expensive, sparse, and only a *partial* oracle (green tests ≠ correct). **So the honest
   transfer is not "run AutoHarness on SWE-bench."** It is: find the sub-problems *inside* coding where
   a cheap, dense, ground-truth signal already exists, and put those behind synthesized guards. §4.2
   works out where those are.

### 2.5 The broader family, and Weng's optimization chain
The space is moving fast and worth situating. **Adaptive Auto-Harness**
([arXiv 2606.01770](https://arxiv.org/abs/2606.01770)) pushes self-improvement across *open-ended task
streams* (continual, not one task) and names the evolutionary optimizers **A-Evolve, GEPA,
Meta-Harness**. **SIA** ([arXiv 2605.27276](https://arxiv.org/abs/2605.27276)) co-updates *harness and
weights* — the boundary openswarm deliberately does not cross (frozen weights is a
[non-goal](00-vision.md); we stay harness-only). **DemoEvolve**
([arXiv 2605.24539](https://arxiv.org/abs/2605.24539)) attacks the *sparse-feedback* problem in harness
evolution by densifying the reward with demonstrations — relevant to our gate-budget question (§9).

Lilian Weng's **Harness Engineering for Self-Improvement** (Lil'Log, 2026-07-04, ~35 papers) supplies
the organizing frame we adopt in §4.2: a harness is *"code that programs how prompts, tool calls,
subagents, control flow, memory, and workflow logic work together"* — the model's **external execution
system** — and self-improvement is a **progressive optimization chain**:

```
prompt → structured context → workflow → harness code → optimizer code
```

Each step up the chain unlocks a strictly larger design space than the last — and is correspondingly
harder to validate. The endpoint (the agent editing the code that *optimizes* the agent) is recursive
self-improvement **without touching weights**. That is the openswarm-native reframing of the whole
idea: not a model rewriting its weights, but the model **authoring the system around it**.

Two further claims from the survey are load-bearing here:

- **"Self-improvement is a search problem, and the harness is the search space."** This is the sentence
  that reorganizes the field — and it has a corollary the enthusiasm usually skips: a search is only as
  good as its fitness function, so **the reward signal, not the mutation surface, is the binding
  constraint** (§4.2).
- **"Without evals, isolation and auditable traces, self-improvement can become confident regression."**
  Weng arrives independently at openswarm's own [docs/45](45-adaptive-orchestration-design.md) §6b
  lesson — dynamic latitude that *looked* like progress and was not (including the stretch that turned
  out to be a spawn bug, which only the traces exposed). The reframing that matters: **evals, isolation,
  and auditable traces are not safety features bolted onto a harness — they *are* the harness.** This is
  the strongest earned claim that openswarm is well-positioned: it already ships all three she names —
  `swarmkit-eval` (evals), subprocess workers (isolation), and the lane-event stream (auditable
  traces). Most frameworks would have to build them; here they are load-bearing infrastructure.

### 2.6 The critique — and why self-authoring answers it
The strongest live objection to Schema (Kamradt and others): *how much human intelligence is baked
into the harness vs. the model?* A harness the model **authors at runtime** is the clean rebuttal —
if the scaffold is written by the model, in-flight, the intelligence is provably the model's, not
the engineer's. That is not just philosophy; it is an **ablation we can run** (agent-authored vs.
hand-authored scaffold on the same task class), and it is a genuine positioning advantage for
openswarm as a *research* harness.

---

## 3. Where openswarm stands today (grounded in code)

One structural fact decides the whole design. A worker rebuilds its `RunConfig` — system prompt,
tools, model, permission mode — **fresh every turn** (`executeTurn`, `src/cli/worker-entry.ts:311`)
from *static inputs* (env vars, role registry, project files, memory injection). The only things
that legitimately change turn-to-turn without human/config intervention are the **injected memory
block** and **anything the agent wrote to disk**.

This is simultaneously the obstacle and the opportunity. It is *why* openswarm is static today —
the agent's actions do not feed back into those static inputs. It is *also* the cleanest possible
injection point for a live "harness delta," folded in exactly where memory injection already sits.

Today, exactly **two** primitives let an agent change its own operating environment at runtime:

- **`memory_manage`** (`src/tools/tier0/memory_manage.ts`, store in `src/memory/curated.ts`) —
  durable, self-editable, re-injected into every subsequent turn via `enrichTurn`
  (`src/memory/lifecycle.ts:239`), survives compaction (`src/engine/compact-rebuild.ts:76`), and
  works on **both** single-agent and swarm surfaces. The most complete "agent edits its own
  context" primitive in the tree.
- **`request_permissions`** (`src/tools/tier0/request_permissions.ts`, wired in
  `src/cli/main.ts:367`) — live permission-mode elevation, ceiling-bounded, **single-agent only**.
  Its handler seam already **mutates the live permission mode mid-session** (`main.ts:388`) and the
  gate re-reads it every call.

Both **prove the reassembly-from-mutable-state pattern works end to end.** Everything else is frozen
at startup or changed only by a human via slash commands:

| # | Surface | Primitive | Agent-mutable at runtime? | Where |
|---|---|---|---|---|
| 1 | Tool catalog | `ToolDispatcher` (`register`, no `unregister`); `tool_search` | **No** (discovery only; catalog frozen at startup) | `src/tools/dispatcher.ts`, `src/tools/tier1/tool_search.ts` |
| 2 | Hooks | config-file `HookRuntime` (shell commands, content-hash trust) | **No** (startup/config; no agent hooks tool) | `src/hooks/{config,runtime,index}.ts` |
| 3 | Skills | `skill` load tool; sources re-scan disk each call | Load yes; **author no** (latent via `write_file`) | `src/tools/tier1/skill.ts`, `src/skills/*` |
| 4 | System prompt | per-turn reassembly from static inputs | Direct **no**; indirect via memory + `/plan` | `src/engine/default-system-prompt.ts` |
| 5 | Permissions | `request_permissions` | **Yes** (REPL/headless only, ceiling-bounded) | `src/tools/tier0/request_permissions.ts` |
| 6 | Curated memory | `memory_manage` / `memory_search` | **Yes** (durable, both surfaces) | `src/tools/tier0/memory_*.ts` |
| 7 | Turn loop / compaction | engine-owned; `requestManualCompaction` wired only to `/compact` | **No** (auto/env/user; only `todo_write`) | `src/engine/{native,compaction-runner}.ts` |
| 8 | Topology | `agent` spawn; coordinator reactive-spawn | Spawn **yes** (workers); topology rewrite **no** | `src/tools/tier2/agent.ts`, `src/swarm/topologies/coordinator.ts` |
| 9 | Model / effort | `/model` (user); child model via `agent` | Own config **no**; child's **yes** | `src/providers/routing.ts`, `src/tools/tier2/agent.ts` |

**Verdict:** openswarm is far closer to a live-harness-adjusting harness in **substrate** than in
**posture**. The per-turn `RunConfig` rebuild is a ready-made injection point, and openswarm already
owns the *validation machinery both reference papers had to hand-build*: worktrees, a shared task
registry, and **isolated verifier subagents that did not see the proposer's reasoning** (subprocess
isolation — the same structural check [docs/45](45-adaptive-orchestration-design.md) §3.1 leans on).
What is missing is (a) mutation surfaces beyond memory/permissions and (b) the *gate discipline* to
keep "dynamic" from becoming the §6b failure.

One notable latent path the inventory surfaced: `SkillSource.discover()`/`load()` re-read disk on
**every call**, and the `SkillProvider` folds skills into each turn's context — so an agent that
`write_file`s a `SKILL.md` into a discoverable root *already* gets it auto-surfaced next turn. The
cheapest form of "author your own harness fragment" is half-built already; it has simply never been
designed as a primitive.

---

## 4. Core principles

Two invariants govern everything below. **Principle 1 is a safety constraint** — it says what a
self-edit must survive before it takes effect. **Principle 2 is a feasibility constraint** — it says
which self-edits are worth building at all. Principle 1 keeps live adaptation from destabilizing the
run; Principle 2 decides the build order (§7). Most of this literature's enthusiasm is about mutation
surfaces; most of its *results* are about reward signals.

### 4.1 Principle 1 — immutable meta-loop, mutable surface, in-loop gate

From the control framing (§1) and openswarm's own scar tissue ([docs/45](45-adaptive-orchestration-design.md)
§6b — dynamic coordinator latitude *hurt* until structurally fenced):

> **The turn loop that *applies* edits must never be the thing being edited mid-flight. Every
> self-edit passes through a validation gate cheap enough to run *inside* the loop before it takes
> effect.**

Gates come in four costs; picking the right one per capability is the actual design work:

| Gate | Cost | openswarm already has it |
|---|---|---|
| **Reality** — "does the edit predict the next observation / pass the test?" | free, instant | `bash` / `repl` / test runs — *this is Schema's gate* |
| **Isolated verifier** — a subagent that did not see the proposer's reasoning | cheap, structural | `agent` spawn + subprocess isolation |
| **Advisory-only** — the edit adds a prompt fragment or data artifact, never touches control flow | ~free, bounded blast radius | memory `enrichTurn` injection path |
| **Regression suite** — full eval | slow, *offline only* | `swarmkit-eval` — *this is Self-Harness's gate* |

### 4.2 Principle 2 — the binding constraint is the reward signal

> **A self-harnessing capability is only as good as the reward it can be gated on. Rank capabilities
> by the quality of the signal available to score them — not by how much power the mutable surface
> grants.**

Every headline result in §2 is downstream of a reward its system could actually compute, cheaply and
often: Schema scores a world-model against the *next observation*; AutoHarness scores a candidate
harness against *legal-move rate*; Self-Harness scores a proposal against a *regression suite* (and
pays for it by running offline). Weng's framing makes the dependency explicit — search needs a fitness
function (§2.5). **Coding is the hard case precisely because its headline reward ("does it work") is
expensive, sparse, delayed, and only a partial oracle.**

But that is only true at the *task* altitude. Descend to the tool-call altitude and openswarm is
already rich in free, dense, exact signals:

| Reward signal | Cost | Density | Fidelity | Where it lives today |
|---|---|---|---|---|
| Tool-input schema validation (Zod) | ~0 | every call | **exact** (total oracle for well-formedness) | per-tool specs + `src/tools/dispatcher.ts` |
| Preconditions: path resolves, read-before-edit, `old_string` unique, patch applies | ~0 | every call | **exact** | `src/tools/tier0/read-state.ts`, `edit_file` |
| Parse / type-check / lint (`tsc --noEmit`) | seconds | per edit | high on types, **silent on logic** | `npm run build` via `bash` |
| Existing test suite | seconds–min | per change | **partial oracle**, and gameable (agent can edit the test) | `npm test` via `bash` |
| Isolated verifier subagent | one LLM call | per claim | judgment, noisy | `agent` spawn + subprocess isolation |
| Full regression eval | min–hours | per config | high, but **offline only** | `swarmkit-eval` (`eval/`) |

The top rows are **AutoHarness-grade**: free, dense, ground-truth. And they matter more than they look,
because of an observation about *what agents actually get wrong*:

> **Most agent coding failures are compliance failures, not knowledge failures** — a malformed tool
> call, a path that does not resolve, an edit against a stale read, a patch that will not apply,
> forgetting to run the build. The model usually *knows*; it fails to *comply* under generation
> pressure. That is exactly the failure class AutoHarness converts to a hard invariant, and exactly
> the class our free/exact signals can score.

**openswarm has already proven this pattern — by hand.** The Claude Code-aligned behaviors in
[docs/04](04-tool-tiers.md) are precisely compliance guards: **read-before-edit** enforcement,
`edit_file`'s **ambiguous-match rejection** (a deliberate divergence from the reference
implementation's silent first-match), and the **TOCTTOU stale-file check**. Each makes a known failure
*structurally impossible* rather than merely discouraged. They are hand-authored, author-time, and
global. **The self-harnessing version of openswarm is the one where the agent synthesizes new guards of
exactly this kind, at runtime, for the failure modes it is actually hitting in *this* repo** — with the
free/exact signals above as the validating reward. That is not a speculative leap; it is automating a
pattern the codebase already relies on.

Two consequences run through the rest of this doc:

1. **Build order follows reward availability** (§5.1, §7) — start where the signal is free and exact,
   climb the altitude chain only as fast as reward can be manufactured.
2. **Manufacturing dense reward where it is currently sparse is the real unlock** — and neither Schema
   nor AutoHarness solves it for open-ended coding. It is the central open question (§9 OQ1).

### 4.3 The promotion ladder (the synthesis)

Schema and Self-Harness feel like different things because they sit on **different rungs of one
ladder**, and openswarm is the rare runtime that can span the whole thing:

```
rung 1  EPHEMERAL   in-flight edit, this episode only          ← Schema (world-model program)
rung 2  VALIDATED   survived an in-loop gate (reality/verifier)
rung 3  DURABLE     promoted, persists across episodes          ← Self-Harness (regression-gated)
rung 4  OPTIMIZED   survived a held-out gate across cohorts     ← autonomation `gate()`
```

Schema lives on rungs 1–2 (mutate a world-model program against a free reality gate, fresh each
episode). Self-Harness *is* rung 3 (offline, regression-gated edit to the persistent harness).
The missing middle is a **rung-1 mutation surface** — build that, and a live edit that survives the
in-loop gate can *graduate* into a durable harness improvement.

> **⚠️ Correction (rev. 3) — the rung-3 target is cognitive-core, not `memory_manage`.**
> An earlier revision claimed openswarm "already has the rung-3 machinery (`memory_manage`,
> disk-backed skills)." In the three-repo ecosystem that is wrong, and consequentially so:
> `memory_manage` is a small curated fact/preference buffer (2500 char project / 1500 user) with **no
> consolidation, no attribution, and no confidence tracking**. Durable harness knowledge belongs in
> **cognitive-core**, which already implements rung 3 properly (`MutationGate` — a GEPA
> `StrictImprovementAcceptance` port — plus a `candidate-created → promoted | rejected` lifecycle and
> playbook lineage), and **rung 4 is autonomation's held-out `gate()`**. The promotion path is
> therefore an *inter-repo protocol*, not an openswarm-internal one. See
> [docs/64](64-harness-delta-and-measurement.md) §3.4.
>
> This also dissolves the "three-writer" hazard: cognitive-core's playbook store already had two
> writers and solved it by routing **every** write through `MutationGate`. L0 must be a **proposer,
> not a writer** — a third proposer into an existing gated path.

### 4.4 Two axes: altitude × durability

The ladder in §4.3 is one axis — *durability* (how long an edit lives). Weng's chain (§2.5) is the
orthogonal axis — *altitude* (what the edit targets). Every capability in §5 plots on the grid:

| altitude ↓  /  durability → | ephemeral | validated → durable |
|---|---|---|
| **prompt / context** | live fragments (#2) | curated memory (#6) — *ships today* |
| **workflow / control flow** | verification contracts (#4) | isolated-verifier promotion |
| **harness code** (tools, guards) | world-model register (#1), action guards (#4b) | agent-authored tools (#3) |
| **optimizer code** | — *out of scope for this spike* — | — |

The grid makes the roadmap legible: openswarm already occupies the *prompt/context* row (ephemeral
fragments are cheap to add; durable memory ships today); the frontier is **climbing to harness code**
while holding altitude-appropriate gates. We deliberately stop below *optimizer code* — that is the
SIA/RSI regime (§2.5) and out of scope here.

### 4.5 The edit loop is a search

Generating a good self-edit is not one shot; it is a **search over harness variants with the model as
the mutation operator and the in-loop gate as the reward** — AutoHarness's Thompson-sampling REx
(§2.4) and Weng's "harness code as a search space" (§2.5). openswarm already has the substrate:
parallel subprocess workers give *breadth* (sample *K* candidate harnesses at once), the
reality/verifier gates give *reward*, and best-of-N selection (the
[docs/45](45-adaptive-orchestration-design.md) §6b.4 ensemble finding — the one place multi-agent
*did* add value) gives *selection*. The open pieces are the **selection policy** (Thompson sampling
vs. plain best-of-N vs. evolutionary) and its **budget** — §9.

Note the identity that connects the two principles: **the in-loop gate of §4.1 *is* the fitness
function of §4.2.** Safety and search are the same mechanism viewed from two directions — which is why
a capability with no cheap gate is not merely unsafe, it is *unsearchable*. REx's explore/exploit
split (§2.4) is the missing discipline on top: openswarm's ensemble machinery naturally does
*exploration* (K independent variants); *exploitation* (iteratively refining the best partial harness)
is the part we would have to add.

---

## 5. Capability menu — each mapped to surface + seam + gate + failure

| # | Capability | Mutable surface | Seam | In-loop gate | Failure it courts | Effort |
|---|---|---|---|---|---|---|
| 1 | World-model register | executable model of the task/env | `repl` + scratch module | **reality** (free) | none catastrophic | med |
| 2 | Live harness fragments | task-specific playbook text | skills disk re-scan + `enrichTurn` | **advisory** | bad instruction | **low** |
| 3 | Agent-authored tools | the tool catalog | `ToolDispatcher.register` + `tool_search` | reality (dry-run) + permission tier | new capability escapes gate | high |
| 4 | Verification contracts **& action guards** | completion rule + pre-action code guard | `verifiedCompletion` + `agent` + guard in dispatch | **isolated verifier** / **reality** | over-strict → non-termination | med |
| 5 | Loop / context controls | context runway, budget | `requestManualCompaction`, budget soft-stops | bounded/idempotent | thrash | low |
| 6 | Generalized self-elevation broker | tools / budget / model grants | `PermissionRequestHandler` | operator approval + ceiling clamp | over-asking | med |
| 7 | Runtime topology mutation | the `TeamSpec` | Conductor → `TeamSpec` | isolated verifier + ensemble-select | §6b coordination overhead | high |

**The numbers are stable identifiers, not build order.** Build order is derived separately, from reward
availability (§4.2), and lives in §5.1 / §7.

**1. World-model register — the Schema move, generalized.** The most transferable idea: let the
agent maintain an *executable program* as its evolving model of the task/environment, run a
contradiction→experiment→revise loop, and plan inside it. Seam: the `repl` tool (Tier 5, persistent
stateful python/node) + a scratch module the agent writes and re-executes each turn; the harness
surfaces "your model predicted X, reality was Y" as the next observation. Gate: **reality (free).**
This is the purest in-flight adaptation and the one place openswarm could plausibly *reproduce
Schema-style gains* on interactive coding tasks (modeling a flaky test's hidden state machine, an
unfamiliar API's behavior). Highest conceptual value.

**2. Self-authored harness fragments ("live skills").** Formalize the latent path from §3: a
`define_skill` / `harness_note` tool that writes a task-specific playbook fragment ("in this repo,
always run `X` before `Y`") which re-injects next turn. Seam: skills re-scan + memory `enrichTurn`.
Gate: **advisory-only** — it is just prompt text; worst case is a bad instruction. The cheapest item
here; the in-flight analog of Self-Harness's "harness proposal," minus the risk. Strong first wedge.

**3. Agent-authored tools (`define_tool`).** The real "grow the catalog" capability. Today
`ToolDispatcher` has `register()` but **no `unregister`, and registration is startup-only** — the
catalog is frozen. Expose a *gated* runtime `register` where the agent promotes a working command
pipeline into a **named, re-plannable** tool for the rest of the session. Seam:
`ToolDispatcher.register` + `tool_search` (already ranks over the live registry). Gate: **reality
(dry-run) + permission tier**. Highest leverage, **highest risk** → strongest fence; start advisory
(the "tool" is a saved macro, not arbitrary new capability).

**4. Runtime verification contracts.** This one *fixes* the §6b failure instead of courting it. Let
the agent declare a *completion contract* at runtime — a check that must pass before the loop may
terminate — backed by an **isolated verifier subagent**. openswarm already shipped
`coordination.verifiedCompletion` (commit b2cc557) but it is *author-set*; make it agent-declarable.
Seam: `verifiedCompletion` gate + `agent` spawn. Gate: **isolated verifier.** Highest-ROI *safety*
capability — the in-flight version of Self-Harness's regression gate and the structural fix for the
premature-termination mode the codebase already diagnosed.

**4b. Action guards (the AutoHarness move).** Sharper still: alongside the *post-hoc* completion gate,
let the agent **synthesize a *pre-hoc* code guard** — a check in the tool-dispatch path
(`ToolDispatcher.dispatch`, `src/tools/dispatcher.ts`) that makes an illegal tool call *impossible*,
validated by the free **reality** gate the way AutoHarness (§2.4) reaches a 100% legal-action rate in
~14 iterations. Guard-before-act is strictly safer than verify-after-act for the failure classes it
covers, and it is the natural fence for capability #3 (an agent-authored tool ships *with* the guard
that bounds it).

**5. Agent-steerable loop / context controls.** `requestManualCompaction()` (`native.ts:147`)
already exists but is wired *only* to the user's `/compact`. Expose a bounded agent tool for it,
plus "extend my budget by N turns with justification." Seam: the manual-compaction queue + budget
soft-stops. Gate: bounded/idempotent. Lets an agent manage its own context runway — cheap,
low-drama, immediately useful on long tasks.

**6. Generalized self-elevation broker.** The `request_permissions` handler (`main.ts:367`) is
already a proven *live-mutation broker*: clamp-to-ceiling + operator-approval + mutate-live-state.
Generalize that exact pattern into one "request harness change" seam covering tool grants, budget
bumps, and model switches — reusing the clamp/approve machinery rather than inventing per-capability
plumbing. Seam: `PermissionRequestHandler`. Gate: **operator approval + ceiling clamp.** Also closes
the noted gap that elevation is not wired on worker/ACP surfaces.

**7. Runtime topology mutation (the Conductor emits a live `TeamSpec`).** The swarm-native version —
the "planner that emits a `TeamSpec` at runtime" the inventory confirms *does not exist* (only
static loaders + coordinator reactive-spawn). Ranked **last and treated cautiously**: openswarm's
own evidence ([docs/45](45-adaptive-orchestration-design.md) §6b.4) is that coordinated teams reach
*parity, not gain*, and the value that *did* appear was **ensemble/trajectory variance, not
within-task coordination**. Honest framing: live topology mutation is worth it as **best-of-N over
diverse self-configured attempts**, not as smarter coordination.

### 5.1 Build order follows reward availability

Ranking by *mutation power* would put the world-model register and agent-authored tools first — they
grant the most. Ranking by **Principle 2** (§4.2) inverts much of that: build order is
`f(reward availability, risk)`, and a capability whose reward must first be invented is a research
project, not a first increment.

| Order | Capability | Reward it is gated on | Class | Why here |
|---|---|---|---|---|
| **1** | **#4b action guards** | schema / preconditions / patch-applies | **free, dense, exact** | The one place AutoHarness's precondition holds *today*; targets the dominant failure class (compliance); automates a pattern openswarm already hand-wrote (§4.2) |
| **2** | **#2 live fragments** | none needed (advisory) | n/a | Cheapest possible edit; blast radius is prompt text; the skills re-scan path is half-built already (§3) |
| **3** | **#4 verification contracts** | tests + isolated verifier | costly, partial | The fence every higher-altitude capability depends on; directly fixes the measured §6b failure |
| **4** | **#5 loop / context controls** | bounded, idempotent | n/a | Small, safe, immediately useful on long tasks |
| **5** | **#3 agent-authored tools** | dry-run + its own guard | exact, but **risk**-bound not reward-bound | Needs #4b's guard and #4's fence to exist first |
| **6** | **#1 world-model register** | must be **manufactured** | **sparse — open problem** | Highest ceiling, lowest confidence in a coding domain; gated on OQ1 |
| **7** | **#6 broker · #7 topology** | operator approval · ensemble select | judgment | Organizational plumbing; and the speculative swarm tail (§6b caution) |

The revision worth flagging explicitly: **an earlier draft of this spike opened with #1 (world-model
register).** Under Principle 2 that is the wrong first move — it is the highest-ceiling capability but
the one whose reward signal openswarm does *not* yet have, so it would be built without a way to know
whether it works. It moves to position 6, behind the capabilities that can be honestly scored.

---

## 6. Risks & the critiques we must answer

- **The §6b lesson is binding.** In [docs/45](45-adaptive-orchestration-design.md), dynamic latitude
  *hurt* until structurally fenced, and part of the "structural overhead" finding was a spawn *bug*,
  not a result. Rule: **dynamic ≠ better; dynamic + an in-loop gate = better.** The gate discipline
  in §4.1 is the fence, and it is non-negotiable. Every capability in §5 ships *with* its gate or not
  at all.
- **The strong-single-agent baseline (arXiv 2601.12307) still holds.** Live self-harnessing is a
  **single-agent superpower first, a swarm feature second.** Capabilities 1–5 all land on the
  single-agent path; the swarm items (6 tail, 7) are the speculative edge. Do not let "self-adjusting
  harness" become a back door to re-litigating homogeneous multi-agent teams.
- **"How much intelligence is baked in?"** A self-authored harness is the clean rebuttal (§2.6) —
  and we make it *measurable* with an agent-authored vs. hand-authored ablation, not a claim.
- **Safety of self-authored capability (item 3).** Agent-registered tools are the sharpest edge.
  Keep them inside the existing permission engine and the worktree sandbox; start as saved macros
  over already-permitted commands; require the dry-run reality gate before a new tool is planable.
- **"Confident regression"** (Weng, §2.5) is the precise name for our §6b failure: a self-edit that
  improves a proxy while degrading the task, with nothing to catch it. The defense is not caution —
  it is evals, isolation, and auditable traces, which openswarm already has and must keep wired into
  every self-edit path.
- **Reward hacking is a live risk once tests are the gate.** The test-suite row in §4.2 is *gameable*:
  an agent that may edit tests can satisfy the reward without doing the work. Any gate that scores
  against tests must treat the test files as **read-only for the agent being scored**, or delegate
  scoring to an isolated verifier that re-derives the check.

### 6.1 Bridge or crutch? (the bitter-lesson objection)

The strongest objection to this whole program: **is self-authored harness structure just compensating
for weaknesses the next model absorbs?** Weng hedges honestly ("hard to forecast how much RSI will rely
on harnesses"), and the bitter lesson favors general search and learning over hand-crafted structure.
Taking it seriously, the useful move is to split the program into what decays and what compounds:

| | Absorbed by the next model — *rent it* | Compounds across models — *build it* |
|---|---|---|
| **What** | prompt scaffolds, reasoning nudges, workflow tricks that paper over a current gap | (a) the **reward / verification / isolation / trace infrastructure**; (b) the **durable-promotion flywheel** |
| **Why** | these encode a model's present deficiencies; a stronger model makes them redundant or harmful | (a) verification is a property of *reliable systems*, not a model crutch — no upgrade removes the need to check; (b) validated edits become **data** (memory/skills) that survives model swaps and accumulates per repo |

So the bitter lesson does not refute harness engineering — **it tells us which layer to build.** Note
also that it *rewards* the flywheel: a harness that turns validated experience into reusable data is
the general, model-independent asset, while a hand-tuned prompt scaffold is exactly the hand-crafted
structure the lesson punishes. The `prompt → … → optimizer code` chain (§2.5) is therefore also a
**durability gradient**: the low rungs decay fastest.

This is falsifiable, and §8 should test it: re-run **LH1** on a materially stronger model. If the
agent-authored scaffold's advantage vanishes, we are in the crutch regime and should stop investing
above the infrastructure layer. If the *accumulated, promoted* guards still pay (LH4), the flywheel is
real and compounding.

---

## 7. Phased rollout

Sequenced by §5.1 — *start where the reward is free, climb only as fast as reward can be manufactured.*

- **P0 — Compliance guards (#4b) + live fragments (#2).** The wedge, and the only increment where
  AutoHarness's preconditions already hold. Concretely: a `define_guard` tool that lets an agent
  synthesize a **pre-hoc predicate evaluated in `ToolDispatcher.dispatch`** (`src/tools/dispatcher.ts`)
  before a tool call executes — seeded by the failure it just hit, validated by replaying against the
  free/exact signals in §4.2, **ephemeral by default**, and promotable as a *candidate* into
  cognitive-core's `MutationGate` (**not** `memory_manage` — see §4.3 and
  [docs/64](64-harness-delta-and-measurement.md) §3.4).
  Deliberately pinned to the **constrained end of AutoHarness's dial** (§2.4): a conditioning function
  that vetoes bad calls, *never* code-as-policy. Pair with #2 (advisory fragments) so P0 exercises the
  full ladder (§4.3) at two altitudes. Deliverable: a measurable claim — *"agent-synthesized guards cut
  compliance failures without harming resolve."*
  **Update (§10):** the live run forced the **in-loop validation gate** from a nicety into a P0
  requirement — a synthesized guard must be dry-run against the session's recent *successful* calls and
  rejected if it would block them, *before* it enforces (a weak model's over-broad guard was otherwise
  net-harmful). This is landing now.
- **P1 — Verification contracts (#4).** Agent-declarable completion gates backed by isolated verifiers;
  the prerequisite fence for anything touching control flow, so it lands before the riskier rungs.
- **P2 — Context self-management (#5) + generalized broker (#6).** Expose `requestManualCompaction`
  and the generalized `request_harness_change` broker; close the worker/ACP elevation gap.
- **P3 — Agent-authored tools (#3).** Only after P0's guards and P1's fence exist — a new tool ships
  *with* the guard that bounds it. Start as saved macros over already-permitted commands.
- **P4 — Reward manufacturing (OQ1), then the world-model register (#1).** The research rung: build a
  denser signal for open-ended coding (property-based/differential testing, self-authored assertions,
  verifier-as-reward-model), *then* the highest-ceiling capability becomes honestly gateable. Attempting
  #1 before this is building without a way to know it works.
- **P5 — Runtime topology (#7).** Speculative. Conductor emits a live `TeamSpec`, framed as
  best-of-N/ensemble-select, measured against the single baseline.

The promotion ladder is threaded throughout: any P0–P5 edit that survives its in-loop gate is emitted
as a **candidate** into cognitive-core's `MutationGate` (rung 3) and, if it survives autonomation's
held-out `gate()`, becomes rung 4 — the ecosystem's version of Self-Harness, **earned online, kept
offline**, and the compounding asset §6.1 argues survives model upgrades. See
[docs/64](64-harness-delta-and-measurement.md) §3.4 for the protocol.

---

## 8. Evaluation (the co-equal deliverable)

Built on `swarmkit-eval` (the same harness [docs/45](45-adaptive-orchestration-design.md) §6 uses),
so results are comparable to the existing frontier studies. Each hypothesis is an arm with a kill
criterion.

| # | Hypothesis | Arm | Proves / reproduces |
|---|---|---|---|
| **LH1** | **Agent-synthesized compliance guards (#4b) cut tool-call/compliance failures without harming resolve** | with/without `define_guard`, same model | The P0 claim; AutoHarness's mechanism where its preconditions hold |
| **LH1b** | An agent-authored in-flight scaffold beats a fixed scaffold on a task class with hidden mechanics | self-harnessing vs. fixed, same model | The Schema thesis on our tasks — *blocked on OQ1 reward* |
| **LH2** | The intelligence is the model's, not the engineer's | agent-authored vs. hand-authored scaffold, held constant | Answers the "baked-in" critique with data |
| **LH3** | Runtime verification contracts (#4) reduce premature termination without harming resolve | with/without agent-declared gate | The §6b fix, generalized |
| **LH4** | A live edit promoted to durable memory transfers to future runs on the same repo | measure run N+1 after run N's promotion | The promotion ladder pays off |
| **LH5** | Agent-authored tools (#3) reduce steps/tokens without new failure modes | with/without `define_tool`, MAST-judged | Capability-growth is net-positive & safe |
| **LH6** | A *cheap* model synthesizing the harness a run executes beats the big model run directly, at lower cost | cheap-synth + execute vs. big-model-direct | AutoHarness's cost result, ties [docs/50](50-heterogeneous-cost-scaling.md) |
| **LH7** | **Bridge-or-crutch:** the gains do *not* evaporate on a materially stronger model | re-run LH1/LH4 across a model generation | §6.1 — separates the decaying layer from the compounding one |

**Metric note (LH1).** Terminal resolve-rate is too coarse to see the P0 effect; the primary metric is
a **compliance-failure count** read off the trace — malformed tool inputs, failed preconditions,
retried/aborted calls — with resolve-rate as the guardrail (the guard must not trade compliance for
task success). MAST modes FM-1.3 (step repetition) and FM-3.2 (incomplete verification) are the
secondary read.

Disciplines carried over from [docs/45](45-adaptive-orchestration-design.md) §6: always report
against the **strong single-agent baseline**; primary metric = terminal task success, secondary =
tokens / wall-clock / $; MAST 14-mode judge over traces to see *which failure mode* each capability
moves. LH1 is the near-term headline and LH2 the framing one; LH3 is the safety proof; LH4 + LH7
together are the differentiator (a flywheel that survives model upgrades). Per *Stop
Comparing LLM Agents Without Disclosing the Harness* ([arXiv 2605.23950](https://arxiv.org/abs/2605.23950)),
every arm records the exact harness (fixed vs. the agent-authored delta) as a first-class artifact, so
a self-harnessing score is never confounded with a hidden hand-tuned scaffold.

---

## 9. Open questions

1. **⭐ Manufacturing dense reward for open-ended coding — the central open problem.** Everything above
   position 4 in §5.1 works because a free, exact signal already exists; everything below it stalls
   because one does not. Neither Schema (free next-observation prediction) nor AutoHarness (free
   legal-move rate) solves this for our domain, and it is the real unlock. Candidate directions, none
   yet evaluated: **property-based / differential testing** (compare against a reference or a prior
   revision to get a dense, non-gameable signal), **agent-authored assertions** promoted to invariants
   once validated, **the isolated verifier as a cheap learned reward model**, and DemoEvolve-style
   **densification from demonstrations** ([2605.24539](https://arxiv.org/abs/2605.24539)). Solving this
   converts #1 and much of the altitude chain from speculation into engineering.
   > **Update (rev. 3) — this has a framework in the ecosystem.** autonomation's **ladder of
   > learnability** (`design/ladder-of-learnability.md`) is a formal treatment of exactly this
   > question: five rungs (`bias-search → gate → dense-shape → learned-reward → RL`), a routing rule
   > (**ADR-0004**: *telemetry guides freely; scores only under control*), and — the key mechanism —
   > **reification**, replaying a flagged trajectory into a *controlled* eval instance so a soft
   > observational signal **earns the right to gate**. §4.2's reward table is best read as a
   > domain-specific instance of that ladder. OQ1 is therefore an **integration**, not open research;
   > what remains genuinely open is CRN determinism ([docs/64](64-harness-delta-and-measurement.md)
   > §7 OQ1), which decides whether L0 signals may ever *score* rather than only *guide*.
2. **World-model register representation (#1).** Free-form `repl` module vs. a typed
   state+transition schema the harness can introspect and diff. The typed form enables a cleaner
   reality gate but constrains what the model can express.
3. **Advisory vs. binding fragments (#2).** Do live skills only *inform* the model (safe, weak), or
   can they set constraints the harness *enforces* (strong, riskier)? P0 starts advisory.
4. **Where does a rung-1 delta live?** A new `RunConfig.harnessDelta` folded in at
   `worker-entry.ts:311`, or ride entirely on the existing memory/skills injection paths? The latter
   is zero-new-plumbing but couples harness edits to the memory format.
5. **Gate budget.** How much of an episode's token/latency budget may the in-loop gates consume
   before self-harnessing is net-negative? Needs an explicit accounting arm.
6. **Promotion trust (rung 2→3).** What evidence promotes an ephemeral edit to durable — one
   isolated-verifier pass, N passes, or an offline regression confirmation on the next idle cycle?
7. **Interaction with compaction.** A durable harness edit must survive compaction like curated
   memory does (`compact-rebuild.ts:76`); an ephemeral one must *not* leak past the episode.
8. **Selection policy for the edit search (§4.5).** Thompson-sampling REx (AutoHarness), plain
   best-of-N ([docs/45](45-adaptive-orchestration-design.md) §6b.4), or an evolutionary optimizer
   (GEPA / A-Evolve)? And what breadth *K* of parallel variant-harnesses is net-positive against the
   gate budget (OQ 5)?
9. **Where on AutoHarness's dial do we stop?** P0 pins the constrained end (conditioning function
   only). Is there ever a case for *code-as-policy* in a coding harness — a fully compiled, LLM-free
   sub-loop for a recurring mechanical task — or does that forfeit the adaptivity that motivates the
   whole program?
10. **Catching a mis-diagnosed guard (§10.4).** The recent-successes gate misses the observed
    failure: a guard installed right after failures, whose clause blocks lines that are legitimately
    editable but have only *failed* so far, and whose `message`/`failureSignature` give wrong advice
    (Nova Pro: "use `replace_all`" when the fix was a unique anchor). A relevance check ("blocks ≥1
    recent failure of its signature") does not help — the guard *did* block the failures; it also
    blocked the fix. This likely needs an **isolated-verifier review** of the candidate guard
    (doc-64 §3.3), i.e. the promotion gate, not a dry-run. Open: is there a cheap structural signal
    (e.g. the guard's `message` contradicting the actual error text) that flags misdiagnosis without a
    verifier call?

---

## 10. Live validation (2026-07-27)

First live runs of the shipped P0 (`define_guard` + recurrence trigger) against real models
(Azure gpt-5.5; Bedrock Nova Lite / Nova Pro / Llama-3.3-70B via the native engine). Scenario: a small
file with N identical lines requiring *distinct* edits, so `replace_all` is useless and a short anchor
is ambiguous — the exact compliance trap `edit_file` rejects (docs/04). Method note: the first live
call also caught a real bug — `define_guard`'s input was a `z.discriminatedUnion`, which serialises to
a root `anyOf` and Azure rejects (`parameters` must be `type: object`); fixed to a flat object. Offline
tests never serialised the tool through a provider's function-calling validator.

### 10.1 The mechanism works end-to-end — measured, not asserted

On **Nova Pro** (the one model found in the target band, see §10.3) the **entire loop fired with a live
model**: 3 real `Found N matches` failures → the recurrence detector clustered them by signature and
**fired the nudge** at threshold 2 → the model **read the nudge and called `define_guard`** with a
well-formed predicate → the guard **installed and enforced** (evaluated 35×, **fired 10×**). The
`harness_guard_summary` was captured off **stderr** (the §-added sandbox-observability channel), proving
that path too. Every mechanical component of P0 is validated live.

### 10.2 …but the weak model's guard was net-harmful — the risk in §6.1/§4.1 is real

The guard Nova Pro wrote was **mis-diagnosed**, and it harmed the run through two mechanisms:

```
block edit_file when ANY of:
  field_matches replace_all "false"          ← matches the model's EXPLICIT replace_all:false edits
  field_matches old_string "statuses.push(0);"  ← matches edits to the very lines the task must change
failure_signature: "multi-replace-without-replace_all"   ← wrong: the fix is a unique anchor, not replace_all
message: "…set replace_all to true or provide more context…"
```

1. **It blocked the model's own legitimate edits.** Nova Pro set `replace_all` explicitly on every call
   (12 × `false`, 25 × `true`; never omitted — so the `false` clause was not the near-universal match a
   naive reading suggests, it matched the explicit-`false` edits), and the `old_string` clause matched
   edits to the target lines. The guard fired 10×, blocking work the task required.
2. **Its mis-diagnosis gave harmful advice.** The `failure_signature` and message blamed "not using
   `replace_all`" — wrong; the real fix is a *unique anchor*. Following that advice, the model issued
   `replace_all: true` against a **non-unique** anchor (`old_string="statuses.push(0);"`), rewriting
   **all six** lines at once → the file collapsed to a single value (final state: all `401`).

Final state: **task failed**, 19 total failures, 37 flailing `edit_file` calls. **A weak proposer,
correctly nudged, authored a guard that made things worse** — through misdiagnosis and self-harmful
advice, not raw over-breadth. This is exactly the doc-63 §6.1 "crutch" hazard and the doc-64 §3.3
weak-proposer concern, now observed. (An earlier draft of this section mis-stated the mechanism as
"blocks almost every edit because `replace_all` defaults to false" — corrected here after reading the
trace: `field_matches` returns false on an *absent* field, so the harm was misdiagnosis + the
`old_string` clause, not default-field over-breadth.)

**The safety invariant held, though:** the guard only ever *blocked* — `effect: "restrictive"` (§3.1) is
a literal type, so even a wrong guard could not grant capability. The blast radius was **over-blocking**,
not danger. "Narrow, never widen" contained a bad guard.

### 10.3 The target regime is a narrow model band

| Model | Drives the tool loop? | Enters the guard regime? |
|---|---|---|
| Azure gpt-5.5 | yes | **no** — too capable; 0 compliance failures across 5 runs (incl. a resolved 590s SWE-bench-Verified instance) |
| Bedrock Nova Lite | **no** — emits text, never calls tools | too weak to act (docs/45's gpt-4.1 failure mode) |
| Bedrock Llama-3.3-70B | errors — *"tool use in streaming mode"* unsupported on Bedrock Converse | n/a |
| **Bedrock Nova Pro** | **yes** | **yes** — fumbled the trap and triggered the full loop |

Confirms HarnessX's "smaller models benefit most" **with a sharp refinement: benefit is not
automatic.** The band that (a) reliably drives tools *and* (b) repeatedly fumbles compliance is narrow,
and inside it a self-authored guard can be net-negative without a quality gate.

### 10.4 What this forces — the in-loop validation gate is now a P0 prerequisite

P0 as shipped installs a synthesized guard **unconditionally** and enforces it immediately. §10.2 shows
that is unsafe-for-utility (not unsafe-for-capability): the fix is the in-loop gate this doc deferred
(§4.1). The **minimal, cheap** form: before a guard is allowed to enforce, **dry-run it against the
session's recent *successful* calls to its target tool; reject it if it would have blocked them** — and
hand the blocked sample back so the model can *narrow* it. That is the "does not block good calls" half
of the gate; it is being implemented now (see §7 P0, updated).

Honest limitation, straight from this trace: the recent-successes gate would **not** have caught *this*
guard. Nova Pro installed it right after the ambiguous *failures*, so there was no successful edit to
the target lines to dry-run against — and its harmful `old_string` clause matched exactly those
lines, which at that point had only *failed*. The gate catches over-restriction once good calls exist;
it cannot catch a guard that blocks lines which are legitimately editable but have not yet been edited
successfully, nor one whose *advice* (message / `failure_signature`) is wrong. Those need richer
validation — an isolated-verifier review of the candidate guard (doc-64 §3.3's promotion gate), not a
cheap dry-run — and are logged as OQ 10. The recent-successes gate remains worth shipping: it is the
cheapest correct check and catches the common "agent tightens too far after things were working" case.

---

## Sources

- **Schema** — Frontier Models with Our Harness Achieve ~99% on ARC‑AGI‑3 Public
  ([schema-harness.github.io](https://schema-harness.github.io/)); community discussion
  ([HN 48935905](https://news.ycombinator.com/item?id=48935905)). Results self-reported on the public
  set, not independently verified by ARC Prize.
- **Self-Harness: Harnesses That Improve Themselves** — [arXiv 2606.09498](https://arxiv.org/abs/2606.09498).
- **AutoHarness: improving LLM agents by automatically synthesizing a code harness** — Google DeepMind,
  [arXiv 2603.03329](https://arxiv.org/abs/2603.03329) (Thompson-sampling/REx search over harness code;
  ~100% legal actions across 145 TextArena games; small-model-synthesis beats larger models at lower cost).
- **Adaptive Auto-Harness** ([arXiv 2606.01770](https://arxiv.org/abs/2606.01770)) and the evolutionary
  optimizers it surveys (A-Evolve, GEPA, Meta-Harness); **SIA** — self-improving harness *and* weights
  ([arXiv 2605.27276](https://arxiv.org/abs/2605.27276), the boundary this spike does not cross);
  **DemoEvolve** — demonstrations for sparse-feedback harness evolution
  ([arXiv 2605.24539](https://arxiv.org/abs/2605.24539)).
- **Harness Engineering for Self-Improvement** — Lilian Weng, Lil'Log 2026-07-04 (~35-paper survey; the
  `prompt → context → workflow → harness code → optimizer code` chain adopted in §4.2). **Stop Comparing
  LLM Agents Without Disclosing the Harness** — [arXiv 2605.23950](https://arxiv.org/abs/2605.23950)
  (the disclosure discipline behind LH2 / §8).
- **Continual Harness** — reset-free self-improving agents on ARC‑AGI‑3
  ([sethkarten.substack.com](https://sethkarten.substack.com/p/continual-harness-an-efficient-self)); **SEAGym**
  self-evolving-agent evaluation ([arXiv 2606.17546](https://arxiv.org/abs/2606.17546)).
- **Strong Single-Agent Baseline** — *Rethinking the Value of Multi-Agent Workflow*
  ([arXiv 2601.12307](https://arxiv.org/abs/2601.12307)); **MAST** — *Why Do Multi-Agent LLM Systems
  Fail?* ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)).
- Internal: [docs/45-adaptive-orchestration-design.md](45-adaptive-orchestration-design.md) (the
  Conductor seam, the §6b dynamic-latitude findings, the eval discipline this doc reuses).
