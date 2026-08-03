# Peer-first architecture

Design doc for turning openswarm from *an orchestrator that spawns workers* into
*a harness where peer agents interact and coordinate*. Comprehensive gap
analysis + target design. No implementation in this doc.

**Authoring date:** 2026-08-03.
**Status:** design space — proposal, not yet locked.
**Anchors:** [00-vision.md](00-vision.md), [05-swarm-model.md](05-swarm-model.md),
[25-team-orchestration.md](25-team-orchestration.md).
**Extends / re-reads:** [52-handoff-fidelity.md](52-handoff-fidelity.md),
[55-cross-harness-cache-efficiency.md](55-cross-harness-cache-efficiency.md),
[59](59-powered-frontier-findings.md)/[60](60-gap-regime-findings.md)/[61](61-composition-sweep-findings.md) (eval findings).

---

## 1. Thesis

Every mainstream coding harness — Claude Code teams/subagents, Codex, OpenCode —
implements **spawn-and-await**: a parent spawns a child, the child runs to
completion in isolation, the child returns a prose string, the parent is the only
entity that ever sees the whole picture. Children never see each other. The graph
is a tree, and the tree is only ever traversed downward, once.

openswarm's differentiated claim is not "we have six topologies." Topologies are
a feature list; anyone can add a seventh. The claim is a different **unit of
composition**:

> **Subagents are subroutines. Peers are processes.**

A peer is:

1. **Addressable** — a stable identity with an inbox, not a return value.
2. **Interruptible** — reachable *while working*, able to change course.
3. **Symmetric** — no privileged parent; any member may address any member.
4. **Stateful in the open** — writes to shared state peers can read, not only to
   a private transcript that gets lossily summarized at exit.

openswarm today has (1) genuinely, (2) and (3) partially, and (4) not at all.
This doc enumerates the gaps and specifies the target.

### 1.1 Why this is the right bet, empirically

Our own eval track has been walking back the cost-cascade story (docs/59 → 60 →
61). But buried inside those negative results are two *positive* peer findings:

- **docs/59:** an **advisor-resident** configuration beats a cold-spawned advisor
  by **+0.13 resolve-rate**. A persistent peer that keeps its context beats a
  re-spawned child.
- **docs/61:** cost is driven by **handoff-context bloat**, not by the cheap
  tier's success rate — escalation can cost 2× a cold monolith purely because of
  what gets copied between agents.

Both point the same direction: *persistent peers with shared state beat
re-spawned children with prose handoffs.* docs/52 already established that every
external harness is lossy-prose on handoff. That is the wedge, and it is
measurable.

### 1.2 The measurement problem, stated up front

docs/60 found exactly **one** coordination-rescue cell across the whole sweep.
That is not evidence that coordination doesn't help — it is evidence that
**SWE-bench-style benchmarks are single-agent-solvable by construction**. Each
task is one issue, in one repo, with one localized fix. There is no information
that agent A must discover and agent B must consume.

No peer architecture can show a win on a benchmark that doesn't require peers.
Before or alongside the build, we need a **coordination-necessary benchmark**
(§9). Otherwise this work will produce another wash, for the same reason the
cascade work did.

---

## 2. Current state: honest audit

What exists, with file references. This is the baseline the gaps are measured
against.

### 2.1 What genuinely works

| Capability | Where | Notes |
|---|---|---|
| Stable agent identity + inbox | `src/swarm/inbox.ts`, `standalone-host.ts` | Scope-keyed FIFO queues, bounded, overflow-evicts-oldest, pluggable backend |
| Role addressing (`role:<x>`, `*`) | `standalone-host.ts:1194-1214` | Resolved within sender's team scope |
| Team scope namespacing | `team-session.ts:90` | `swarm:<name>`; RoleIndex + inbox both scope-keyed |
| Long-lived / idle workers | `worker-lifecycle.ts`, `AgentHandle.runMore` | Peers persist between turns |
| Mixed-provider peers | docs/25 §8a | Claude Max + ChatGPT + API-key members in one team, all dispatching through one `ToolDispatcher`. **Genuinely unique.** |
| Worktree-per-member | `topologies/*` + `--git-cascade` | Parallel edits don't stomp |
| Live external steering | `src/acp/team-runner.ts:44`, `team send` | Human can inject mid-run |
| Self-service work claiming | `src/tools/tier2/task_pull_next.ts` | Atomic claim from team scope — the seed of self-balancing |
| Branch-level advisory locks | `src/swarm/git/branch-lock.ts` | O_EXCL lockfile, stale reclaim, shared across worktrees |

That is a real foundation. The gaps are not "nothing exists" — they are "the
existing pieces assume an orchestrator is the only active party."

### 2.2 The five structural gaps

---

#### G1 — Peers cannot reach a working peer (the attention gap)

`StandaloneHost.send()` does push a live frame to the recipient's transport
(`standalone-host.ts:1267-1275`, `sub_agent_event` / `eventKind:
"inbox_delivery"`). But `WorkerHost` only **buffers** it into a private array
(`worker-host.ts:33`, handler at `:70-82`). It surfaces solely when the model
voluntarily calls `check_inbox` — whose own description instructs
**"Call sparingly"** (`src/tools/tier2/check_inbox.ts:28`).

So the delivery path is: real-time push → in-memory buffer → *hope the model
polls*. A peer sending to a busy peer is writing to a mailbox the recipient is
actively discouraged from opening. In practice a member deep in a 40-turn edit
loop will never read it.

This also silently degrades human steering: `team-runner.ts:40-41` claims the
member "sees it on its next `check_inbox` — mid-turn, no turn boundary," which is
true only if the model happens to poll. `swarm/steer` (`acp/team-agent.ts:297`)
inherits the same weakness.

**This is the single highest-leverage gap.** Without it, every other coordination
primitive degrades to batch-mode.

---

#### G2 — The relation graph is hardwired to a depth-1 star

`standalone-host.ts:1216-1236` rejects any send where **either** side is at depth
> 1, and `*`/`role:` broadcasts exclude depth-0 (`:1195-1207`). Meanwhile spawn
depth allows 3 (`src/swarm/depth-limit.ts:1`).

Consequences:

- A peer that spawns a helper has a helper that can talk to **nobody**.
- Sub-teams cannot exist as first-class peers of each other.
- The only legal communication shape is a star with the orchestrator at the
  center — structurally a hierarchy wearing peer vocabulary.
- docs/25 §6.4 defers multi-team-in-one-orchestrator to "v0.8+" largely because
  of this.

Depth is being used as a **safety proxy** (bound blast radius, prevent message
storms). That's a legitimate concern with an illegitimate implementation: the
right control is an explicit communication policy, not a tree-depth integer.

---

#### G3 — Messaging has no conversation semantics

`send_message` is fire-and-forget. `AgentMessage` carries an optional
`correlationId` but nothing consumes it as a reply channel. `InboxBackend`
declares `readThread` as **optional and unimplemented** (`inbox.ts:80`).

Missing, all of it:

- **Request/reply.** A peer cannot ask a question and get an answer. It can only
  send and then poll, hoping.
- **Blocking ask.** No way to say "I need this before I continue."
- **Threads.** No conversation grouping; no way to read "the discussion about the
  auth interface."
- **Delivery/read receipts.** `SendResult.delivered` counts *enqueued*, not
  *seen*. A sender cannot distinguish "delivered and ignored" from "never read."
- **Priority / delivery class.** Every message is equal — a FYI and a
  stop-work-you're-duplicating-me are the same frame.

---

#### G4 — Shared state does not exist

`docs/05-swarm-model.md:13` promises the atomic agent "can publish/subscribe
shared facts via the shared memory bus." **Grep finds no implementation.** There
is no `publishFact`, no `agentScopeKey`, no bus.

What peers can actually share today: messages (ephemeral, point-to-point,
unstructured prose) and the task registry (`task-registry.ts` — status and
ownership, not findings).

So the only way for agent A to tell agent B "the `AuthProvider` interface takes a
`RequestContext` now" is to send prose, which B may never read (G1), and which is
not durable, queryable, versioned, or visible to a peer that joins later. This is
precisely the lossy-prose failure docs/52 diagnosed in *other* harnesses, present
in ours between peers.

It is also the direct cause of the docs/61 cost finding: with no shared
structured state, "handoff" means copying transcript context, and the bill scales
with it.

**Note the seam that already exists:** `MemoryProvider.enrichTurn(context) →
MemoryFragment[]` (`src/memory/types.ts:85`, coordinator at
`src/memory/coordinator.ts:52`). A shared blackboard wired as a memory provider
would inject relevant peer facts into every turn *automatically*, with no tool
call spent and no prose relay. The plumbing to make shared state cheap is already
built and unused for this purpose.

---

#### G5 — Topologies are rigid shapes, not composable policy

Six classes (`src/swarm/topologies/`), 200–976 LOC each, each hardcoding its own
spawn → wait → aggregate → land sequence. `fanout.ts` alone is 976 lines;
`peer-team.ts` is 806. Much of that is duplicated recovery/landing/cascade
scaffolding.

The rigidity, concretely:

- **Membership is frozen at spawn.** A team cannot add a member, promote one to
  critic, or dissolve a sub-group. `coordinator` is the sole exception — and it's
  a *hierarchy*, where only the root may spawn.
- **Completion is the orchestrator's decision.** `CompletionRule`
  (all/any/majority/deadline/until_signal) is evaluated by the topology
  (`topologies-types.ts`, `team-spec.ts`). Peers cannot collectively declare
  done, renegotiate the split, or hand work to each other outside a pre-declared
  `escalationPolicy`.
- **Work assignment is push-only in practice.** `task_pull_next` exists but no
  topology is built around pull; there are no leases, so a crashed claimer's task
  is stuck.
- **New shapes require new classes.** Want "peer team that promotes a critic
  after the third failed test run"? That's a code change, not config.
- **`communication` rules are parsed but barely enforced.** openteams YAML
  declares channels/subscriptions/emissions and an `enforcement` mode (docs/25
  §5.4); the runtime reduces this to scope-filtered broadcast.

The six shapes are the *interesting* compositions of a handful of orthogonal
policies. Encoding them as classes means every new combination is O(LOC) instead
of O(config).

---

### 2.3 Gap summary

| # | Gap | Blast radius | Fix cost |
|---|---|---|---|
| G1 | No mid-turn attention | Every coordination primitive degrades to batch | Medium (engine) |
| G2 | Depth-1 relation graph | No sub-teams, no peer-of-peer | Low (policy swap) |
| G3 | No conversation semantics | No request/reply, no threads, no receipts | Low (tools only) |
| G4 | No shared state | Prose handoff, cost bloat, no durable findings | Medium (new subsystem + existing memory seam) |
| G5 | Rigid topologies | New shapes cost classes; teams can't adapt | High (refactor) |

---

## 3. Target architecture

Seven pillars. Each maps to gaps above.

```
┌─ Pillar 7: Peer observability (relation graph, blocked-on, blackboard diff)
├─ Pillar 6: Adaptive membership (runtime spawn/promote/dissolve, contract-net)
├─ Pillar 5: Coordination protocols (leases, barriers, proposals, capabilities)
├─ Pillar 4: Shared state (blackboard + memory-provider injection)      [G4]
├─ Pillar 3: Conversation semantics (ask/reply, threads, receipts)      [G3]
├─ Pillar 2: Addressing & communication policy (kill depth gate)        [G2]
└─ Pillar 1: Attention & delivery classes (mid-turn injection)          [G1]
```

Pillars 1–4 are the foundation; 5–7 are what the foundation enables. Pillar 5
(policy decomposition, §3.6) subsumes G5.

---

### 3.1 Pillar 1 — Attention: delivery classes and mid-turn injection

The core new primitive. Replace "buffer and hope the model polls" with an
explicit **delivery class** on every message, and a corresponding **attention
discipline** in the engine.

```ts
type DeliveryClass =
  | "post"      // queue only; surfaces on next check_inbox or turn boundary
  | "notify"    // append to the model's context at the next tool-result
                // boundary — seen on the very next inference, no tool call
  | "interrupt" // abort the in-flight provider stream at the next safe point,
                // inject, and force a re-plan
```

- **`post`** — today's behavior, preserved. FYI traffic, logs, low-priority.
- **`notify`** — the workhorse. The message is appended as a synthetic
  user-role block immediately after the tool-result batch the engine is already
  pushing. In `src/engine/native.ts` that is the seam at **`:576-587`**, where
  each tool result is appended as `{role: "user", content: [...]}`. One extra
  block after the loop, wrapped in a `<peer_message>` envelope, and the model
  sees it on the next inference with **zero tool calls spent** and no polling.
- **`interrupt`** — reserved for stop-work / conflict / kill semantics. Aborts
  the stream, injects, re-plans. Expensive; policy-gated.

#### 3.1.1 The cache constraint (non-negotiable)

docs/55 established that prompt-cache hit rate is the dominant cost lever
(TE-16/18 validated at 88–95%). **Injection must be tail-only.** Appending a
block at the end of the message array preserves the entire cached prefix.
Rewriting the system prompt or inserting mid-array to "place the message where
it's relevant" would invalidate the prefix and cost more than the coordination
saves.

Stated as a rule: *peer messages append; they never rewrite.* Any design that
needs to modify earlier context is rejected.

#### 3.1.2 Attention budget (livelock prevention)

Interruptible peers can livelock each other — A notifies B, B replies, A
re-plans, ad infinitum. Every peer carries an attention budget:

```ts
interface AttentionPolicy {
  maxNotifiesPerTurn: number;      // excess coalesces into one digest block
  maxInterruptsPerTurn: number;    // default 1
  interruptCooldownMs: number;
  coalesceWindowMs: number;        // batch bursts from the same sender
  dedupeBy: "correlationId" | "content-hash" | "none";
  quietWhile?: ToolName[];         // e.g. never interrupt mid-`bash`
}
```

Defaults are conservative and set per role, not per message — the *recipient*
decides how interruptible it is, the sender only requests a class. A sender
cannot escalate its own priority without policy permission.

#### 3.1.3 Engine coverage and graceful degradation

Three engine modes, three levels of support. This must be explicit, not
discovered at runtime:

| Engine | `post` | `notify` | `interrupt` |
|---|---|---|---|
| `NativeEngine` / `hardened-native` | ✅ | ✅ (own the loop; `native.ts:576-587`) | ✅ (own the stream) |
| `ClaudeAgentSdkEngine` | ✅ | ✅ via tool-result augmentation | ⚠️ investigate SDK abort/resume |
| `CodexFrameworkEngine` | ✅ | ⚠️ likely via `DynamicToolCall` response padding | ❌ probably not |

Where a class is unsupported, it **degrades one level and emits a lane event**
saying so. Silent degradation is the failure mode that makes multi-engine teams
untrustworthy. A team spec may declare `requiresDelivery: "notify"` and fail
fast at spawn if a member's engine can't honor it.

**Open question (Q1):** is `interrupt` worth building at all, or is `notify` +
a fast turn loop sufficient? `notify` is cheap and universal; `interrupt` is
expensive and engine-specific. Lean: ship `notify` first, gather evidence that
anything needs `interrupt`.

---

### 3.2 Pillar 2 — Addressing and communication policy

Delete the depth gate (`standalone-host.ts:1216-1236`). Replace tree-depth with
an explicit membership graph plus a policy check.

#### 3.2.1 Addressing grammar

```
agent:<agentId>        exact identity
member:<memberId>      stable team-relative id
role:<name>            all members holding a role, in scope
cap:<capability>       all members announcing a capability (Pillar 5)
*                      all peers in the sender's scope
**                     scope + descendant scopes
team:<name>            another team's scope (policy-gated)
```

#### 3.2.2 Scopes nest

`swarm:<team>` becomes a path: `swarm:review`, `swarm:review/frontend`. A
sub-team is a real scope whose members are peers of each other and,
policy-permitting, addressable from the parent scope via `**`. This is what
unblocks docs/25 §6.4 (multi-team) without waiting for "v0.8+".

#### 3.2.3 CommunicationPolicy replaces the depth check

```ts
interface CommunicationPolicy {
  /** Which addressing forms this member may use. */
  readonly mayAddress: readonly AddressPattern[];
  /** Which senders this member accepts, and at what max delivery class. */
  readonly accepts: readonly { from: AddressPattern; maxClass: DeliveryClass }[];
  /** Hard cap on outbound messages per turn — the message-storm bound. */
  readonly outboundBudgetPerTurn: number;
  /** enforcement: "permissive" logs violations, "strict" rejects. */
  readonly enforcement: "permissive" | "strict";
}
```

This is the runtime home for openteams' `communication` block (docs/25 §5.4),
which today is parsed and largely discarded. `channels`/`subscriptions`/
`emissions` map onto `accepts`/`mayAddress` directly.

Safety parity check: depth-gating bounded blast radius by making distant
messaging impossible. `outboundBudgetPerTurn` + `accepts` bounds it by making
*unauthorized* messaging impossible while leaving authorized peer graphs free.
Strictly more expressive, and it's the control we actually wanted.

**Open question (Q2):** does removing the depth gate open a permission-escalation
path? A depth-2 agent with restricted tools could ask a depth-1 peer to run a
privileged tool on its behalf. The ancestry module (`src/swarm/ancestry.ts`)
exists for exactly this class of check. Needs a decision: does a peer request
inherit the *requester's* permission ceiling? Lean: yes — messages carry the
sender's permission ceiling as metadata, and a recipient acting on a peer request
is capped by `min(own, sender)`. Requires design work before the gate comes out.

---

### 3.3 Pillar 3 — Conversation semantics

**This is the highest value-per-unit-of-risk change in the whole doc: it is pure
tool-layer work, needs no engine change, and works identically across all three
engine modes.**

#### 3.3.1 `ask_peer` — blocking request/reply

```ts
ask_peer({ to: Address, question: string, timeoutMs?: number })
  → { status: "answered", from: AgentId, answer: string }
  | { status: "timeout" }
  | { status: "unreachable"; reason: string }
  | { status: "declined"; reason: string }
```

The insight: **a blocking peer question is just a slow tool call.** The asking
model's turn naturally suspends on the tool; the answer arrives as the tool
result. No engine change, no injection, no polling — it works today's loop as-is.
This alone converts peer messaging from "fire prose into a void" to real dialogue.

The *answering* side is where Pillar 1 pays off: the question arrives as a
`notify`-class delivery, so the recipient sees it on its next inference rather
than whenever it deigns to poll.

#### 3.3.2 `reply`, threads, receipts

```ts
reply({ correlationId: string, content: string })
read_thread({ threadId: string, limit?: number })  // implements inbox.ts:80
```

`AgentMessage` gains `threadId`, `deliveryClass`, `priority`, and a real
`readAt`. `SendResult` distinguishes `enqueued` / `delivered` / `seen`, so a
sender can tell "ignored" from "never arrived" — currently indistinguishable.

#### 3.3.3 Deadlock handling

Blocking calls create cycles: A asks B, B asks A. Required:

- A **wait-for graph** in the host; cycle detection at `ask_peer` admission time,
  rejecting with `status: "declined", reason: "would deadlock: A→B→A"`.
- A **blocking-depth limit** — how many peers may be transitively blocked on one
  chain.
- Timeouts are mandatory, with a sane default (30–60s), never infinite.
- A blocked peer must remain drainable by `interrupt`-class messages and by team
  kill. A blocked peer that can't be killed is a hung team.

---

### 3.4 Pillar 4 — Shared state: the blackboard

Deliver what `docs/05:13` promised, and wire it into the memory system so it's
**free at the point of use**.

#### 3.4.1 Model

A scope-keyed, versioned, append-structured fact store:

```ts
interface Fact {
  readonly key: string;             // "iface/AuthProvider", "decision/db-choice"
  readonly value: unknown;          // JSON; schema optional per namespace
  readonly author: AgentId;
  readonly scope: string;
  readonly version: number;         // monotonic per key
  readonly ts: number;
  readonly ttlMs?: number;
  readonly confidence?: number;     // author's own signal
  readonly supersedes?: number;     // prior version this replaces
}
```

Tools: `fact_put`, `fact_get`, `fact_query(prefix | author | since)`,
`fact_watch(pattern)` → subscription that delivers a `notify`-class message on
change.

Consistency: **versioned last-write-wins per key**, with the full history
retained as an append-only log per scope. Concurrent writers to one key produce a
`fact_conflict` lane event and both versions are readable — peers resolve
semantically rather than the store guessing. Ordering within a scope is the
orchestrator's arrival order (single process today); cross-process ordering is
deferred with the MAP/federation work.

#### 3.4.2 The integration that makes it matter

Wire the blackboard as a **`MemoryProvider`** (`src/memory/types.ts:85`,
coordinator at `src/memory/coordinator.ts:52`). Its `enrichTurn(context)` returns
the facts relevant to this peer's current work as `MemoryFragment[]`.

Consequences:

- Peers acquire each other's findings **without spending a tool call** and
  **without a prose relay**.
- It attacks docs/61's measured cost driver directly: structured facts replace
  transcript copying at handoff.
- It's the natural home for docs/52's lossless-handoff work — handoff becomes
  "the successor reads the same blackboard," not "the predecessor writes a
  summary."
- Existing memory lifecycle (`src/memory/lifecycle.ts`,
  `auto-consolidate.ts`) already handles compaction/consolidation of memory
  entries; the blackboard inherits it.

**Cache constraint again:** enriched fragments must land in a **stable position**
in the prompt. Facts churning every turn at the top of the prompt would destroy
the cache prefix. Either append at the tail (consistent with §3.1.1) or maintain
a designated, infrequently-updated fact section with an explicit refresh
cadence. This needs a decision — see docs/55's standing-constraints section work
for the pattern to follow.

**Open question (Q3):** what's the retrieval policy for `enrichTurn`? Everything
in scope (blows up context), keyword-relevant (needs an index), explicitly
watched (peer declares interest up front), or author-recency? Lean: explicit
watch + recency, because it's predictable and cache-friendly. Relevance ranking
is a later optimization.

---

### 3.5 Pillar 5 — Coordination protocols

With attention, addressing, dialogue, and shared state in place, real
coordination primitives become expressible.

#### 3.5.1 Leases (generalize the branch lock)

`src/swarm/git/branch-lock.ts` already implements the hard part: O_EXCL
acquisition, owner/pid record, stale reclaim. Generalize it from branches to
**any resource**:

```ts
lease_acquire({ resource: string, ttlMs: number, mode: "exclusive" | "shared" })
  → { granted: true; leaseId; expiresAt } | { granted: false; heldBy: AgentId; expiresAt }
lease_renew({ leaseId })      // heartbeat
lease_release({ leaseId })
```

Resources: file paths, modules, branches, task ids, external services. This is
what lets peers negotiate over the working tree without an orchestrator
serializing them, and it makes `task_pull_next` safe — a claimed task holds a
lease, and a crashed claimer's task becomes reclaimable instead of stuck.

#### 3.5.2 Barriers and rendezvous

```ts
barrier({ name: string, parties: number, timeoutMs })  // block until N arrive
```

Enables "everyone finish exploration before anyone starts editing" without an
orchestrator phase gate. Shares the deadlock machinery from §3.3.3.

#### 3.5.3 Proposals and collective decisions

Promote `Aggregator: {kind: "vote"}` from an orchestrator-side function to a
peer-invocable protocol:

```ts
propose({ topic: string, options: string[], quorum: number, timeoutMs })
vote({ proposalId: string, choice: string, rationale?: string })
```

The team decides; the orchestrator tallies. This is the concrete mechanism for
*peer-initiated completion* — a team can vote itself done rather than waiting for
`CompletionRule` to fire externally.

#### 3.5.4 Capabilities and contract-net

Each peer announces what it can do:

```ts
announce_capability({ name: string, description: string, cost?: number })
```

which populates `cap:<capability>` addressing (§3.2.1) and enables the classic
**contract-net** protocol: a peer with work it can't do announces the task, peers
bid, the announcer awards. This is the real answer to rigid topologies — work
routing becomes an emergent negotiation instead of a declared shape.

Contract-net is the most speculative item here. It should be gated on the
foundation proving out.

---

### 3.6 Pillar 6 — Topologies as composable policy (fixes G5)

Decompose the six monolithic topology classes into orthogonal policies. A
topology becomes a **preset**: a named composition, not a class.

```ts
interface TeamPolicy {
  membership:    MembershipPolicy;    // static set | dynamic spawn triggers | contract-net
  communication: CommunicationPolicy; // §3.2.3
  attention:     AttentionPolicy;     // §3.1.2
  work:          WorkPolicy;          // push | pull+lease | decomposition rules
  completion:    CompletionPolicy;    // existing CompletionRule + peer-initiated quorum
  aggregation:   AggregationPolicy;   // existing Aggregator
  workspace:     WorkspacePolicy;     // existing BranchPolicy + landing/recovery
}
```

The six named topologies re-expressed:

| Preset | membership | communication | work | completion |
|---|---|---|---|---|
| `fanout` | static | none | push | all |
| `pipeline` | static | sequential handoff | push, ordered | all (fail-fast) |
| `peer-team` | static | full mesh in scope | push | all |
| `coordinator` | dynamic (root spawns) | star | push | root-decides |
| `committee` | static, same prompt | none | push | all + vote/judge |
| `critic-loop` | static pair | bidirectional | push, iterated | until_signal |

Same CLI surface, same YAML, same names — `openswarm topology peer-team` keeps
working. But:

- New shapes are **config**, not classes. "Peer team that promotes a critic after
  three failed test runs" becomes a membership trigger.
- The duplicated recovery / landing / cascade scaffolding currently copy-pasted
  across `fanout.ts` (976 LOC), `peer-team.ts` (806 LOC) etc. collapses into one
  shared executor.
- **`peer-team` becomes the base case**, with the others as constraints applied
  to it — which is exactly the "peer-first" inversion this doc argues for.

This is the highest-cost item in the doc and should land **after** Pillars 1–4
prove out, so the policy interfaces are shaped by working primitives rather than
guessed at.

---

### 3.7 Pillar 7 — Peer observability

`team watch` renders per-member lanes — the right view for parallel independent
workers, the wrong view for interacting peers. Additions:

- **Relation graph** — live who-is-talking-to-whom, message volume per edge.
- **Blocked-on view** — the wait-for graph from §3.3.3, so a stalled team is
  diagnosable at a glance rather than by reading five transcripts.
- **Blackboard inspector** — current facts, versions, authors, conflicts.
- **Attention ledger** — notifies delivered vs. coalesced vs. dropped by budget;
  the diagnostic for "why didn't my peer react?"
- **Lane events** for every new primitive: `peer_ask`, `peer_reply`,
  `fact_put`, `fact_conflict`, `lease_granted`, `lease_stolen`,
  `barrier_reached`, `proposal_opened`, `attention_dropped`, `deadlock_broken`.

The `_meta.swarm` ACP convention (docs/36) needs a v2 to carry these, so
third-party clients (Zed) can render peer interaction rather than just N lanes.

---

## 4. Failure modes this introduces

Peer systems fail in ways hierarchies don't. Each needs an explicit control, not
a hope:

| Failure | Control |
|---|---|
| **Livelock** — peers mutually interrupting forever | Attention budget §3.1.2; coalescing; cooldowns |
| **Deadlock** — mutual blocking asks | Wait-for graph + cycle detection §3.3.3; mandatory timeouts |
| **Message storm** — N² broadcast traffic | `outboundBudgetPerTurn` §3.2.3; broadcast requires explicit policy grant |
| **Orphaned leases** | TTL + heartbeat + stale reclaim (already proven in `branch-lock.ts`) |
| **Consensus stalemate** | Quorum timeouts; fall back to declared `Aggregator` |
| **Context bloat from injection** | Tail-only append; digest coalescing; per-turn injection byte cap |
| **Cache thrash** | Tail-only rule §3.1.1; stable fact placement §3.4.2; measure hit-rate as a gate |
| **Cost blowup** | Aggregate team budget already exists (docs/25 §9.6); extend to count coordination overhead separately so it's attributable |
| **Peer-mediated permission escalation** | Q2 §3.2.3 — `min(own, sender)` ceiling; unresolved |

The measurable meta-risk: coordination overhead exceeds coordination benefit.
Which is why §9 exists.

---

## 5. What this does *not* change

Guardrails so the refactor stays bounded:

- **Single-agent remains first-class.** `openswarm "..."` unchanged. Every peer
  tool no-ops cleanly outside a team scope.
- **Subprocess isolation stays.** No thread-based peers (docs/05 anti-patterns).
- **Existing CLI/YAML surface preserved.** Topology names, `team start/send/
  watch/stop`, `swarm run tasks.jsonl` all keep working.
- **Engine-mode parity is a requirement, not a bonus.** Any primitive that only
  works on `NativeEngine` must degrade explicitly and loudly (§3.1.3). Mixed-
  provider peer teams are the differentiator; breaking them to get peer features
  is a net loss.
- **Cache efficiency is a gate, not an afterthought.** docs/55's measurement
  harness should run against every phase.

---

## 6. Phasing

Ordered by value-per-risk. Each phase is independently shippable and
independently measurable.

### Phase P0 — Coordination-necessary benchmark *(prerequisite)*

Before building: a task set that a single agent **cannot** solve well and that
two coordinating agents can. Candidates: cross-module refactors where the
interface is discovered by one agent and consumed by another; tasks requiring
simultaneous edits to a producer and consumer; conflict-resolution scenarios.
Without this, §9 can't distinguish success from noise. See §9.

### Phase P1 — Conversation semantics *(tool layer only, no engine change)*

`ask_peer` / `reply` / `read_thread`; `AgentMessage` gains `threadId` +
`deliveryClass` + real receipts; wait-for graph + cycle detection; `SendResult`
distinguishes enqueued/delivered/seen.

*Why first:* highest value per unit of risk. Works on all three engines today.
Turns messaging into dialogue with zero engine work.

### Phase P2 — Addressing and communication policy

Remove the depth gate; nested scopes; addressing grammar; `CommunicationPolicy`
enforcing openteams' `communication` block; outbound budgets. **Blocked on
resolving Q2** (permission ceiling).

### Phase P3 — Attention

`notify`-class mid-turn injection in `NativeEngine` (`native.ts:576-587`), then
`ClaudeAgentSdkEngine`, then Codex. `AttentionPolicy` + coalescing + budgets.
Explicit degradation events. `interrupt` deferred pending evidence (Q1).

*Why after P1/P2:* P1's `ask_peer` already delivers real dialogue via the tool
loop. P3 makes the *receiving* side responsive, which is what makes unsolicited
coordination work.

### Phase P4 — Blackboard

Fact store + tools + `fact_watch`; `SwarmMemoryProvider` wired into
`MemoryCoordinator.enrichTurn`; conflict events; stable-placement strategy.
Retire the unimplemented promise at docs/05:13.

### Phase P5 — Coordination protocols

Generalize `branch-lock` → leases; `task_pull_next` + leases → real self-
balancing pull; barriers; proposals/voting; peer-initiated completion.

### Phase P6 — Policy decomposition

`TeamPolicy` composition; six topologies become presets; shared executor
replaces duplicated scaffolding. Runtime membership mutation (`team_spawn_peer`,
`team_promote`, `team_dissolve`).

### Phase P7 — Capabilities / contract-net + observability

`announce_capability`, `cap:` addressing, contract-net bidding. Relation graph,
blocked-on view, blackboard inspector, attention ledger. `_meta.swarm` v2.

---

## 7. Positioning

Once P1–P4 land, the pitch describes something the code does:

> **Agents that talk to each other, not just to you.**
>
> Every other harness spawns subagents: children that run alone and return a
> paragraph. OpenSwarm runs *peers* — addressable, interruptible, sharing a
> blackboard, on different model providers, coordinating without a parent.

Three proof points, all defensible and all differentiated:

1. **Mixed-provider peers.** A Claude Max member, a ChatGPT member, and an
   API-key member in one team, messaging each other. Nobody else has this.
2. **Interruptible peers.** A peer can change what another peer is doing
   *mid-task*. Everyone else can only wait for the child to return.
3. **Shared state, not prose handoff.** docs/52 documented that CC/OpenCode/Codex
   are all lossy-prose; the blackboard is the structured alternative, and docs/61
   already measured what prose handoff costs.

The empirical hook — docs/59's resident-advisor `+0.13` — should be promoted out
of the model-routing docs and into the peer thesis, where it's actually evidence.

---

## 8. Open questions

| # | Question | Lean |
|---|---|---|
| Q1 | Build `interrupt`-class delivery, or is `notify` enough? | Ship `notify`; require evidence before `interrupt` |
| Q2 | Does removing the depth gate open peer-mediated permission escalation? | Messages carry sender's ceiling; recipient capped at `min(own, sender)`. **Blocks P2** |
| Q3 | `enrichTurn` retrieval policy for blackboard facts | Explicit `fact_watch` + recency; relevance ranking later |
| Q4 | Blackboard consistency across processes (MAP federation, team daemon) | Single-process LWW now; defer cross-process to federation work |
| Q5 | Does `ask_peer` blocking interact badly with provider request timeouts / compaction mid-block? | Needs a spike |
| Q6 | Do we keep six topology names after P6, or collapse to `peer-team` + policy flags? | Keep names as presets — CLI compat and they're good documentation |
| Q7 | Does the blackboard subsume or complement the task registry? | Complement: tasks are work items, facts are findings |
| Q8 | Do peers need to see each other's *transcripts*, or only facts + messages? | Facts + messages; transcripts are the bloat docs/61 measured |
| Q9 | Idle-timeout policy for peers waiting on `ask_peer` / barriers — do they count as idle and get drained? | Blocked ≠ idle; needs an explicit lifecycle state |

---

## 9. How we'd know it worked

The measurement problem from §1.2 restated as a plan. **This is the part most
likely to be skipped and most likely to determine whether the work was worth
it.**

### 9.1 The benchmark gap

Existing eval cells (docs/50–62) run SWE-bench-style tasks, which are
single-agent-solvable by construction. docs/60 found one coordination-rescue cell
in the entire sweep. Running peer architecture against the same tasks will
produce the same wash, and we'll learn nothing.

**P0 deliverable:** a coordination-necessary task set. Design criteria — a task
qualifies only if a single agent with the same total budget does measurably
worse, for an identifiable reason:

- **Information asymmetry:** the fact needed by agent B is discoverable only by
  doing agent A's work (e.g. the real shape of a generated interface).
- **Simultaneity:** producer and consumer must change together or tests fail.
- **Scale:** context genuinely exceeds one agent's window, so partition is forced.
- **Genuine conflict:** two agents must edit overlapping regions and negotiate.

### 9.2 Hypotheses

| # | Hypothesis | Metric | Phase |
|---|---|---|---|
| HP-1 | Mid-turn delivery reduces wasted work | Tokens spent *after* a superseding message was queued but unread (measurable today as a baseline — likely large) | P3 |
| HP-2 | Blackboard beats prose handoff on cost | Tokens/task vs. docs/61 handoff-bloat baseline, same tasks | P4 |
| HP-3 | Peers beat spawn-and-await on coordination-necessary tasks | Resolve rate on the P0 set, peer-team vs. mono vs. coordinator | P1+ |
| HP-4 | Coordination overhead is bounded | Coordination tokens as a fraction of total; must not exceed the quality gain | all |
| HP-5 | Peer features don't cost cache | Cache hit rate before/after, gated at docs/55's 88–95% | P3, P4 |
| HP-6 | Resident peers > cold spawns, generalized | Replicate docs/59's `+0.13` under the peer architecture | P4 |

HP-4 and HP-5 are **gates**, not hypotheses. If coordination overhead eats the
gain, or injection tanks the cache, the design is wrong and should change before
the next phase.

### 9.3 Instrumentation to add early

Coordination cost must be **separately attributable** from task cost — injected
message tokens, blackboard enrichment tokens, `ask_peer` wait time, messages sent
vs. read. Without this split, HP-4 is unmeasurable and every result is
confounded. This should land in P1, before the expensive phases.

---

## 10. Summary

| Gap | Pillar | Phase | Cost |
|---|---|---|---|
| G3 no conversation semantics | 3 | P1 | Low — tools only |
| G2 depth-1 relation graph | 2 | P2 | Low — policy swap (blocked on Q2) |
| G1 no mid-turn attention | 1 | P3 | Medium — engine, 3 modes |
| G4 no shared state | 4 | P4 | Medium — new subsystem on existing memory seam |
| — | 5 coordination protocols | P5 | Medium — generalize branch-lock |
| G5 rigid topologies | 6 | P6 | High — refactor |
| — | 7 observability | P7 | Medium |

The through-line: **openswarm has the identity layer for peers and none of the
interaction layer.** Agents can be named and addressed; they cannot converse,
cannot reach each other while working, cannot share findings, and cannot
reorganize. Fixing that in the order above turns a well-built orchestrator into
the peer harness the vision doc already claims.
