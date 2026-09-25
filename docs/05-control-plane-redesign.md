# 05 — Control-plane redesign: steerable, program-scale, meshable swarms

Status: **draft for review** · 2026-09-25 · extends [docs/04](04-mesh-positioning.md)

A redesign of OpenSwarm's construction and interface, organized by the goals
it serves. §1 states the diagnosis, §2 the outcome and goals, §3–§4 the
principles and model, §5 the foundation every goal builds on, §6 how the
design reaches each goal, §7 the phased plan and its exit criteria, and §8–§10
the comparison with today, the recorded decisions, and what is still open.
The evidence is the docs/04 discussion record (lab demonstrations,
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
turn. Every gap docs/04 scored follows from it: the run table dies with the
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

**North star** (docs/04 §3.3): *landed work per dollar-hour, at zero task
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
federation (innovators stage, docs/04 §4.5; the trust model in G7 keeps the
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
| P6 | **Same primitives at every level.** Member, thread, program, and mesh share verbs and the wire. | G1, G3 |
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
| **Task** | subject, prompt, **intent** {purpose, endState, constraints, preferences}, **scope**, blockedBy, priority, owner, attempts, result, **verifiedLevel** | subject, prompt, blockedBy, owner, result |
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

Leads are no longer disposed on settle; a finished run is a readable record.
The app-server's run table becomes a projection, so `swarm/runs` survives a
restart and `attach` works from a new process.

### 5.2 Journal per run, projections, handoff

Board and mailbox stop being the storage layer and become projections of a
typed journal (`swarm/task`, `swarm/scope`, `swarm/message/*`,
`swarm/question`, `swarm/offer`, `swarm/landing`, `swarm/budget`,
`swarm/member`, `swarm/steer`). Every mutation is compare-and-set on the
entity revision; `waitForChange` generalizes to a filtered subscription.

- **One journal per run, linked by parent id** (D1). Each run's projections
  register with dsh's `ctx.sessionProjections`, which drives the folds,
  caches them, and pushes changed views to the web surface as
  `session/projection` frames. We stop maintaining our own fold-on-read path.
- **Handoff** is the only way work crosses a journal boundary: the parent
  appends `offered {offerId, task}`, the child appends `accepted {offerId}`,
  a restarted parent re-offers anything unaccepted after a timeout, and a
  child treats a repeated `offerId` as a no-op. Nested threads and foreign
  swarms use the same protocol.
- **Backends** (D8): `session-log` (today, all single-host work) and
  `git-journal` (mesh: JSONL under `refs/swarm/<runId>`, claims by push
  compare-and-set). A `sqlite` backend is added only if a single-host
  multi-lead case demands it.

### 5.3 One wire, principals, and policy

Members, humans and UIs, drivers, and foreign swarms speak one `swarm/*`
JSON-RPC surface. Identity comes from the credential, never from a field.
Because every principal sees the same method table, **policy is the
security boundary**, and it is default-deny:

| Method group | Owner (human) | Viewer (human) | Driver (program) | Lead member | Member | Foreign swarm |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| State: `runs`, `board`, `members`, `questions`, `landings`, `events` | ✓ | ✓ | ✓ | own thread | own tasks | offered tasks only |
| Direction: `start`, `steer`, `pause`, `resume`, `cancel`, `reprioritize`, `budget` | ✓ | — | ✓ within policy | own thread | — | — |
| Answer: `answer` | ✓ | — | policy-tiered only | — | — | — |
| Member: `claim`, `complete`, `report`, `ask`, `declare-scope`, `send` | — | — | — | ✓ | ✓ | on accepted offers |
| Mesh: `join`, `leave`, `offer`, `card` | ✓ | — | — | — | — | ✓ after join policy |

A driver may answer only questions whose risk tier its policy allows; a
consent or approval question always needs a human (P8). The member socket
binds wherever the run's policy says; loopback stops being a hard-coded rule.

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
(steerable), dsh subprocess (steerable via `RemotePeer`). Planned: a
resume-capable dsh runtime (D5), `claude-code` and `codex` (basic, then
steerable), `attach` to an existing endpoint, and `a2a`.

### 5.5 Member sandbox

Today `member.cordis.yml` runs members with sandbox mode
`danger-full-access`: a member can read or write anything on the host. The
default becomes `workspace-write` rooted at the worktree, network denied
unless the run policy allows it, with declared read-only paths for
toolchains and package caches. Hidden tests (G4), scope enforcement (G2),
and every blast-radius claim (G7) depend on it. It ships behind a flag
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
queue through dsh's `ctx.approval`, tagged with a risk tier, with a rate cap
so the queue cannot escalate faster than a person can think.

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
declaring `dsh.client`, contributing to `conversation.view`,
`conversation.session.header.actions`, and `session.hierarchy`, fed by our
projections through `session/projection` frames. The same data is on the
wire for any other client, and a CLI covers the headless case:

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
only self-improvement loop in the docs/04 record with a plausible
enterprise path.

**Risks.** The survey step is per-language; start with TypeScript and
Python and fall back to co-change. The whole goal is conditional on the
Phase C experiment (§7): if a program of threads does not beat one team of
the same total size, G2 and G3 are re-scoped to sharded throughput.

### 6.3 G3 — Meshable

**What it means.** Two independently started swarms, on different hosts,
share coordination state and a train, hand tasks to each other, and merge
their work, without either restarting.

**Design.**
- **Transport**: the `git-journal` backend; every swarm already has the
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
  (docs/04 §4.1).

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
| L3 | **hidden tests**, stored outside the repository, unreachable from the member sandbox, run by the train | new |
| L4 | external CI on the train's batch | new |

Hidden tests need both an out-of-repo location and the §5.5 sandbox:
worktrees share one object store, so anything in the repository is readable
by a member with git (D4). A read attempt on the verifier location is a
tamper incident.

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
claim in docs/04 §5 that only a runtime-neutral layer can make.

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
- A lead's death loses nothing: a new process attaches, re-offers
  unaccepted handoffs, and resumes the train from its journal.
- Member death keeps today's detection, task re-claim, and warm restart, and
  adds true resume: the dsh member runtime resumes its persisted session on
  a miss instead of briefing an amnesiac from a digest (D5).
- Cross-host durability comes with the git journal in Phase D.

### 6.7 G7 — Governed

- **Member sandbox** (§5.5): workspace-write at the worktree, network off.
- **Wire policy** (§5.3): default-deny by principal and method group,
  enforced from Phase A, when the wire first opens to humans, not deferred
  to the mesh.
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
a **runtime track** that runs alongside from Phase B. Phase C ends with the
go/no-go experiment for the rest.

| | A — Steerable foundation | B — Verified landing | C — Program-scale | D — Mesh |
|---|---|---|---|---|
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
| G7 Governed | ● sandbox, wire policy, queue | | ◐ budgets | ◐ join policy | |
| G8 Measurable | ◐ interventions | ● RunMetrics | ● effectiveness experiment | ◐ mesh metrics | |

### 7.3 Phase A — Steerable foundation

**Goal.** G1, G6, and G7's foundation: a durable run a person can address,
direct, and observe, on a wire that is governed from its first day.

| # | Work item | Where |
|---|---|---|
| A1 | Member sandbox to `workspace-write` behind a flag; read-only toolchain paths | `packages/swarm/member.cordis.yml`, bundle |
| A2 | Resume-capable dsh member runtime (wraps the SDK server; resume on miss); `member-resume.test.ts` flips | `packages/swarm` |
| A3 | Per-run journal over session-log; board and mailbox as projections registered with `ctx.sessionProjections` | `packages/swarm` |
| A4 | `SwarmRun`: `start`, `attach`, `result`; leads kept; run table as a projection | `packages/swarm`, `packages/app-server` |
| A5 | Wire: state and direction groups, per-run event subscription, principal policy table enforced | `packages/app-server`, `packages/swarm` |
| A6 | Harness-raised questions (stall, budget, verifier failure, restart budget) and one queue through `ctx.approval` with a rate cap | `packages/swarm` |
| A7 | Intent header on tasks; `/swarm` renders the board instead of blocking | `packages/swarm` |
| A8 | CLI verbs | `bin/openswarm` |
| A9 | Board client plugin: thread board, member peek, question queue, recap | new `packages/swarm-client` |
| A10 | File the upstream issues: continuable `subagent-dsh-sdk`, SDK method registry | upstream |

**Exit criteria.**
1. From the web surface and from the CLI, a person redirects a running
   member with `immediate` delivery and answers a harness-raised question;
   the run continues without a restart.
2. Killing the process hosting a lead, then `openswarm attach` from a new
   process, shows the same board and a recap; zero tasks lost or duplicated.
3. A member in the sandbox cannot read a path outside its worktree and the
   declared read-only list; the keyless and live suites pass with the flag on.
4. A viewer principal is refused every direction method; a member principal
   is refused `answer`.

**Deliberately not in A.** Scopes, the train, nesting, new runtimes.

### 7.4 Phase B — Verified landing

**Goal.** G4 and G8: work counts only when verified, and the north star is
computable.

| # | Work item |
|---|---|
| B1 | Verifier levels L2 and L3; out-of-repo verifier location; tamper logging |
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

**Exit experiment (go/no-go).** On a set of multi-module changes (a
RoadmapBench or SWE-EVO subset plus internal migrations), three arms at
equal total agent count: one agent, one team, one program (for example
4 threads × 3 members). Measure landed work per dollar-hour at L3, landing
rate, coordination ratio, and interventions per landed task.

- **Go** to D as designed if the program arm beats the team arm on landed
  work per dollar-hour without a worse landing rate.
- **Re-scope** if it does not: D keeps durability, the shared train, and
  cross-host sharding for throughput, and drops cross-swarm task handoff
  until a later experiment says otherwise.

### 7.6 Phase D — Mesh

**Goal.** G3, cross-host G6, and the rest of G7.

| # | Work item |
|---|---|
| D1 | `git-journal` backend; contention test |
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
| State | board + mailbox over one lead's session log | journal per run, linked; projections via `ctx.sessionProjections` | G6, G3 |
| Survives restart | no | yes; `attach` | G6 |
| Human entry | blocking `/swarm` line | board in dsh's web surface, CLI, wire | G1 |
| Address a member | impossible | `steer` to member, role, thread, lead, `*` | G1 |
| Steering semantics | none | `immediate` / `enqueue` / `quiet`, journaled | G1 |
| Questions | none | harness-raised plus member `ask`; one tiered queue | G1, G7 |
| Intent | free-text prompt | intent header per task | G1, G2 |
| Planning | coordinator numbered plan | survey, partition, contracts-first, allocation, consent | G2 |
| Scopes | none | planner-declared `file`/`test`, enforced at landing | G2, G4 |
| Nesting | none | `lead` member composition | G2 |
| Landing | sequential merge, conflicts retained | speculative bisecting train, resolver, evidence bundle | G4 |
| Verification | cascade command gate | L0–L4, hidden tests out of repo | G4 |
| Member runtimes | in-process, dsh subprocess | contract with three levels; + claude-code, codex, attach, a2a | G5 |
| Member sandbox | `danger-full-access` | `workspace-write` at the worktree | G7 |
| Wire | 3 UI methods + 1 member method, loopback | one surface, principal policy table | G1, G7 |
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

**D1 — One journal per run, linked by parent id.** Weighed against one
journal per program with thread segments, and a hybrid with a thin program
index. One journal gives one compare-and-set domain and a one-fold recap,
but dsh has no notion of segments, every reader pays for every thread's
traffic, and a thread cannot be replicated or handed to another host alone.
Per-run journals match dsh's model and make a thread the unit the mesh
moves. Nothing is atomic across journals; the handoff protocol covers it and
is reused by the mesh. *Reverse if* programs need tight, frequent
cross-thread coordination rather than occasional handoffs.

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
tests. *Guard:* the train touches the program only through the wire and its
journal until promotion.

**D4 — Hidden tests outside the repository, and a member sandbox.** Weighed
against sparse checkout, a separate ref, and an exclude list. All three are
obscurity because worktrees share one object store, and the gaming record
includes deliberate extraction of hidden tests. *Cost:* the sandbox may
break members that reach outside the worktree; declared read-only paths and
a flag cover the transition.

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
packages into named slots and delivers our projections as `session/projection`
frames, which is exactly the data path D1 adopts. We get sessions, approvals,
and the member peek (a member is a dsh session) for free. *Risk:* coupling to
a release-candidate client API; the compatibility suite checks the plugin
loads. *Reverse if* a full-page board cannot be expressed in the available
slots.

**D8 — Two journal backends, not three.** `session-log` for single-host
work and `git-journal` for the mesh. `sqlite` is added only if a single-host
multi-lead case demands it.

**D9 — Runtime neutrality is a parallel track, not the last phase.** It
needs the member contract and a worktree, both available by Phase B, not the
mesh. Shipping it last would delay the one claim nobody else can make.

## 10. Still open

- **Handoff timeout**: how long an unaccepted offer waits before reclaim,
  and whether it is set per program or per thread.
- **Sandbox read-only paths**: default list per ecosystem (Node, Python,
  Rust), declared in the member composition or the run policy.
- **Verifier location**: an operator-managed sibling directory, or a separate
  repository the train clones; the second supports a promoted train on
  another host.
- **Question rate cap**: a starting default and how it adapts to measured
  answer latency.
- **Phase C task set**: which public subset and which internal migrations,
  fixed before C starts so the experiment cannot be tuned after the fact.
