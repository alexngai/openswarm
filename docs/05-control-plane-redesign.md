# 05 — Control-plane redesign: steerable, program-scale, meshable swarms

Status: **draft for review** · 2026-09-25 · extends [docs/06](06-mesh-positioning.md)

A redesign of OpenSwarm's construction and interface, organized by the goals
it serves. §1 states the diagnosis, §2 the outcome and goals, §3–§4 the
principles and model, §5 the foundation every goal builds on, §6 how the
design reaches each goal, §7 the phased plan and its exit criteria, §8–§10
the comparison with today, the recorded decisions, and what is still open,
and §11 the dsh seams checked against the installed packages.
The evidence is the docs/06 discussion record (lab demonstrations,
program-scale coordination lineage, human-swarm interaction research, and the
project's own evals); this doc cites it by principle rather than repeating it.

## 1. The diagnosis

The kernel is sound: state is a fold over an append-only log, members are
complete peer harnesses in their own processes and worktrees, coordination is
a compare-and-set board plus a durable mailbox, and landing goes through a
merge queue. What is wrong is one shape decision that everything
human-facing and mesh-facing inherits:

```ts
ctx.swarm.runTeam(spec, { parent }) : Promise<TeamResult>
```

A team is a **function call**. You cannot steer a promise, join one, observe
one except through progress lines, or nest one without blocking the parent's
turn. Every gap docs/06 scored follows from it: the run table dies with the
app-server process, the lead is disposed on settle, `/swarm` blocks and
returns a synthesis, the only human control is "kill the jobs row", and a
member cannot lead. The redesign changes the unit from *a call that returns
a result* to **a durable run that exposes state and accepts direction**, at
every level from member to mesh.

A second, quieter lesson shapes the whole design. The project's own
engagement measurements found models used an offered delegation tool about
4 % of the time and self-modification 0 of 103 times. **Any feature that
depends on a member choosing to call a coordination tool will mostly sit
empty.** Coordination therefore has to be structural: declared by planners,
derived from diffs, raised by the harness. Members that participate
voluntarily are a bonus, never a dependency (D6).

## 2. Outcome and goals

**North star** (docs/06 §3.3): *landed work per dollar-hour, at zero task
loss, across a heterogeneous mesh.* "Landed" means merged into the target and
verifier-passing, not "member reported done".

| Goal | Statement | North-star term it serves |
|---|---|---|
| **G1 Steerable** | A person or program can address, direct, observe, and approve any unit of a swarm, not only a lead. | *dollar-hour*: human interaction cost caps how many agents one person can direct |
| **G2 Program-scale** | Many threads of work run under one coordination layer: partitioned, contract-first, dependency-aware, integrated. | *landed work*: throughput beyond one team |
| **G3 Meshable** | Independently started swarms find each other, share a train and hand off tasks, and merge. | *across a mesh* |
| **G4 Verified landing** | Work counts only after a verifier the member cannot game passes it, through a train that keeps the target green. | *landed*, not reported |
| **G5 Runtime-neutral** | Any runtime that meets a small contract can be a member: dsh, Claude Code, Codex, A2A. | *heterogeneous* |
| **G6 Durable** | No run, task, or decision is lost to a crash; everything replays and resumes. | *zero task loss* |
| **G7 Governed** | Blast radius is contained, provenance is enforced, approvals are real rather than rubber-stamped. | makes all of it deployable |
| **G8 Measurable** | Every run reports the north-star terms, so every claim is checkable. | makes the north star observable |

G1–G5 are capabilities. G6–G8 are qualities that every capability must hold.

**Non-goals.** Beating a single agent on resolve rate for hard single tasks
(docs/47 and the field say parity; we do not design against it). Cross-org
federation (innovators stage, docs/06 §4.5; the trust model in G7 keeps the
door open). Our own UI shell (dsh's web surface hosts our views, D7).
Further topology mechanism (docs/02's conclusion stands).

## 3. Principles

| # | Principle | Goals |
|---|---|---|
| P1 | **Fan-out = neglect time ÷ interaction time.** Every feature is judged by which term it moves: watchdogs, verifiers, and trains raise neglect time; boards, recaps, and one question queue cut interaction time. | G1, G2 |
| P2 | **Artifacts carry intent; chat carries correction.** Dispatch is by spec, issue, or board with a commander's-intent header; chat is for exceptions. | G1 |
| P3 | **State is a fold over a journal.** A journal per run with pluggable backends; every view is a projection; replication is a backend. | G6, G3 |
| P4 | **One writer per scope; land only through a train; verify before landing.** | G2, G4 |
| P5 | **Consent at plan time, exception at run time.** | G1, G7 |
| P6 | **Same primitives at every level.** Member, thread, program, and mesh share verbs and the protocol. | G1, G3 |
| P7 | **Runtime-neutral members behind a small contract.** | G5 |
| P8 | **A foreign message is never consent.** Provenance on every message; only a human principal answers a question or approves a mount. | G7 |
| P9 | **Structural, not voluntary, coordination.** The harness declares, derives, and raises; members may participate. | G1, G2, G4 |

## 4. The model

```
Mesh
 └─ Program            durable run; owns a plan, a train, a budget
     └─ Thread         a team (any of the seven topologies); owns a scope set
         └─ Member     a runtime meeting the member contract (§5.4)
             └─ Task   intent + scope + verifier level + budget → landing
```

Entities recorded in the journal, each with a stable id and a revision:

| Entity | Fields (beyond id/revision) | Today |
|---|---|---|
| **Run** | kind (`program`\|`thread`), spec, parent run, status, principal, budget | in-memory `RunRecord`, lost on restart |
| **Task** | subject, prompt, **intent** {purpose, endState, constraints, preferences}, **scope**, blockedBy, priority, owner, **lease**, attempts, result, **verifiedLevel** | subject, prompt, blockedBy, owner, result |
| **Scope** | task or thread, kind (`file`\|`test` enforced; any other string recorded only), pattern, lease | none |
| **Member** | name, runtime, conformance level, thread, state (`provisioning`\|`active`\|`idle`\|`blocked`\|`dead`), session ref, budget used | roster in memory |
| **Message** | from principal, to (member\|role\|thread\|`lead`\|`*`), delivery (`immediate`\|`enqueue`\|`quiet`), outcome | from/to member names, `wakeup`/`quiet` |
| **Question** | raised by (harness trigger or member), kind (`consent`\|`approval`\|`input`\|`escalation`), risk tier, prompt, answer, answered by | none |
| **Offer** | offerId, from run, to run, task, accepted/reclaimed | none |
| **Landing** | task or thread, branch, deps, priority, verifier results, batch, outcome, evidence bundle | `MergeOutcome` after the fact |
| **Budget** | scope (run\|thread\|member), tokens, steps, ciRounds, dollars, action on exhaustion | `maxConcurrent`, `maxTaskAttempts` |
| **Steer / Pause / Cancel** | target, principal, message | none |

## 5. Foundation

Five pieces of construction that every goal depends on. They are built first
because nothing in §6 is sound without them.

### 5.1 Durable run

```ts
const run = await ctx.swarm.start(spec, { parent, policy, budget })   // RunHandle
run.id            // stable; survives process restart
run.board()       // projection
run.steer(...)    // direction
run.result        // Promise<TeamResult>  ← today's runTeam, kept for compatibility
await ctx.swarm.attach(runId)   // from any process that can read the journal
```

A finished run is a readable record: the run's journal, not its lead, holds
it, so disposing the lead on settle loses nothing. The app-server's run
table becomes a projection, so `swarm/runs` survives a restart and `attach`
works from a new process. `view(runId)` reads a run without writing;
`attach(runId)` takes over only from a dead writer (same-host pid check
until the git journal brings a real lease), releases its claims, and marks
the run `interrupted`; resuming execution is a later direction method.

### 5.2 Journal per run, projections, handoff

Board and mailbox stop being the storage layer and become projections of a
typed journal (`swarm/task`, `swarm/scope`, `swarm/message/*`,
`swarm/question`, `swarm/offer`, `swarm/landing`, `swarm/budget`,
`swarm/member`, `swarm/steer`). Every mutation is compare-and-set on the
entity revision; `waitForChange` generalizes to a filtered subscription.

- **One journal per run, linked by parent id** (D1). The journal is **our
  own append-only JSONL file**, not a dsh session log: dsh refuses to reload
  a session containing event types outside its built-in list, and offers no
  compare-and-set (§11). The run's lead is the journal's only writer; every
  other principal writes through the protocol (§5.3), so compare-and-set
  stays the in-process transaction tail `board.ts` already has. Projections
  are our own folds, delivered to views through the protocol's event
  subscription (§5.3). When dsh accepts plugin event types, a session-log
  backend can replace the file.
- **Claims carry a lease** tied to the owner's liveness. `attach` releases
  claims whose owner is gone; today a lead crash leaves claimed tasks
  `in_progress` forever.
- **Handoff** is the only way work crosses a journal boundary: the parent
  appends `offered {offerId, task}`, the child appends `accepted {offerId}`,
  a restarted parent re-offers anything unaccepted after a timeout, and a
  child treats a repeated `offerId` as a no-op. Nested threads and foreign
  swarms use the same protocol.
- **Backends** (D8): one JSONL format in two places. A local file per run
  serves all single-host work; the same JSONL under `refs/swarm/<runId>`
  serves the mesh, with claims by push compare-and-set. A `sqlite` backend
  is added only if a single-host multi-lead case demands it.

### 5.3 One protocol, carriers, principals, and policy

Members, humans and UIs, drivers, and foreign swarms speak one `swarm/*`
method table. The table and its policy check are one transport-free module;
a **carrier** binds it to a transport and establishes the caller's
principal (D11):

| Carrier | Transport | Principal | Serves |
|---|---|---|---|
| **web** | `@Remote` methods on dsh's `/api` gateway, called by the client plugin (§6.1); no dsh codegen needed (§11) | always owner; dsh's web server authenticates nothing, so this carrier is loopback-only | the board in the browser |
| **socket** | the app-server's JSON-RPC socket | from the token: owner (a local token file, for the CLI), viewer, driver, member, foreign swarm | CLI, programs, members, the mesh |

The web gateway is request/response only: its host-event push is a fixed
allowlist a plugin cannot extend. So the event subscription is one
long-poll method, `swarm/events {run, afterSeq, waitMs}`, which returns
journal entries after `afterSeq` as soon as any exist (today's
`waitForChange`, over the protocol). Both carriers use it unchanged.

A new interface (a TUI, an IDE, A2A) is a new carrier, not a new protocol.
Identity comes from the carrier's credential, never from a field. Because
every principal sees the same method table, **policy is the security
boundary**, and it is default-deny:

| Method group | Owner (human) | Viewer (human) | Driver (program) | Lead member | Member | Foreign swarm |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| State: `runs`, `board`, `members`, `questions`, `landings`, `events` | ✓ | ✓ | ✓ | own thread | own tasks | offered tasks only |
| Direction: `start`, `steer`, `pause`, `resume`, `cancel`, `reprioritize`, `budget` | ✓ | — | ✓ within policy | own thread | — | — |
| Answer: `answer` | ✓ | — | policy-tiered only | — | — | — |
| Member: `claim`, `complete`, `report`, `ask`, `declare-scope`, `send` | — | — | — | ✓ | ✓ | on accepted offers |
| Mesh: `join`, `leave`, `offer`, `card` | ✓ | — | — | — | — | ✓ after join policy |

A driver may answer only questions whose risk tier its policy allows; a
consent or approval question always needs a human (P8). The socket binds
wherever the run's policy says; loopback stops being a hard-coded rule. The
web carrier stays on loopback until dsh's web surface authenticates
requests. Today the app-server forwards every non-`swarm/` method to dsh's
SDK server; under the policy table that pass-through is owner-only.

### 5.4 Member contract

The contract is what makes G5 real and what lets the rest of the design
stay structural. Three conformance levels:

| Level | A member must | Unlocks |
|---|---|---|
| **Basic** | accept a task prompt with its intent header; run with a given cwd; return final text, stop reason, and usage; be cancellable | fanout, pipeline, cascade, coordinator; landing; scopes derived from diffs; harness-raised questions |
| **Steerable** | accept a mid-run message with `immediate` or `enqueue` delivery; keep one session across turns; resume that session after a restart | live steering, messaging peer-teams, warm restart without amnesia |
| **Participating** | call `swarm/ask`, `report`, `declare-scope`, `send` | members raising their own questions and narrowing their own scopes |

Everything in §6 works at **basic**; steerable adds live direction;
participating is a bonus (P9). Runtimes today: in-process `spawn`
(steerable), dsh subprocess (steerable via `RemotePeer`). dsh's SDK server
only queues a turn, so `immediate` delivery reaches a subprocess member
through `openswarm-swarm-member`, which calls `agent.steer` inside the
member (§11). Planned: a
resume-capable dsh runtime (D5), `claude-code` and `codex` (basic, then
steerable), `attach` to an existing endpoint, and `a2a`.

### 5.5 Member sandbox

Today `member.cordis.yml` runs members with sandbox mode
`danger-full-access`: a member can read or write anything on the host. The
default becomes dsh's `workspace-write`, rooted at the worktree. dsh's
sandbox confines **writes** to the session cwd and temp directories for the
whole process tree, git and npm included; it does not restrict reads or
network, and takes no extra paths (§11). So the sandbox is **write
containment**: a member cannot damage the host or another member's
worktree, and package caches are redirected into temp by environment
(`npm_config_cache`, `PIP_CACHE_DIR`, `CARGO_HOME`) in the member
composition. It is not a confidentiality boundary; hidden tests are
protected by where the verifier runs (§6.4, D4). It ships behind a flag
until the keyless and live suites pass under it.

## 6. How the design reaches each goal

### 6.1 G1 — Steerable

**What it means.** One person directs many agents without routing
everything through a lead, and without drowning in prompts. The evidence
sets the bar: shipped surfaces cap at single digits of agents per person;
humans approve 93–97 % of prompts and block 5 % after fifty, so per-action
approval is rubber-stamping; information is lost relaying through a lead.

**Addressing.** Four units of address, all stable names: member, thread (or
role), task, and landing; plus `*` for broadcast. The lead stays the default
conversational target; every other unit is one step away.

**Direction.**
- `steer {target, message, delivery}`: `immediate` lands after the current
  tool call, `enqueue` after the turn, `quiet` rides the next turn. The
  journal records what actually happened, so a view never shows "queued" for
  a message already acted on. Targets below *steerable* conformance get
  `enqueue` only, and the response says so.
- `pause`, `resume`, `cancel`, `reprioritize`, `budget` on any unit.
- **Intent header** on every task, filled by the planner, the issue, or the
  person: purpose, end state (checkable), constraints, preferences.
- **Plan consent**: `start { consent: 'plan' }` runs the planner, raises one
  consent question carrying the partition, contracts, and budgets, and fans
  out only on a human answer.

**Questions, raised structurally (P9).** The harness raises a question when:

| Trigger | Question |
|---|---|
| stall (idle clock, after one nudge) | "member X has made no progress in N minutes: nudge, restart, reassign?" |
| budget exhausted | "thread T spent its budget at task K: extend, stop, reassign?" |
| verifier failure after retries | "task K failed L3 twice; last failure: …" |
| scope violation at landing | "task K edited files outside its scope: accept, split, reject?" |
| same-target convergence | "three members are on the same failing test: re-partition?" |
| restart budget spent | "member X died twice on task K" |
| conflict the resolver could not fix | "landing L conflicts with M; resolver gave up" |

Members at *participating* level may also `ask`. All questions go to one
queue in the journal, tagged with a risk tier, with a rate cap so the queue
cannot escalate faster than a person can think, and are answered over any
carrier. The web carrier also surfaces them through dsh's
`ctx.userQuestions`, which works outside an agent turn. `ctx.approval` does
not (it throws unless a turn is open, §11), so it stays what it is today:
the gate on member tool calls and F3 mounts.

**Observing.**

| View | Shows | Actions |
|---|---|---|
| **Program board** | threads: state, scope, budget used, landing state | steer, pause, reprioritize, open |
| **Thread board** | tasks: `pending`/`claimed`/`blocked`/`needs-input`/`landed`/`failed`, owner, verified level | steer member, reopen, answer |
| **Member peek** | the member's own dsh session, current tool call, the exact question if blocked | message, interrupt, stop |
| **Question queue** | every open question across runs, tiered, oldest first | answer, batch-answer a tier, escalate |
| **Landing queue** | batches, verifier results and evidence, conflicts at the resolver | reprioritize, retain, take over the branch |
| **Recap on attach** | a change log folded from the journal since the viewer last looked | — |

These render inside dsh's web surface as a client plugin (D7): a package
declaring `dsh.client` that contributes a view tab to `conversation.view`
and actions to `conversation.session.header.actions`, fed through the web
carrier. dsh has no full-page or route slot, so each view must fit a tab
(§11). The same data is on the socket carrier for any other client, and a
CLI covers the headless case:

```
openswarm start  <swarm.yml | "task"> [--program] [--consent plan] [--budget …]
openswarm ps                                  runs, threads, members, states
openswarm board  <run>
openswarm steer  <run> [--to member|role|thread|*] [--now] "message"
openswarm questions                           open questions
openswarm answer <question> "…"
openswarm attach <run>                        recap, then follow events
openswarm pause|resume|kill <run|thread|member>
openswarm join   <url> [--token]
openswarm run "task"                          unchanged one-shot
```

**Risks.** The board lives on dsh's release-candidate client API; the
compatibility smoke suite grows a client-plugin load check. The rate cap
has no evidence-based default yet; start conservative and measure answer
latency.

### 6.2 G2 — Program-scale

**What it means.** Several threads, each a team, run at once on one change
without integration hell. The evidence is specific: partition quality and
interfaces pinned before fan-out outrank every other mechanism (a 25–39 point
integration loss without a pinned spec; performance rising from two to four
agents and falling at eight without dependency-aware partitioning); cross-agent
concurrent PRs conflict at about 42 %; the comfortable ceiling is 20–30
agents, not hundreds.

**The planning stage.** A program starts with a planner run (frontier model)
that produces a plan artifact, which is what plan consent shows:

1. **Survey.** Build a dependency graph of the target: the language's import
   graph where tooling exists, falling back to git co-change history. Mark
   hub files (high fan-in, or touched by many planned tasks).
2. **Partition.** Group the work into threads by community in that graph,
   bounded by `maxThreads` (default 6, hard cap 8) and 3–5 members per
   thread. Each thread's file set becomes its **scope** (D2). Hub files are
   never shared between threads.
3. **Contracts first.** Interfaces, schemas, and stubs that more than one
   thread needs are extracted into **thread 0**, which lands through the train
   before any other thread starts. The others then cut their worktrees from
   the integration branch, not from base. This also resolves the ledgered
   "sibling visibility" row: siblings see the contracts they share.
4. **Dependencies and priority.** Threads carry `blockedBy`; the train and
   the scheduler both honour it.
5. **Allocation.** A frontier model plans and resolves; cheaper models
   execute (the one published allocation policy with numbers, an 8× cost
   spread at similar quality). Per-thread budgets follow the partition sizes.
6. **Consent.** One question with the partition, contracts, budgets, and
   model allocation.

**Nesting.** A thread's lead is a member running the `lead` composition
(`leaf` plus `openswarm-swarm`, a subagent provider, and the journal
client). Its worktrees cut from its own task branch; its journal is linked
to the program's by parent id; its landing target is the program's
integration branch through the program's train.

**Scopes (D2).** `file` and `test` scopes are declared by the planner and
enforced: same-target detection during the run, and a diff-against-scope
check at landing. Any other kind is recorded and displayed, marked
unenforced. Members never have to declare anything (P9).

**Drift.** A scheduled **maintenance program** is a first-class program
kind: small single-purpose PRs against declared repository principles, the
only self-improvement loop in the docs/06 record with a plausible
enterprise path.

**Risks.** The survey step is per-language; start with TypeScript and
Python and fall back to co-change. The whole goal is conditional on the
pilot and the Phase C experiment (§7.5): if a program of threads does not
beat sharded teams of the same total size, G2 and G3 are re-scoped to
sharded throughput.

### 6.3 G3 — Meshable

**What it means.** Two independently started swarms, on different hosts,
share coordination state and a train, hand tasks to each other, and merge
their work, without either restarting.

**Design.**
- **Transport**: the journal under `refs/swarm/<runId>` (D8); every swarm already has the
  repository, so joining needs no broker.
- **Join**: `swarm/join {card, token}` against a swarm's published Agent
  Card; the join policy (§6.7) decides the principal it becomes.
- **Work exchange**: `swarm/offer` over the handoff protocol (§5.2); an
  accepted offer is claimable by the foreign swarm's members at the
  foreign-swarm row of the policy table.
- **Merging**: both swarms enqueue into one train, promoted to a
  standalone service bound to the target branch (D3). That shared train is
  the concrete meaning of "merging two swarms".
- **Discovery**: an A2A Agent Card per swarm; no AGNTCY, NANDA, or ANP
  (docs/06 §4.1).

**Risks.** Push compare-and-set contention on the git journal at mesh scale
is unmeasured; the Phase D exit test includes contention. Trust is the
riskiest part and is designed in G7 before this ships, not with it.

### 6.4 G4 — Verified landing

**What it means.** Throughput that does not become review debt. The field
record: agent PRs wait 4.6× longer for review and merge far less often;
review time rose 441 % in high-adoption teams; agents game visible
verifiers, and gaming scales with capability.

**Verifier hierarchy.** Each task, thread, or program declares the minimum
level it must reach to land; results record the level reached.

| Level | Verifier | Today |
|---|---|---|
| L0 | member self-report | the default |
| L1 | LLM judge (`APPROVED`/`REVISE:`) | critic-loop, cascade gate |
| L2 | declared commands, weakest link over exit codes | cascade `confidence` only |
| L3 | **hidden tests**, held where the verifier runs and never on a filesystem a member can read, run by the train | new |
| L4 | external CI on the train's batch | new |

dsh's sandbox does not restrict reads (§5.5), and worktrees share one object
store, so no location on a member's host is hidden from it. Hidden tests
therefore live where the verifier runs: a container, another host, or an OS
user the members cannot read as (D4). Benchmark runs hold this by
construction, since the grader applies held-out tests after the member has
finished. Where the verifier's isolation reports a denied access by a
member, that is a tamper incident.

**The train.** A service-shaped class with its own journal, lead-hosted
through Phase C and promoted in Phase D (D3):
- entries carry `blockedBy`, priority, and required verifier level;
- batches merge speculatively and test once; a failure bisects to the
  culprit;
- a conflict goes to a resolver thread (a critic-loop over the conflict)
  before it is retained;
- a scope violation raises a question instead of silently merging;
- a forge adapter (Phase D) hands batches to GitHub or GitLab's queue for
  organizations that already gate there.

**Reviewer-facing evidence.** Each landing carries a small bundle: intent
header, scope and diff-against-scope, verifier levels and outputs, cost, and
questions answered along the way. Batches are sized so a human can review
one in minutes; the landing queue sorts by risk tier. Review is the scarce
resource and this is where the design spends on it.

### 6.5 G5 — Runtime-neutral

**What it means.** A dsh worker, a Claude Code reviewer, and a Codex tester
on one task graph and one train. No shipped product does this; it is the
claim in docs/06 §5 that only a runtime-neutral layer can make.

**Design.** The member contract (§5.4) is the whole mechanism. Because
coordination is structural, a *basic* member (prompt in, result out,
cancellable, run in a cwd) takes part in every topology, lands through the
train, has scopes derived from its diff, and triggers harness questions.
Each runtime is an adapter to the contract:

| Runtime | Path | Target level |
|---|---|---|
| dsh subprocess | exists; resume added (D5) | steerable |
| `claude-code` | dsh ships the subagent provider | basic → steerable |
| `codex` | dsh ships the subagent provider | basic → steerable |
| `attach` | SDK `session/prompt` on an existing session | steerable |
| `a2a` | A2A client; a task maps to an A2A task | basic |

**Risks.** Usage and cost reporting differ per runtime; G8's cost-per-landing
needs each adapter to report tokens and dollars, and the contract makes that
mandatory rather than best-effort.

### 6.6 G6 — Durable

- Runs, questions, offers, and landings are journal records (§5.1–§5.2);
  `attach` rebuilds any view from them.
- A lead's death loses nothing: a new process attaches, releases claims
  whose owner is gone (§5.2), re-offers unaccepted handoffs, and resumes the
  train from its journal.
- Member death keeps today's detection, task re-claim, and warm restart, and
  adds true resume: the dsh member runtime resumes its persisted session on
  a miss instead of briefing an amnesiac from a digest (D5).
- Cross-host durability comes with the git journal in Phase D.

### 6.7 G7 — Governed

- **Member sandbox** (§5.5): write containment at the worktree. Network
  stays open; dsh's sandbox has no network control.
- **Protocol policy** (§5.3): default-deny by principal and method group,
  enforced from Phase A, when the protocol first opens to humans, not
  deferred to the mesh.
- **Approvals**: one risk-tiered queue with a rate cap; plan consent before
  fan-out; drivers may answer only tiers their policy allows.
- **Provenance** (P8): every message carries its principal; only a human
  answers a consent or approval question or approves an F3 lead mount.
- **Budgets**: per run, thread, and member; exhaustion pauses and raises a
  question.
- **Join policy** (Phase D): a foreign swarm is admitted by an owner-signed
  token scoped to specific runs, becomes the foreign-swarm principal, and
  can only see and claim what it has been offered.
- **Audit**: the journal is the audit log; nothing coordination-relevant
  happens outside it.

### 6.8 G8 — Measurable

`RunMetrics` on every result and on the event stream:

| Metric | Why it exists |
|---|---|
| landed tasks, verified level distribution | the north-star numerator |
| tokens and dollars by principal, model, and runtime; wall-clock | the north-star denominator |
| coordination tokens ÷ task tokens | the overhead nobody publishes |
| interventions: steers, answers, restarts; questions raised by trigger; time-to-answer | the G1 cost term |
| landing rate, clean-merge rate, bisect count, conflicts, latency | train health |
| tasks lost or duplicated | the zero-loss term |
| tamper incidents | the gaming signal |

The eval harness from docs/02 runs every phase's exit experiment, so the
numbers come from the same measurement apparatus that replicated the legacy
results.

## 7. Phased plan

### 7.1 Shape

One **spine** of four phases, each with a goal and an exit criterion, plus
a **runtime track** that runs alongside from Phase B. A hand-planned
**pilot** runs alongside Phase A and puts the program-scale question to an
early test (D10); Phase C ends with the go/no-go experiment for the rest.

| | A — Steerable foundation | B — Verified landing | C — Program-scale | D — Mesh |
|---|---|---|---|---|
| **Pilot** | hand-planned program vs sharded vs single (§7.5) | — | — | — |
| **Runtime track** | — | R1: `claude-code` basic | R2: `codex` basic; both steerable | R3: `attach`, `a2a` |

### 7.2 Goals by phase

● delivered · ◐ partial.

| Goal | A | B | C | D | Track |
|---|:-:|:-:|:-:|:-:|:-:|
| G1 Steerable | ● | ◐ landing queue | ◐ program board, plan consent | ◐ cross-swarm steer | |
| G2 Program-scale | | ◐ scope check at landing | ● | | |
| G3 Meshable | | | ◐ handoff | ● | |
| G4 Verified landing | ◐ sandbox | ● | | ◐ forge adapter | |
| G5 Runtime-neutral | ◐ contract, resume | | | ◐ attach | ● |
| G6 Durable | ● | ◐ train journal | ◐ handoff | ● cross-host | |
| G7 Governed | ● sandbox, protocol policy, queue | | ◐ budgets | ◐ join policy | |
| G8 Measurable | ◐ interventions | ● RunMetrics | ● effectiveness experiment | ◐ mesh metrics | |

### 7.3 Phase A — Steerable foundation

**Goal.** G1, G6, and G7's foundation: a durable run a person can address,
direct, and observe, on a protocol that is governed from its first day.

| # | Work item | Where |
|---|---|---|
| A1 | Member sandbox to `workspace-write` behind a flag; package caches redirected into temp | `packages/swarm/member.cordis.yml`, bundle |
| A2 | Resume-capable dsh member runtime (wraps the SDK server; `ctx.agents.resume` on miss); `member-resume.test.ts` flips; `immediate` steering through `openswarm-swarm-member` | `packages/swarm`, `packages/swarm-member` |
| A3 | Per-run JSONL journal; board and mailbox as projections over it; claims with leases | `packages/swarm` |
| A4 | `SwarmRun`: `start`, `attach`, `result`; leads kept; run table as a projection | `packages/swarm`, `packages/app-server` |
| A5 | Protocol module: state and direction groups, per-run event subscription, principal policy table; socket carrier (tokens, CLI owner token) and web carrier (owner, loopback) | `packages/app-server`, `packages/swarm` |
| A6 | Harness-raised questions (stall, budget, verifier failure, restart budget) in one tiered, rate-capped queue; surfaced on the web carrier through `ctx.userQuestions` | `packages/swarm` |
| A7 | Intent header on tasks; `/swarm` renders the board instead of blocking | `packages/swarm` |
| A8 | CLI verbs | `bin/openswarm` |
| A9 | Board client plugin: thread board, member peek, question queue, recap; long-polls `swarm/events`; build step for the `dsh.client` bundle format | new `packages/swarm-client` |
| A10 | File the upstream issues: continuable `subagent-dsh-sdk`, SDK method registry, plugin event-type registration for session logs | upstream |

**Exit criteria.**
1. From the web surface and from the CLI, a person redirects a running
   member with `immediate` delivery and answers a harness-raised question;
   the run continues without a restart.
2. Killing the process hosting a lead, then `openswarm attach` from a new
   process, shows the same board and a recap; the dead lead's claims are
   released; zero tasks lost or duplicated.
3. A member in the sandbox cannot write outside its worktree and temp; the
   keyless and live suites pass with the flag on, including a member that
   installs packages.
4. On the socket carrier, a viewer principal is refused every direction
   method and a member principal is refused `answer`.

**Deliberately not in A.** Scopes, the train, nesting, new runtimes.

**Progress** (branch `claude/phase-a`): A3 `38eafab` (run journal, claim
leases; peer-team sessions reopen again), A2 `926bf3a` (member server:
resume on miss, `swarm/steer`), A4 `e34b350` (`start`, `view`, `attach`,
`runs`; run ids; the app-server's run table from journals), A5a `d440294`
(protocol module with the default-deny policy; token-authenticated socket
carrier, owner token in `$OPENSWARM_HOME/app-server.json`; `start`,
`steer`, `cancel`, `attach`, `events` long-poll), A5b `9a671a1` (web
carrier: `@Remote` methods on dsh's `/api` gateway, owner-only, refuses to
load unless dsh's web server binds 127.0.0.1), A6 `bb5258e` (journaled
questions at four triggers — stall after one nudge, restart budget, task
attempts, cascade exhaustion — each defaulting to the old behavior;
`swarm/questions`, `swarm/answer` with the tier rule; also raised through
`ctx.userQuestions` in the web profile), A8 `294e69c` (CLI: `ps`, `board`,
`questions`, `attach` read journals with no server; `start`, `steer`,
`answer`, `kill` go through `openswarm serve`'s socket; `swarm/start`
now uses the profile's default model). Exit criterion 2 is met by a test
that SIGKILLs a lead mid-task and attaches from the test process: same
board, recap, claims released, run `interrupted`, task set unchanged.
Built in the order A3, A2, A4, A5, A6, A8, since direction methods
address runs. A1 `32376a9` (member sandbox behind
`OPENSWARM_MEMBER_SANDBOX=workspace-write`: bash and, via `dsh-fs-sandbox`,
the editor are write-confined to the worktree and temp; caches redirected
to temp; git writes and PTYs are denied inside a member by design). Exit
criterion 3 is met: the keyless suite passes with and without the flag,
and all seven live tests pass with it (the rung-5 self-edit needed
`27c83b0`, which stops the command gate inheriting the driver's `npm_*`).
A9 `fc0428d` (the Swarm tab: a `conversation.view` client plugin over
the web carrier; board, questions, recap, steer, cancel, start form; the
web profile also serves the socket carrier so the CLI directs the same
runs). Exit criterion 1 was verified 2026-09-27 in a real browser and the
CLI against one `openswarm web`: a run started from the tab was steered
`immediate` from the tab and another from the CLI, each member changing
course mid-turn, and a harness-raised question was answered from each
surface, with no restart. That exercise found two defects, fixed:
`ecf77cb` (a messaging team's late settlement notices woke the lead for a
model turn) and `2f28e99` (worktree members need the launcher's model
route, not a key sent by the caller). A7 `7cefb19` (intent header on runs
and peer-team tasks, rendered into member prompts and shown on the board,
the tab and the recap; `/swarm` starts the run and returns its id, the
outcome reaching the tab, `openswarm attach` and the invoking session as
injected context; `/swarm --wait` keeps the blocking form).

**Phase A is complete** (2026-09-27): all ten items built, all four exit
criteria met.

### 7.4 Phase B — Verified landing

**Goal.** G4 and G8: work counts only when verified, and the north star is
computable.

| # | Work item |
|---|---|
| B1 | Verifier levels L2 and L3; verifier environment members cannot read (D4); tamper logging |
| B2 | Train class with its own journal: speculative batches, bisect, dependencies, priority; lead-hosted |
| B3 | Resolver thread for conflicts; scope-violation and conflict questions |
| B4 | Landing evidence bundle; landing queue view |
| B5 | `RunMetrics`, including coordination ratio and cost per landing |
| R1 | `claude-code` member at basic conformance, landing through the train |

**Exit criteria.**
1. On a fixed task set run through the eval harness, landing rate and
   clean-merge rate under the train are at least today's sequential queue's,
   and a planted bad commit is bisected out without blocking its batch-mates.
2. An adversarial probe (a member instructed to find and read the hidden
   tests) produces a tamper incident and no read.
3. A mixed roster of a dsh member and a Claude Code member lands work through
   one train, with cost attributed per runtime.

### 7.5 Phase C — Program-scale, and the decision

**Goal.** G2, and the effectiveness answer that decides whether D is worth
building as designed.

**Pilot, run alongside Phase A (D10).** The same question, asked at
planning's upper bound on today's primitives, before C is built. A person
writes each plan: the partition, thread 0's contracts, and the landing
order. Threads run as today's `runTeam` with worktrees; the cross-team
steps (cutting from the integration branch, merging across teams) are done
by hand with git. The benchmark's held-out tests grade landing, and cost
comes from the eval harness, since the kernel records no usage yet. Arms:

- **single**: one agent, the whole change.
- **sharded**: the same partition, each thread cut from base, all merged at
  the end.
- **program**: the same partition, plus thread 0's contracts landed first,
  worktrees cut from the integration branch, and threads landed in
  dependency order.

Program and sharded run at equal total agent count and differ in exactly
those three things, so the comparison measures coordination rather than
partition quality. The system under test is pinned to
`origin/self-modification` @ `7b79b3d`, the only line with the headless
`run` mode the eval harness drives, plus member-side usage folding and the
worktree fixes the team arms need, with the arms driver on top
(`pilot/roadmap-arms` @ `1e4bda0`: `OPENSWARM_PILOT_PLAN` /
`OPENSWARM_PILOT_ARM`). Every arm, single included, gets the same 8 CPU /
16 GB container, so contention among a program's agents is not a
confound; compute cost is negligible next to tokens. Caveat: the single
arm is the CLI's in-process agent while team members boot
`member.cordis.yml`, so single vs team also differs in member composition;
sharded vs program, the comparison that decides, does not. Validated at
zero tokens (2026-09-25) on vbt-1.3.0 with a scripted model applying the
reference solution split into four threads: both arms scored 1.0, program
cut t1–t3 after t0 landed, sharded cut all four from base. A hand plan is the best planning C can produce, run on
the weakest runtime (no train, no steering). So a negative result is
strong: if the hand-planned program does not beat sharding, C and D are
re-scoped before they are built. A positive result only licenses building
C; the exit experiment below still decides D. The pilot also fixes the task
set (§10).

| # | Work item |
|---|---|
| C1 | `lead` member composition; thread-in-program nesting; handoff protocol |
| C2 | Program spec (`swarm.yml`) and artifact intake from issues |
| C3 | Planning stage: survey (TypeScript, Python, co-change fallback), partition, contracts-first thread 0, cut-from-integration |
| C4 | `file` and `test` scopes enforced; same-target detection |
| C5 | Budgets per run, thread, member; model allocation policy |
| C6 | Program board and plan consent |
| C7 | Maintenance program kind |
| R2 | `codex` member at basic; `claude-code` and `codex` at steerable |

**Exit experiment (go/no-go).** On the task set the pilot fixed, the
pilot's three arms with the automated planner and the real train: single,
sharded (for example 4 teams × 3 members), and program (4 threads × 3
members). Measure landed work per dollar-hour at L3, landing rate,
coordination ratio, and interventions per landed task.

- **Go** to D as designed if the program arm beats the sharded arm on
  landed work per dollar-hour without a worse landing rate.
- **Re-scope** if it does not: D keeps durability, the shared train, and
  cross-host sharding for throughput, and drops cross-swarm task handoff
  until a later experiment says otherwise.

### 7.6 Phase D — Mesh

**Goal.** G3, cross-host G6, and the rest of G7.

| # | Work item |
|---|---|
| D1 | Journal under `refs/swarm/<runId>` (git backend); contention test |
| D2 | Train promoted to a standalone service bound to a target branch |
| D3 | `join`, `leave`, `offer`, `card`; foreign-swarm principal; join policy |
| D4 | Forge adapter for GitHub and GitLab merge queues |
| R3 | `attach` and `a2a` runtimes |

**Exit criteria.**
1. A second swarm on another host joins with a URL and token and claims an
   offered task within ten seconds.
2. Killing either host loses no tasks; the survivor or a replacement
   attaches and continues.
3. Two programs land into one target through one train with no
   integration-branch breakage.
4. A foreign swarm cannot read, claim, or steer anything it was not offered.

### 7.7 What the plan does not schedule

Cross-org federation, a `sqlite` backend, enforced semantic scopes, and
voluntary member participation as a requirement. Each has a named trigger
in §9 or §10 that would bring it back.

## 8. Comparison with today

| Dimension | Today (`main` @ `9148996`) | Redesign | Goal |
|---|---|---|---|
| Unit of execution | `runTeam(spec) → Promise` | durable `SwarmRun`; `runTeam` = `start().result` | G1, G6 |
| State | board + mailbox over one lead's session log | our JSONL journal per run, linked; leased claims; projections pushed over the protocol | G6, G3 |
| Survives restart | no | yes; `attach` | G6 |
| Human entry | blocking `/swarm` line | board in dsh's web surface, CLI, protocol carriers | G1 |
| Address a member | impossible | `steer` to member, role, thread, lead, `*` | G1 |
| Steering semantics | none | `immediate` / `enqueue` / `quiet`, journaled | G1 |
| Questions | none | harness-raised plus member `ask`; one tiered queue | G1, G7 |
| Intent | free-text prompt | intent header per task | G1, G2 |
| Planning | coordinator numbered plan | survey, partition, contracts-first, allocation, consent | G2 |
| Scopes | none | planner-declared `file`/`test`, enforced at landing | G2, G4 |
| Nesting | none | `lead` member composition | G2 |
| Landing | sequential merge, conflicts retained | speculative bisecting train, resolver, evidence bundle | G4 |
| Verification | cascade command gate | L0–L4, hidden tests where the verifier runs | G4 |
| Member runtimes | in-process, dsh subprocess | contract with three levels; + claude-code, codex, attach, a2a | G5 |
| Member sandbox | `danger-full-access` | write containment at the worktree (`workspace-write`) | G7 |
| Wire | 3 UI methods (+ SDK pass-through) + 1 member method, loopback | one protocol on two carriers (web, socket), principal policy table | G1, G7 |
| Mesh | none | git journal, join/offer, shared train | G3 |
| Budgets | concurrency and attempt caps | per run, thread, member | G2, G7 |
| Telemetry | usage per model, progress lines | `RunMetrics` with the north-star terms | G8 |

**Stays:** Cordis plugin shape and the dsh seams; log-fold state; the seven
topologies, now thread patterns; worktrees and auto-commit; token identity;
F3 and its blast radius; the eval CLI contract.
**Goes:** the in-memory run table; lead disposal on settle; loopback as a
hard-coded rule; blocking `/swarm`; `danger-full-access` as the member
default.

## 9. Decisions

Each records the options weighed, why this one, and what would reverse it.

**D1 — One journal per run, linked by parent id; our own JSONL until dsh
accepts plugin events.** *Granularity* was weighed against one journal per
program with thread segments, and a hybrid with a thin program index. One
journal gives one compare-and-set domain and a one-fold recap, but every
reader pays for every thread's traffic, and a thread cannot be replicated
or handed to another host alone. Per-run journals make a thread the unit
the mesh moves. Nothing is atomic across journals; the handoff protocol
covers it and is reused by the mesh. *Storage* was weighed across dsh's
session log (the first draft's choice), waiting for upstream support,
mirroring a JSONL into a dsh session, and reusing dsh's own `team/*` event
types. dsh's persistence refuses to reload a session containing plugin
event types and offers no compare-and-set (§11), so a session-log journal
cannot survive the restart G6 requires. A mirror keeps two copies for the
sake of a view feed, and `team/*` events are folded by dsh's agent teams.
We own the file, the fold, and compare-and-set (already in `board.ts`), and
give up dsh's projection cache and push. *Reverse if* programs need tight,
frequent cross-thread coordination rather than occasional handoffs
(granularity), or dsh ships plugin event-type registration with a
conditional append (storage: a session-log backend replaces the file).

**D2 — Enforce `file` and `test` scopes; record the rest.** Weighed against
file only, and a full semantic set enforced. File ownership is the only kind
with production evidence; a failing-test name catches the many-agents-on-one-bug
pile-up. Semantic scopes have a published protocol and no published outcome,
and enforcing them needs per-language symbol resolution and lease tuning.
*Reverse if* a program produces a collision that file and test scopes missed
and a semantic scope would have caught.

**D3 — The train is service-shaped: lead-hosted first, promoted in D.**
Weighed against lead-only, standalone from day one, and delegating to the
forge. Lead-only makes merging two swarms impossible; standalone from day one
pays for a lifecycle and a deployment question early; the forge queue needs a
remote and hosted CI, is FIFO without dependencies, and cannot run hidden
tests. *Guard:* the train touches the program only through the protocol and its
journal until promotion.

**D4 — Hidden tests live where the verifier runs; the member sandbox is
write containment.** Weighed against sparse checkout, a separate ref, an
exclude list, and an out-of-repo directory behind the member sandbox. The
first three are obscurity because worktrees share one object store. The
fourth was the first draft's choice, but dsh's sandbox confines writes
only (§11), so any path on a member's host is readable, and the gaming
record includes deliberate extraction of hidden tests. The verifier
therefore runs in a container, on another host, or as an OS user the
members cannot read as; benchmark graders already work this way. The
sandbox still earns its place by containing writes. *Cost:* the verifier
needs its own execution environment from Phase B, and the sandbox may break
members that write outside the worktree (caches redirected into temp and a
flag cover the transition). *Reverse if* dsh's sandbox gains read
confinement, which would allow a same-host verifier directory.

**D5 — Fix locally where we already wrap; file upstream; delete wrappers
when upstream lands.** Resume-on-miss and the method registry are local
now; continuable `subagent-dsh-sdk` is filed only, since `RemotePeer`
already works. Forking stays governed by docs/01's trigger, which has not
fired.

**D6 — Coordination is structural; member participation is optional.**
Weighed against a design where members declare scopes, ask questions, and
report progress through tools. The project's own measurements (about 4 %
voluntary delegation, 0 of 103 self-modification) say members mostly will
not. Planners declare, landings derive, the harness raises. *Reverse if*
measured participation rises enough that member-raised questions outnumber
harness-raised ones on real runs.

**D7 — The human surface is a dsh client plugin.** Weighed against our own
UI and a wire-only design. dsh's web client loads out-of-tree `dsh.client`
packages into named slots; the board is a `conversation.view` tab with
actions in the session header, fed through the web carrier (D11). We get
sessions, approvals, and the member peek (a member is a dsh session) for
free. *Risk:* coupling to a release-candidate client API, and dsh has no
full-page slot, so the program board must fit a view tab (§11); the
compatibility suite checks the plugin loads. *Reverse if* the program board
cannot work inside a view tab.

**D8 — One journal format, two locations.** A JSONL file per run on local
disk for single-host work, and the same JSONL under `refs/swarm/<runId>`
for the mesh, so the git backend is mostly a transport. `sqlite` is added
only if a single-host multi-lead case demands it.

**D9 — Runtime neutrality is a parallel track, not the last phase.** It
needs the member contract and a worktree, both available by Phase B, not the
mesh. Shipping it last would delay the one claim nobody else can make.

**D10 — A hand-planned pilot before Phase C is built.** Weighed against
running the go/no-go only at the end of C, and piloting after Phase B with
the real train. Ending C with the experiment means building A through C
before any evidence on G2, and the record leans negative (docs/47 parity;
an ensemble beat a coordinated team at equal compute; docs/63 closed
diversity). The pilot is docs/62's oracle pre-check applied to planning: if
the best available plan does not beat sharding on today's runtime, an
automated planner will not. Piloting after B buys a real train, but L3
comes from the benchmark grader either way. *Cost:* manual git steps, cost
taken from the eval harness, and a positive result is weak evidence (best
planning, weakest runtime). *Reverse if* the pilot is positive by a wide
margin, in which case the Phase C experiment confirms rather than gates.

**D11 — One protocol, many carriers.** Weighed against dsh's web gateway
for humans with our socket for programs (two protocols, and the web gateway
knows one principal), and our socket for everyone (rebuilding question
push, steering, and a WebSocket that dsh's web surface already has). The
`swarm/*` method table and its policy check are one transport-free module;
each carrier binds a transport and establishes the principal, so a new
interface is a new carrier. The web carrier is owner-only on loopback
because dsh's web server authenticates nothing; the socket carries every
principal from tokens. A spike (2026-09-25) registered an out-of-tree
`@Remote` method and called it through a real `openswarm-web` boot, so the
web carrier needs no transport of ours; the gateway has no push, so views
long-poll `swarm/events`. *Cost:* two carriers to test, and remote viewers
reach a run only through the socket. *Reverse if* dsh's web surface gains
authenticated principals (one carrier suffices).

## 10. Still open

- **Handoff timeout**: how long an unaccepted offer waits before reclaim,
  and whether it is set per program or per thread.
- **Package caches under the sandbox**: the per-ecosystem environment that
  redirects caches into temp (Node, Python, Rust), declared in the member
  composition; the A1 prototype confirms toolchains survive it.
- **Verifier environment**: a container, another host, or another OS user
  (D4), and how hidden tests reach it; a separate repository the train
  clones also supports a promoted train on another host.
- **Question rate cap**: started at 3 open questions per run, beyond which a
  question is recorded `capped` and takes its default; protocol-started runs
  wait 5 minutes for an answer, unattended runs none (A6). Still open: how
  both adapt to measured answer latency.
- **Task set**: fixed during the pilot, before C starts, so the experiment
  cannot be tuned after the fact. Researched 2026-09-25; recommendation:
  **RoadmapBench, Python and TypeScript only** (41 and 22 of its 115 tasks;
  held-out per-target tests with partial credit; one prebuilt image per
  task; MIT). Screen about 20 mid-size tasks single-agent × 3 seeds and
  freeze the 8–12 whose completion score lands between 0.2 and 0.8,
  together with each task's hand-written partition. SWE-EVO is a weak fit
  (Python only, about 8–10 of 48 tasks span several modules, release notes
  are mostly independent fixes) and serves at most as a 3–4 task
  cross-check. Internal migrations join only if frozen with the rest.
  - *Harness:* a native RoadmapBench adapter of about 100 lines in
    swarmkit-eval 0.2.0 (which already carries both benchmarks; `legacy/eval`
    pins 0.0.11). Tasks allow 2h, over E2B's 1h cap, so runs use Docker on
    the EC2 box (about 16 images at a time).
  - *Cost, measured 2026-09-25* (openswarm headless `--single`, gpt-5.5,
    one seed; dollars at $5 / $0.50 / $30 per M fresh input / cached input /
    output): opt-4.4.0 reward 0.667, $4.23, 6 min; fal-4.1.0 0.750, $3.07,
    5 min; vbt-1.3.0 0.700, $2.93, 8 min. About $3.40 a run, so a 60-run
    screen is about $200, against the $600–1,800 first inferred. The agent
    stops on its own after about 60 tool calls, far inside the 2h budget
    (published agents take 110–171 turns), so the arms' effort differences
    belong in the dollar-hour denominator, not in a fixed budget.
  - *Screen, run 2026-09-25* (20 tasks × 3 seeds, single agent, gpt-5.5,
    SUT `1e4bda0`, 8 CPU / 16 GB): 60 cells, $305 (about $5.10 a run;
    Polars and MikroORM tasks cost $8–11), every cell's parsed reward
    equal to `test.sh`'s own. Mean reward in [0.2, 0.8] for 13: fal-1.3.0
    0.41, fal-4.1.0 0.75, mko-5.8.0 0.52, mko-6.4.0 0.73, mko-6.5.0 0.40,
    opt-4.4.0 0.74, plr-1.30.0 0.37 (seeds 0.00–0.56), plr-1.31.0 0.33,
    prm-6.7.0 0.59, pyg-2.2.0 0.67, pyg-2.5.0 0.67, spc-3.2.0 0.50,
    vbt-1.3.0 0.63. Out of window: spc-3.4.0 and vbt-1.1.0 at 1.00,
    opt-4.6.0 and prm-7.0.0 at 0.92, pyg-2.1.0 0.83, mko-6.6.0 0.15,
    plr-1.18.0 0.06. The reference solution scored 1.0 in 3 of 3 reps on all
    20.
  - *Checks before freezing, no model tokens:* whether the task images
    carry `.git` (the worktree arms need it; fall back to `git init`), and
    reference-solution stability over 2–3 runs per task.
  - *Validity risk:* RoadmapBench instructions already give target API
    signatures, so every arm starts with part of what thread 0's contracts
    would pin, which may shrink the program arm's advantage.
- **Dollar-hour**: whether the north-star denominator is dollars × wall-clock
  hours or two separate ratios; fixed with the task set.
- ~~**Web carrier registration**~~ **settled 2026-09-25** (D11, §11): an
  out-of-tree plugin registers `@Remote` methods on the `/api` gateway
  without dsh codegen. Still unbuilt: the browser half, a `dsh.client`
  bundle in the `window.__ModuleLoader__` format, which our esbuild script
  does not emit yet.
- ~~**Session reload on `main`**~~ **confirmed 2026-09-25**: a peer-team
  run appends `swarm/*` events to its lead's session (the app-server's
  per-run lead, or the caller's agent), and dsh then refuses to resume it.
  `session-reload.test.ts` pins it: a plain session reopens, the same
  session after one board write does not. `/swarm` (coordinator) never
  touches the board and is unaffected. A3's journal fixes it; the test
  flips if dsh accepts plugin event types first.

## 11. dsh seams, checked against the installed packages

Checked 2026-09-25 against `node_modules/@deepseek-ai/*` at 0.1.1-rc.2 (no
dsh source checkout). The first draft assumed several of these; the
decisions above cite this table.

| Seam | What the installed packages do | Used in |
|---|---|---|
| Session log with plugin events | `session.append` never marks an event `ignorable`, and persistence refuses to load any log containing a type outside `KNOWN_SESSION_EVENT_TYPES` (`dsh-session-persistence`, `assertEventsSupported`). Registration for plugin types is "deferred until such a consumer exists". No conditional append. | D1, D8 |
| `ctx.sessionProjections` | Real: folds custom event types, runs over any session in `ctx.sessions`, caches to disk, pushes `session/projection` frames to web clients only. Usable only for sessions dsh can load. | D1 |
| Sandbox | Modes `read-only`, `workspace-write`, `danger-full-access`. `workspace-write` confines writes to cwd and temp for the whole process tree (Seatbelt on macOS; bwrap or Landlock on Linux); reads and network are unrestricted; no extra-path settings. `dsh-subprocess-local` and MCP clients bypass it. | §5.5, D4 |
| Approvals and questions | `ctx.approval.request` throws unless an agent turn is open; no tiers. `ctx.userQuestions.ask` works without an agent, one provider, no tiers; answered only from the web surface. | §6.1 |
| Client slots | `conversation.view` and `conversation.session.header.actions` exist. `session.hierarchy` is an aria-label, not a slot. No full-page or route slot. | D7 |
| Resume | `ctx.agents.resume({resumeSessionId})` exists; the SDK server's `getOrCreateSession` always calls `agents.create`. | A2, D5 |
| Steering | `agent.steer` delivers at the next step boundary; the web `session.prompt` accepts `mode: 'steer'`; the SDK JSON-RPC server only calls `followup`. | §5.4, A2 |
| Protocol extension | The SDK server's dispatch is a closed switch of three methods. The web gateway's `/api` falls back to scanning live services for `@Remote` markers (`TypertRemoteService`), and the loader registers a package's `./typert` export for strict schemas; a spike ran both through a real boot. Request/response only: forwarded host events are a fixed allowlist (`API_REMOTE_FORWARDED_EVENTS`). The web server authenticates nothing and binds `127.0.0.1` or `0.0.0.0`. | §5.3, D11 |
