# 05 — Control-plane redesign: steerable, nestable, meshable swarms

Status: **draft — open questions resolved (§8), for review** · 2026-09-22 · extends [docs/04](04-mesh-positioning.md)

A redesign of OpenSwarm's construction and interface so that a person, a
program, or another swarm can **address, direct, observe, and join** a swarm
of agents, rather than hold one blocking conversation with a lead. It keeps
the kernel docs/01 got right and changes the shape of the API around it.
The evidence behind each choice is the docs/04 discussion record (lab
demonstrations, program-scale coordination lineage, human-swarm interaction
research); this doc cites it by principle rather than repeating it.

## 0. The diagnosis

The kernel is sound: state is a fold over an append-only log, members are
complete peer harnesses in their own processes and worktrees, coordination
is a compare-and-set board plus a durable mailbox, and landing goes through a
merge queue. What is wrong is one shape decision that everything
human-facing and mesh-facing inherits from:

```ts
ctx.swarm.runTeam(spec, { parent }) : Promise<TeamResult>
```

A team is a **function call**. You cannot steer a promise, join a promise,
observe a promise except through progress lines, or nest one without
blocking the parent's turn. Every gap docs/04 scored follows: the run table
dies with the app-server process, the lead is disposed on settle, `/swarm`
blocks and returns a synthesis, the only human control is "kill the jobs
row", and a member cannot be a lead. The redesign changes the unit from *a
call that returns a result* to **a durable run that exposes state and
accepts direction**, at every level from member to mesh.

## 1. Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Fan-out = neglect time ÷ interaction time.** How many agents one person directs is set by how long an agent works correctly unattended and how much each interaction costs. | Every feature is judged by which term it moves. Watchdogs, verifiers, and merge gates raise neglect time; boards, recaps, and one approval queue cut interaction time. |
| P2 | **Artifacts carry intent; chat carries correction.** | Tasks carry a commander's-intent header. Dispatch is by spec, issue, or board; chat is for exceptions and steering. |
| P3 | **State is a fold over a journal.** (kept from docs/01) | One journal with pluggable backends; every projection (board, mailbox, roster, questions, budgets, landings) folds from it; replication is a backend, not a feature. |
| P4 | **One writer per scope; land only through a train; verify before landing.** | Scopes are declared before writes, landing is a speculative bisecting train with a verifier gate, conflicts are routed rather than dropped. |
| P5 | **Consent at plan time, exception at run time.** | A plan gate before fan-out; run-time prompts only for escalations, fanned into one risk-tiered queue with a rate cap. |
| P6 | **Same primitives at every level.** | Member, thread, program, and mesh are addressed, steered, observed, and budgeted with the same verbs and the same wire. |
| P7 | **Runtime-neutral members.** | A member is anything that can claim, report, ask, and be steered over the wire: in-process, dsh subprocess, an attached endpoint, Claude Code, Codex, or an A2A agent. |
| P8 | **A foreign message is never consent.** | Provenance on every message (`human:`, `member:`, `swarm:`); only a human principal can answer a question or approve a mount. |

## 2. The model

```
Mesh
 └─ Program            durable run; owns a train, a budget, a partition
     └─ Thread         a team (any topology); owns a scope set and a sub-board
         └─ Member     a runtime that claims, reports, asks, is steered
             └─ Task   intent + scope + verifier + budget → landing
```

Entities the journal records, each with a stable id and a revision:

| Entity | Fields (beyond id/revision) | New vs today |
|---|---|---|
| **Run** | kind (`program`\|`thread`), spec, parent run, status, principal, budget | today: in-memory `RunRecord`, lost on restart |
| **Task** | subject, prompt, **intent** {purpose, endState, constraints, preferences}, **scope** (declared write set), blockedBy, priority, owner, attempts, result, **verifiedLevel** | today: subject/prompt/blockedBy/owner/result |
| **Scope** | task, kind (`file`\|`symbol`\|`api`\|`schema`\|`config`), pattern, lease | new |
| **Member** | name, runtime, thread, state (`provisioning`\|`active`\|`idle`\|`blocked`\|`dead`), session ref, budget used | today: roster in memory |
| **Message** | from principal, to (member\|role\|`*`\|`lead`), delivery (`immediate`\|`enqueue`\|`quiet`), text | today: from/to member names, `wakeup`/`quiet` |
| **Question** | asker, kind (`consent`\|`approval`\|`input`\|`escalation`), risk tier, prompt, answer, answered by | new; the needs-input queue |
| **Landing** | task/thread, branch, deps, priority, verifier result, train batch, outcome | today: `MergeOutcome` after the fact |
| **Budget** | scope (run\|thread\|member), tokens, steps, ciRounds, dollars, action on exhaustion | new |
| **Steer / Pause / Cancel** | target, principal, message | new (journaled so a recap can show them) |

## 3. Construction

### 3.1 `SwarmJournal` — one log, many projections

Replaces the pair `SwarmBoard` + `SwarmMailbox` as the *storage* layer;
both survive as projections with their current APIs. Events are typed
(`swarm/task`, `swarm/scope`, `swarm/message/*`, `swarm/question`,
`swarm/landing`, `swarm/budget`, `swarm/member`, `swarm/steer`), every
mutation is compare-and-set on the entity revision, and `waitForChange`
generalizes to a filtered subscription.

**One journal per run, linked by parent id** (§8 D1). A program and each
of its threads keep separate journals; the program board and recap fold
the parent plus its children. Each run's projections register with dsh's
`ctx.sessionProjections`, which drives the folds, caches them, and pushes
changed views to the browser surface, so we stop maintaining our own
fold-on-read path. Work crosses a journal boundary only by a **handoff**:
the parent appends `offered {offerId, task}`, the child appends
`accepted {offerId}`, a restarted parent re-offers anything unaccepted,
and a child treats a repeated `offerId` as a no-op. Foreign swarms join
through the same handoff, so it is built once.

Backends, selected per run:

| Backend | Use | Cross-process | Cross-host |
|---|---|---|---|
| `session-log` (today) | in-process and single-lead runs | via the wire only | no |
| `sqlite` | multi-lead on one host, nested threads | yes (WAL) | shared fs only |
| `git-journal` | mesh: a branch of JSONL under `refs/swarm/<runId>`; claims are push-CAS | yes | yes, zero infra |

The git backend is the pragmatic mesh transport the field converged on
(lock-file claims, Beads, GNAP): every swarm already has the repo. A broker
backend can slot in later behind the same interface.

### 3.2 `SwarmRun` — a durable object, not a call

```ts
const run = await ctx.swarm.start(spec, { parent, policy, budget })   // RunHandle
run.id            // stable, survives process restart (journal-backed)
run.board()       // projection
run.steer(...)    // direction
run.result        // Promise<TeamResult>  ← the old runTeam, for compatibility
await ctx.swarm.attach(runId)   // any process holding the journal
```

Leads are no longer disposed on settle; a finished run is a readable
record. The app-server's run table becomes a projection, so `swarm/runs`
survives restarts and `attach` works from a new process.

### 3.3 Members and nesting

`MemberRuntime` is the provider seam (today: `spawn` in-process and
`dsh-sdk` subprocess). Added:

- `attach` — an already-running endpoint joins a roster (the ledgered
  "attach, not just spawn"); the SDK wire already supports `session/prompt`
  on an existing session.
- `claude-code`, `codex` — the upstream dsh providers, exercised as members.
- `a2a` — a client member over an Agent Card; tasks map to A2A tasks.

Two member compositions ship: **`leaf`** (today's `member.cordis.yml`) and
**`lead`** (adds `openswarm-swarm`, a subagent provider, and the journal
client). A `lead` member runs a thread inside a program: its worktrees cut
from its own task branch, its sub-board lives in its own journal (linked
to the program's by parent id), and its landing target is the parent's
branch. Nesting is therefore a
composition choice plus a merge-target rule, which is why it is Phase 2
and not a rewrite.

### 3.4 One wire, three roles

Members, humans and UIs, and foreign swarms speak the **same** `swarm/*`
JSON-RPC surface (docs/01 F2 said "two roles of the same protocol"; this
makes it three). Roles differ by principal and policy, never by method
set. Identity comes from the credential, never from a field (kept).

| Group | Methods |
|---|---|
| State | `swarm/runs`, `swarm/board {run}`, `swarm/members`, `swarm/questions`, `swarm/landings`, `swarm/events {run, filter}` (subscription, per-run scoped) |
| Direction | `swarm/start`, `swarm/steer {target, message, delivery}`, `swarm/answer {question, answer}`, `swarm/pause`, `swarm/resume`, `swarm/cancel {target}`, `swarm/reprioritize`, `swarm/budget` |
| Member | `swarm/claim`, `swarm/complete`, `swarm/report`, `swarm/ask` (opens a Question), `swarm/declare-scope`, `swarm/send` (today's only method) |
| Mesh | `swarm/join {card, token}`, `swarm/leave`, `swarm/offer {tasks\|capacity}`, `swarm/card` |

`target` resolves to `lead`, a member name, a role, a thread id, or `*`;
an unknown target is a typed error, not a silent drop. `delivery` is
explicit: `immediate` lands after the current tool call, `enqueue` after
the turn, `quiet` rides the next turn as context; the journal records
which happened so a UI never shows "queued" for a message already acted
on.

The member socket stops being loopback-only: it binds where the run's
policy says, and the same token scheme gates it.

### 3.5 Landing — a merge train

`packages/git`'s sequential `mergeAll` becomes a `MergeTrain`:

- the train is its own class with its own journal (batches, verifier
  results, outcomes) and touches the program only through the wire, so
  its host can change without a redesign (§8 D3): hosted in the program
  lead through Phase C, promoted to a standalone service per target branch
  in Phase D, when two swarms need to share it;
- entries carry `blockedBy`, priority, and the required verifier level;
- batches are merged speculatively and tested once; a failure bisects to
  the culprit entry (Bors, SubmitQueue, Zuul lineage);
- a conflict is **routed** to a resolver thread (a critic-loop over the
  conflict, the ledgered "agent-driven conflict resolution") before it is
  retained;
- several threads and several programs may share one train and one target,
  which is the concrete form of "merging two swarms";
- a **forge adapter** (later) feeds landed batches into GitHub or GitLab's
  merge queue instead of pushing, for organizations that already gate
  there; our train then does the agent-specific work (scopes, hidden
  tests, bisect) and the forge keeps the final say.

### 3.6 Verifier hierarchy and the landing gate

Every task, thread, or program declares the minimum level it must reach
to land; results record the level actually reached.

| Level | Verifier | Today |
|---|---|---|
| L0 | member self-report | the default |
| L1 | LLM judge (`APPROVED`/`REVISE:`) | critic-loop, cascade gate |
| L2 | declared commands, weakest link over exit codes | cascade `confidence` only |
| L3 | **hidden tests** — kept **outside the repository**, unreachable from the member sandbox, run by the train at landing | new |
| L4 | external CI on the train | new |

L3 exists because every self-improvement and long-horizon result in the
record shows evaluator gaming scaling with capability; a verifier the
member cannot see is the cheapest defence. "Cannot see" needs two things
(§8 D4). The tests must not live in the repository: worktrees share one
object store, so any ref, any excluded path, and any history is readable
by a member with git. And the member sandbox must not reach them, which
today it can (§3.8). A read attempt on the verifier location is logged as
a tamper incident. A hacker-fixer loop over the verifier is an optional
topology, not core.

### 3.7 Watchdog and maintenance

- **Stall**: the idle clock (exists) plus a nudge before a restart.
- **Same-target**: two claims or declared scopes converging on one file or
  one failing test raise a Question to the coordinator; the fix is a
  re-partition, not a lock. Scope kinds (§8 D2): `file` and `test` are
  enforced (detection, leases, landing check); any other `kind`
  (`api`, `schema`, `config`, …) is recorded and displayed but not
  enforced, and the UI marks it so. Writes outside a declared scope are
  caught at landing.
- **Budget**: exhaustion pauses the target and opens a Question.
- **Drift**: a scheduled maintenance program (small single-purpose PRs
  against declared principles) is a first-class program kind.

### 3.8 Policy and approvals

- **Members are sandboxed to their worktree.** Today `member.cordis.yml`
  runs members with sandbox mode `danger-full-access`, so a member can
  read or write anything on the host. The default becomes
  `workspace-write` rooted at the worktree, network denied unless the run
  policy allows it, with declared read-only paths for toolchains and
  package caches. This is a Phase A prerequisite: hidden tests, scope
  enforcement, and blast-radius claims all depend on it.
- Trust mode set at spawn through dsh's sandbox policy; no per-edit prompts.
- One approval queue: every Question routes through `ctx.approval` (as F3
  does today), tagged with a risk tier; the queue enforces an escalation
  rate cap so oversight does not degrade into rubber-stamping.
- **Plan consent**: `swarm/start { consent: 'plan' }` runs the planner,
  opens a `consent` Question carrying the partition, contracts, and
  budgets, and fans out only on a human answer.
- Provenance on every message; a member or foreign-swarm message cannot
  answer a Question or approve a mount (P8).

### 3.9 Telemetry

`RunMetrics` in every result and on the event stream: coordination tokens
vs task tokens, interventions (steers, answers, restarts), questions asked
and time-to-answer, landing latency and clean-merge rate, conflicts, the
`verifiedLevel` distribution, verifier-tamper incidents, and cost by
principal and model. These are the docs/04 §3.1 metrics made observable.

## 4. Interface

### 4.1 Human: board first, chat second

Rendered in dsh's own browser surface (it already renders our command and
our jobs row), and by any client of the wire:

| View | Shows | Actions |
|---|---|---|
| **Program board** | threads as rows: state, owner, scope, budget used, landing state | steer thread, pause, reprioritize, open thread |
| **Thread board** | tasks: state (`pending`/`claimed`/`blocked`/`needs-input`/`landed`/`failed`), owner, verified level | steer member, re-open task, answer |
| **Member peek** | the member's own dsh session (it is one), current tool call, the exact question if blocked | message member, interrupt, stop |
| **Needs-input queue** | every open Question across runs, risk-tiered, oldest first | answer, batch-approve same-tier, escalate |
| **Landing queue** | train batches, verifier results, conflicts awaiting a resolver | reprioritize, retain, take over branch |
| **Recap on attach** | a change log folded from the journal since the viewer last looked | — |

The lead is still the default conversational surface; every other unit is
one click away. Broadcast is a target, not N messages.

### 4.2 CLI

```
openswarm start  <spec.yml | "task"> [--program] [--consent plan] [--budget ...]
openswarm ps                                  runs, threads, members, states
openswarm board  <run>                        the board as text
openswarm steer  <run> [--to member|role|thread|*] [--now] "message"
openswarm ask                                 open questions
openswarm answer <question> "..."
openswarm attach <run>                        recap, then follow events
openswarm pause|resume|kill <run|member>
openswarm join   <url> [--token]              join a foreign swarm's board
openswarm run "task"                          unchanged one-shot (start + await)
```

### 4.3 Artifact intake

A program starts from a **spec file** (`swarm.yml`: threads, partition,
contracts, verifiers, budgets), from **issues** (each becomes a task whose
intent header is filled from the issue), or from a **PR comment**. The
intent header is mandatory and small:

```yaml
intent:
  purpose:      why this task exists
  endState:     what "done" is, checkable
  constraints:  what must not change
  preferences:  style, libraries, approach
```

### 4.4 Programmatic

The wire is the API. A driver subscribes to `swarm/events` per run, answers
Questions by policy where allowed, and steers on exceptions. Routines and
webhooks start programs the same way a person does.

## 5. Comparison with today

| Dimension | Today (`main` @ `9148996`) | Redesign |
|---|---|---|
| Unit of execution | `runTeam(spec) → Promise` | durable `SwarmRun` with a stable id; `runTeam` = `start().result` |
| State | board + mailbox over one lead's session log | per-run journals linked by parent id, three backends, projections registered with `ctx.sessionProjections` |
| Member sandbox | `danger-full-access` (whole host) | `workspace-write` at the worktree, network off by default |
| Survives restart | no (run table in memory, lead disposed) | yes (journal-backed; `attach`) |
| Human entry | `/swarm` line, blocking, returns synthesis | board-first UI + CLI + wire; `/swarm` stays as the one-shot |
| Address a member | impossible (mailbox is member↔member) | `steer {target}`: lead, member, role, thread, `*` |
| Steering semantics | none | `immediate` / `enqueue` / `quiet`, journaled |
| Needs-input | none (members cannot ask) | `swarm/ask` → Question queue, risk-tiered |
| Approvals | F3 lead-mount only, via `ctx.approval` | one queue for all Questions, plan consent, rate cap |
| Intent | free-text prompt | mandatory intent header per task |
| Scopes | none (worktree isolation only) | declared write scopes, leased, same-target detection |
| Landing | sequential merge queue, conflicts retained | speculative bisecting train, deps, priority, resolver thread |
| Verification | cascade command gate only | L0–L4 hierarchy, hidden tests, landing gate |
| Nesting | none (member is a leaf) | `lead` member composition; thread inside program |
| Member runtimes | in-process, dsh-sdk subprocess | + attach, claude-code, codex, a2a |
| Wire | 3 UI methods + 1 member method, loopback | one `swarm/*` surface, three roles, policy-bound host |
| Mesh | none | `join`/`offer` over a shared journal and train; Agent Card |
| Budgets | `maxConcurrent`, `maxTaskAttempts` | per run/thread/member tokens, steps, CI rounds, dollars |
| Telemetry | usage per model, progress lines | `RunMetrics` incl. coordination ratio, interventions, verified level |
| Recovery | member death, warm restart from digest | + lead death (journal), recap on attach |

## 6. What stays, changes, goes

**Stays:** Cordis plugin shape and the dsh seams; log-fold state; the seven
topologies (they become thread patterns); worktrees and auto-commit; the
token-based member identity; F3 with its blast radius; the eval CLI contract.

**Changes:** `runTeam` → `start`/`attach`; board+mailbox → journal
projections; `SwarmServer` → the shared wire; `mergeAll` → train;
`member.cordis.yml` → `leaf` and `lead` variants; `/swarm` keeps its
behaviour but renders the board instead of blocking.

**Goes:** the in-memory run table; lead disposal on settle; loopback-only
binding as a hard-coded rule; the assumption that a member never asks.

## 7. Phasing

Each phase names the docs/04 §3.1 metric it moves, so it is checkable.

| Phase | Delivers | Metric |
|---|---|---|
| **A — Steerable** | member sandbox to `workspace-write`; resume-capable member runtime; `SwarmRun`, per-run journal over session-log registered with `ctx.sessionProjections`, handoff protocol; `steer`/`ask`/`answer`/`cancel`, Question queue through `ctx.approval`, intent header, `file`/`test` scopes, board view in the web surface, CLI verbs | interventions and questions become measurable; time-to-answer |
| **B — Verified landing** | verifier levels L2–L3 (out-of-repo hidden tests), landing gate, train with bisect and deps hosted in the lead, resolver thread, `RunMetrics` | landing rate and latency, coordination overhead ratio |
| **C — Nestable** | `lead` member composition, program spec, partition from the dependency graph, contracts step, budgets | scaling efficiency at 4–8 threads × 3–5 members |
| **D — Meshable** | sqlite and git-journal backends, train promoted to a standalone service, `attach` runtime, `join`/`offer` over the handoff protocol, Agent Card, join policy, forge adapter | time-to-join, task-loss under host loss, replay fidelity |
| **E — Runtime-neutral** | claude-code, codex, a2a members in one roster | runtime coverage |

A is the smallest phase and moves the human surface from below the
lead-only baseline to above it; it is also the phase every later one
needs, because nesting and meshing without steering only make the
unaddressable swarm bigger.

## 8. Resolved decisions (2026-09-22)

Each decision lists the options weighed, why this one, and what would
reverse it.

**D1 — One journal per run, linked by parent id.** Weighed against one
journal per program with thread segments, and a hybrid with a thin program
index. A single journal gives one compare-and-set domain and a one-fold
recap, but dsh has no notion of segments, every reader pays for every
thread's traffic, and a thread cannot be replicated or handed to another
host alone. Per-run journals match dsh's own model (each registers with
`ctx.sessionProjections` for caching and push) and make a thread the unit
the mesh moves. The cost is that nothing is atomic across journals; the
offer/accept handoff in §3.1 covers it, and it is the same protocol
foreign swarms need. *Reverse if* programs turn out to need tight,
frequent cross-thread coordination rather than occasional handoffs.

**D2 — Enforce `file` and `test` scopes; record the rest.** Weighed
against file only, and the full semantic set enforced. File ownership is
the only kind with production evidence; a failing-test name catches the
many-agents-on-one-bug pile-up that file scopes miss. Semantic scopes have
a published protocol and no published outcome, and enforcing them needs
per-language symbol resolution and lease tuning that would stall threads
on false positives. Recording them lets planners express intent now and
gives us the data to decide. *Reverse if* a program produces a collision
the file and test scopes missed and a semantic scope would have caught.

**D3 — The train is a service-shaped class: lead-hosted first, promoted
later.** Weighed against lead-only, standalone from day one, and
delegating to the forge's queue. Lead-only makes merging two swarms
impossible; standalone from day one pays for a lifecycle, auth, and a
deployment question before anything needs it; the forge queue needs a
remote and hosted CI, is FIFO without dependencies, and cannot run our
hidden-test gate. The journal makes promotion a change of host. The forge
queue returns as a downstream adapter, not a replacement. *Guard:* the
train may not reach into the lead's memory, only the wire and its
journal; review enforces it until promotion.

**D4 — Hidden tests live outside the repository, and members are
sandboxed.** Weighed against sparse checkout, a separate ref, and an
exclude list at worktree creation. All three are obscurity: worktrees
share one object store, so a member with git can read another ref, an
excluded path, or history. The agent-gaming record includes models
extracting hidden tests deliberately, so obscurity fails against exactly
the agents the gate exists for. A boundary needs both an out-of-repo
location and a sandbox that cannot reach it, which forces the member
sandbox change in §3.8. *Cost:* sandboxing may break members that
currently reach outside the worktree for toolchains or caches; the
declared read-only paths address that, and the change ships behind a flag
until the keyless and live suites pass under it.

**D5 — Fix locally where we already wrap; file upstream; delete wrappers
when upstream lands.** Weighed against filing and waiting, local wrappers
only, and forking. Resume-on-miss is small locally: the agent registry
already has a resume call over persisted sessions and the stock SDK server
simply never calls it, and we already wrap that server. It ships with the
Phase A member runtime, and `member-resume.test.ts` flips when it does.
The method-registry seam gets the same treatment. Continuable
`subagent-dsh-sdk` is filed upstream only, because `RemotePeer` already
works and the upstream version is cleanup, not a blocker. Forking stays
governed by docs/01's trigger, which has not fired.

### Still open

- **Handoff timeouts**: how long an unaccepted offer waits before the
  parent reclaims it, and whether that is per program or per thread.
- **Sandbox read-only paths**: the default list per ecosystem (Node,
  Python, Rust), and whether it is declared in the member composition or
  the run policy.
- **Verifier location**: a sibling directory the operator manages, or a
  separate repository the train clones; the second supports the promoted
  train on another host.
