# 63 — Live Harness Adjustment: agents that author and revise their own running harness

**Status:** Draft for discussion (design spike) · **Author:** (design spike) · **Date:** 2026-07-24

> Goal: explore whether openswarm can become a harness whose agents make **on-the-fly
> adjustments to their own running harness** — tools, prompts, verification rules, control
> flow — and do so *safely*, without regressing into the multi-agent failure modes openswarm
> already measured in [docs/45](45-adaptive-orchestration-design.md) §6b. This is a design
> spike: a mapping from external evidence onto openswarm's real seams, plus a phased,
> eval-gated plan. It is **not** a design lock.

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
**beats larger models** (Gemini-2.5-Pro, GPT-5.2-High) at lower cost — and a *code-as-policy* variant
lets the harness *replace* the policy outright.

Three ideas transfer directly:
1. **A harness is most powerful as a *code guard*, not a prompt.** The strongest self-edit is one that
   makes a class of mistakes *impossible*, not one that advises against them. (Sharpens §5 #4.)
2. **Self-improvement is a search with a cheap reward.** LLM-as-mutation-operator + a free environment
   signal + Thompson-sampling selection is a concrete algorithm for *how* to generate and pick harness
   edits — the disciplined form of best-of-N. (Feeds §4.3.)
3. **A cheap model can write the harness a run then executes**, connecting to openswarm's heterogeneous
   cost-scaling work ([docs/50](50-heterogeneous-cost-scaling.md)): synthesis is a cheap-tier job,
   execution need not be. (Feeds LH6.)

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

Each step up the chain unlocks a strictly larger design space than the last; the endpoint (the agent
editing the code that *optimizes* the agent) is recursive self-improvement **without touching
weights**. That is the openswarm-native reframing of the whole idea: not a model rewriting its weights,
but the model **authoring the system around it**.

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

## 4. Core principle — immutable meta-loop, mutable surface, in-loop gate

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

### 4.1 The promotion ladder (the synthesis)

Schema and Self-Harness feel like different things because they sit on **different rungs of one
ladder**, and openswarm is the rare runtime that can span the whole thing:

```
rung 1  EPHEMERAL   in-flight edit, this episode only          ← Schema (world-model program)
rung 2  VALIDATED   survived an in-loop gate (reality/verifier)
rung 3  DURABLE     promoted to memory/skills, persists         ← Self-Harness (regression-gated)
```

Schema lives on rungs 1–2 (mutate a world-model program against a free reality gate, fresh each
episode). Self-Harness *is* rung 3 (offline, regression-gated edit to the persistent harness).
openswarm already has the **rung-3 machinery** (`memory_manage`, disk-backed skills) and the
**rung-2 machinery** (isolated verifiers). The missing middle is a **rung-1 mutation surface**.
Build that, and a live edit that survives the isolated-verifier gate can *graduate* into a durable
harness improvement via primitives that already exist. **That promotion path is the thing neither
paper had, and it is openswarm's natural edge.**

### 4.2 Two axes: altitude × durability

The ladder in §4.1 is one axis — *durability* (how long an edit lives). Weng's chain (§2.5) is the
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

### 4.3 The edit loop is a search

Generating a good self-edit is not one shot; it is a **search over harness variants with the model as
the mutation operator and the in-loop gate as the reward** — AutoHarness's Thompson-sampling REx
(§2.4) and Weng's "harness code as a search space" (§2.5). openswarm already has the substrate:
parallel subprocess workers give *breadth* (sample *K* candidate harnesses at once), the
reality/verifier gates give *reward*, and best-of-N selection (the
[docs/45](45-adaptive-orchestration-design.md) §6b.4 ensemble finding — the one place multi-agent
*did* add value) gives *selection*. The open pieces are the **selection policy** (Thompson sampling
vs. plain best-of-N vs. evolutionary) and its **budget** — §9.

---

## 5. Capability menu (ranked), each mapped to seam + gate + failure

| # | Capability | Mutable surface | Seam | In-loop gate | Failure it courts | Effort |
|---|---|---|---|---|---|---|
| 1 | World-model register | executable model of the task/env | `repl` + scratch module | **reality** (free) | none catastrophic | med |
| 2 | Live harness fragments | task-specific playbook text | skills disk re-scan + `enrichTurn` | **advisory** | bad instruction | **low** |
| 3 | Agent-authored tools | the tool catalog | `ToolDispatcher.register` + `tool_search` | reality (dry-run) + permission tier | new capability escapes gate | high |
| 4 | Verification contracts **& action guards** | completion rule + pre-action code guard | `verifiedCompletion` + `agent` + guard in dispatch | **isolated verifier** / **reality** | over-strict → non-termination | med |
| 5 | Loop / context controls | context runway, budget | `requestManualCompaction`, budget soft-stops | bounded/idempotent | thrash | low |
| 6 | Generalized self-elevation broker | tools / budget / model grants | `PermissionRequestHandler` | operator approval + ceiling clamp | over-asking | med |
| 7 | Runtime topology mutation | the `TeamSpec` | Conductor → `TeamSpec` | isolated verifier + ensemble-select | §6b coordination overhead | high |

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

---

## 6. Risks & the critiques we must answer

- **The §6b lesson is binding.** In [docs/45](45-adaptive-orchestration-design.md), dynamic latitude
  *hurt* until structurally fenced, and part of the "structural overhead" finding was a spawn *bug*,
  not a result. Rule: **dynamic ≠ better; dynamic + an in-loop gate = better.** The gate discipline
  in §4 is the fence, and it is non-negotiable. Every capability in §5 ships *with* its gate or not
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

---

## 7. Phased rollout

- **P0 — The wedge (thesis test).** Ship **#1 (world-model register)** + **#2 (live harness
  fragments)**, both single-agent, both with the cheapest gates (reality + advisory), both
  promotable to durable via `memory_manage`. Smallest change that exercises the *whole* ladder
  (§4.1). Deliverable: a measurable claim — "agent-authored in-flight scaffold beats fixed scaffold
  on task class X."
- **P1 — Safety rail (#4).** Agent-declarable verification contracts backed by isolated verifiers.
  This is a prerequisite fence for anything that touches control flow, so it lands early.
- **P2 — Context self-management (#5) + generalized broker (#6).** Expose `requestManualCompaction`
  and the generalized `request_harness_change` broker; close the worker/ACP elevation gap.
- **P3 — Agent-authored tools (#3).** Only after P1's gate exists. Start as saved macros; graduate
  to gated command tools; never arbitrary new capability without the reality gate.
- **P4 — Runtime topology (#7).** Speculative. Conductor emits a live `TeamSpec`; framed as
  best-of-N/ensemble-select, measured against the single baseline.

The promotion ladder is threaded throughout: any P0–P4 edit that survives its in-loop gate can be
written to `memory_manage`/skills to become durable (rung 3), which is the openswarm-native version
of Self-Harness — earned online, kept offline.

---

## 8. Evaluation (the co-equal deliverable)

Built on `swarmkit-eval` (the same harness [docs/45](45-adaptive-orchestration-design.md) §6 uses),
so results are comparable to the existing frontier studies. Each hypothesis is an arm with a kill
criterion.

| # | Hypothesis | Arm | Proves / reproduces |
|---|---|---|---|
| **LH1** | Agent-authored in-flight scaffold (#1+#2) beats a fixed scaffold on a task class with hidden mechanics | self-harnessing vs. fixed, same model | The Schema thesis, on our tasks |
| **LH2** | The intelligence is the model's, not the engineer's | agent-authored vs. hand-authored scaffold, held constant | Answers the "baked-in" critique with data |
| **LH3** | Runtime verification contracts (#4) reduce premature termination without harming resolve | with/without agent-declared gate | The §6b fix, generalized |
| **LH4** | A live edit promoted to durable memory transfers to future runs on the same repo | measure run N+1 after run N's promotion | The promotion ladder pays off |
| **LH5** | Agent-authored tools (#3) reduce steps/tokens without new failure modes | with/without `define_tool`, MAST-judged | Capability-growth is net-positive & safe |
| **LH6** | A *cheap* model synthesizing the harness a run executes beats the big model run directly, at lower cost | cheap-synth + execute vs. big-model-direct | AutoHarness's cost result, ties [docs/50](50-heterogeneous-cost-scaling.md) |

Disciplines carried over from [docs/45](45-adaptive-orchestration-design.md) §6: always report
against the **strong single-agent baseline**; primary metric = terminal task success, secondary =
tokens / wall-clock / $; MAST 14-mode judge over traces to see *which failure mode* each capability
moves. LH1/LH2 are the headline; LH3 is the safety proof; LH4 is the differentiator. Per *Stop
Comparing LLM Agents Without Disclosing the Harness* ([arXiv 2605.23950](https://arxiv.org/abs/2605.23950)),
every arm records the exact harness (fixed vs. the agent-authored delta) as a first-class artifact, so
a self-harnessing score is never confounded with a hidden hand-tuned scaffold.

---

## 9. Open questions

1. **World-model register representation (#1).** Free-form `repl` module vs. a typed
   state+transition schema the harness can introspect and diff. The typed form enables a cleaner
   reality gate but constrains what the model can express.
2. **Advisory vs. binding fragments (#2).** Do live skills only *inform* the model (safe, weak), or
   can they set constraints the harness *enforces* (strong, riskier)? P0 starts advisory.
3. **Where does a rung-1 delta live?** A new `RunConfig.harnessDelta` folded in at
   `worker-entry.ts:311`, or ride entirely on the existing memory/skills injection paths? The latter
   is zero-new-plumbing but couples harness edits to the memory format.
4. **Gate budget.** How much of an episode's token/latency budget may the in-loop gates consume
   before self-harnessing is net-negative? Needs an explicit accounting arm.
5. **Promotion trust (rung 2→3).** What evidence promotes an ephemeral edit to durable — one
   isolated-verifier pass, N passes, or an offline regression confirmation on the next idle cycle?
6. **Interaction with compaction.** A durable harness edit must survive compaction like curated
   memory does (`compact-rebuild.ts:76`); an ephemeral one must *not* leak past the episode.
7. **Selection policy for the edit search (§4.3).** Thompson-sampling REx (AutoHarness), plain
   best-of-N ([docs/45](45-adaptive-orchestration-design.md) §6b.4), or an evolutionary optimizer
   (GEPA / A-Evolve)? And what breadth *K* of parallel variant-harnesses is net-positive against the
   gate budget (OQ 4)?

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
