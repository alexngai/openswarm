# Team orchestration

Design doc for swarm-harness's team orchestration layer. Companion to [docs/00-vision.md](00-vision.md) — the layer that turns "one agent is a tool" into "N coordinated agents is the product."

**Authoring date:** 2026-05-01.
**Status:** shipped 2026-05-02 (v0.4). Commits `0bd0f20..<close-out>`. See [§16 v0.4 close-out](#16-v04-close-out) for the per-stage breakdown. Phased plan beyond v0.4 (v0.5–v0.8) per [§13](#13-phased-delivery).
**Anchor:** [docs/00-vision.md](00-vision.md), [docs/05-swarm-model.md](05-swarm-model.md), [docs/21-roadmap-v0.2-to-v0.4.md § Release v0.4](21-roadmap-v0.2-to-v0.4.md).
**Reviewed against:** v0.3 (commits `b9a13b2..6bf317f`) — Codex App Server FrameworkProvider integration. See [§8a Engine-mode parity for team peers](#8a-engine-mode-parity-for-team-peers).
**Spike-verified 2026-05-02:** Track A (claude-agent-sdk peers) + Track B (codex DynamicToolCall) both GREEN. Empirical evidence: [docs/26-team-orchestration-spikes.md](26-team-orchestration-spikes.md).

---

## 1. Goal & non-goals

### Goal

Make `swarm-harness` a first-class implementation of the swarmkit team model — peer-spawning teams with shared messaging, shared task graphs, and topology-driven coordination — while staying useful as a single-agent CLI.

Equivalent to Claude Code's native team primitives (`Agent({team_name})`, `SendMessage`, `TaskCreate/List/Update`) **plus** a topology layer that names common shapes (fanout, pipeline, peer team, committee, critic loop, coordinator). Wire-compatible with the swarmkit ecosystem (MAP, agent-inbox, opentasks, git-cascade) so swarm-harness teams look identical to cc-swarm teams from the outside.

### Non-goals

- Cross-machine federated teams. (MAP federation is a future stretch goal; v0.4 scope is local.)
- Replacing Claude Code or cc-swarm. swarm-harness is its own runtime; this doc describes equivalent primitives, not interop bridges.
- Hosted multi-tenant orchestration. Local processes only.
- Hiding the existing single-agent surface. `swarm-harness "..."` and `swarm run tasks.jsonl` keep working unchanged.
- Designing new coordination primitives the swarmkit ecosystem doesn't already model. Teams, scopes, threaded inboxes, task graphs, branch streams are all defined in swarmkit packages — we adopt them.
- **Bridging Codex's native multi-agent primitives.** Codex App Server has its own multi-agent collaboration events (`CollabAgentSpawn*`, `CollabAgentInteraction*`, `CollabWaiting*`, `CollabClose*`) intended for ChatGPT's intra-process multi-agent projects. We deliberately don't bridge them — instead we use Codex's `DynamicToolCall` mechanism to register swarm-harness's Tier 2 tools as host tools. See [§8a.4](#8a4-codex-native-multi-agent-primitives--still-not-bridged) for rationale.

---

## 2. Decision summary

Resolved via brainstorm on 2026-05-01. Cited per-section below.

| # | Question | Decision | Rationale |
|---|---|---|---|
| Q1 | openteams YAML — first-class, shell-out, or native format? | **First-class.** swarm-harness reads `team.yaml` natively via the `openteams` npm package as a library. Update openteams to expose any shared functionality. | Self-contained, format-compatible with cc-swarm, no codegen step. |
| Q2 | Coordinator pattern — model-driven or code-driven spawn? | **Both.** Topology kind decides — `coordinator` topology spawns root only and lets the model spawn peers via `agent` tool calls; `peer-team`/`committee`/`pipeline` are code-driven up-front. | swarm-harness has more flexibility than cc-swarm (which is constrained by Claude Code's spawn restrictions); we should support both. |
| Q3 | Long-lived workers — push or pull task acceptance? | **Push primary, pull supported.** Default is orchestrator pushes tasks via IPC. Pull-from-queue (opentasks) is a flag. | Push is simpler and matches Claude Code teams; pull lights up self-balancing later. |
| Q4 | MAP — sidecar or in-process? | **In-process.** swarm-harness embeds the MAP SDK in the orchestrator. Sidecar parity remains available behind a flag. | cc-swarm's sidecar is needed because hooks are short-lived; swarm-harness has a long-lived orchestrator and can hold the connection. |
| Q5 | agent-inbox — replace or layer? | **Make `AgentInbox` implement the agent-inbox wire protocol with a pluggable backing store.** Default backing = in-process; opt-in backing = agent-inbox daemon/MCP. | swarm-harness must work standalone (no MCP daemon). Same wire protocol means flipping the adapter is a config change, and swarm-harness becomes one of agent-inbox's reference implementations. |
| Q6 | opentasks — replace or supplement TaskRegistry? | **Pluggable `TaskAPI`.** `InMemoryTaskRegistry` (default) and `OpenTasksTaskRegistry` (opt-in) implement the same interface. | Long-term streamlining matters; one task-graph backbone for the whole stack pays off. |
| Q7 | git-cascade integration shape | **Adapter behind `BranchPolicy`.** New `BranchPolicy` variants (`{kind: "stream", streamId}`, `{kind: "fork", parent}`) delegate to `MultiAgentRepoTracker`. Worktree-per-member becomes the default for parallel topologies. | git-cascade is the canonical worktree/branch-stack layer; we adopt its API directly. |
| Q8 | Phasing | **v0.4 = minimum + MAP.** v0.5 adds opentasks adapter; v0.6 agent-inbox; v0.7 git-cascade; v0.8 long-tail topologies. | Ship the smallest piece that fulfills the vision, then layer adapters one at a time. |

---

## 3. Vocabulary

| Term | Definition |
|---|---|
| **Agent** | An atomic Claude-backed worker. One subprocess per agent. swarm-harness's existing primitive. |
| **Member** | An agent participating in a team. Carries a role + prompt + budget. |
| **Peer** | A member at the same depth as another member of the same team. Peers can message each other directly. |
| **Role** | Named configuration overlay — system-prompt suffix + tool allowlist. Resolved via `RoleRegistry`. swarm-harness primitive today. |
| **Team** | A set of members sharing a `teamName` namespace. Team-scoped messaging (`*` and `role:<x>` resolve within team). One team owns a coordinated unit of work. |
| **Topology** | A composition rule for a team — when members spawn, how they coordinate, how the team completes. Built-ins: fanout, pipeline, coordinator, peer-team, committee, critic-loop. |
| **TeamSession** | Live runtime instance of a team. Owns the member set, message routing scope, and lifecycle. One per running team. |
| **Scope** | swarmkit/MAP namespace. `swarm:<teamName>`. All MAP events from a team carry this scope. |
| **Stream** | git-cascade work unit. 1:1 with a branch. Owned by an agent. Used for worktree-per-member topologies. |
| **TopologyKind** | Discriminator naming the coordination shape: `"fanout" \| "pipeline" \| "coordinator" \| "peer-team" \| "committee" \| "critic-loop"`. Pluggable. |
| **Engine mode** | How the agent loop is owned. `transport` = swarm-harness owns the loop (`ClaudeAgentSdkEngine` default + `NativeEngine`); full Tier 0/1/2 + MCP available natively. `framework` = an external framework owns the loop (`--framework claude-agent-sdk` for Claude Max, `--framework codex-chatgpt` for ChatGPT Plus/Pro). **All three engine modes can serve as team peers**, each via a different mechanism — see [§8a](#8a-engine-mode-parity-for-team-peers). The original framework-filter strip is dropped for team members and replaced with Codex's `DynamicToolCall` registration where the framework hosts host-defined tools. |

---

## 4. Architecture

### 4.1 Layering

```
┌─ Layer 5: User entrypoints
│    swarm run tasks.jsonl                  (preserved; FanoutTopology under the hood)
│    swarm team start <template>            (NEW; openteams template → live team)
│    swarm team send <team> <prompt>        (NEW; long-lived team interaction)
│    swarm topology <kind> <spec.json>      (NEW; direct topology run)
│    /team in TUI                           (NEW; interactive)
│
├─ Layer 4: Topology executors                          (NEW)
│    Fanout · Pipeline · Coordinator · PeerTeam · Committee · CriticLoop
│    Each ~100–250 LOC. Compose Layer 3 primitives.
│
├─ Layer 3: TeamSession primitive                       (NEW — central piece)
│    Team-scoped namespace; member registry; spawn / await / kill;
│    team-scoped broadcast + role addressing; team-filtered events.
│
├─ Layer 2: Ecosystem adapters                          (NEW; each off by default)
│    MAP · agent-inbox · opentasks · git-cascade
│    Each adapter implements an existing swarm-harness interface.
│
└─ Layer 1: Atomic agent + SwarmHost                    (today)
     Subprocess worker, send_message, AgentInbox, TaskRegistry, RoleRegistry,
     RoleIndex, ancestry, branch-lock, worker lifecycle.
```

The trick: **layers 2–4 don't change worker code**. A subprocess worker doesn't know whether messages route via in-memory `AgentInbox` or via the agent-inbox daemon — same JSON-RPC envelope from the worker's POV. The orchestrator owns the choice.

### 4.2 What changes vs today's `Orchestrator`

Today's [`src/swarm/orchestrator.ts`](../src/swarm/orchestrator.ts) is a fanout runner that does layers 3+4 inline (single topology). The refactor:

1. Extract `TeamSession` (Layer 3) — the namespace + spawn + lifecycle bits.
2. Extract `FanoutTopology` (Layer 4) — what `Orchestrator.run()` does today.
3. Add other topologies as siblings of `FanoutTopology`.
4. `Orchestrator` becomes a thin shell that picks a topology based on input.
5. Existing `swarm run tasks.jsonl` invokes `FanoutTopology` — zero behavior change.

### 4.3 Standalone vs ecosystem-integrated

```
Standalone mode (no flags):
  ┌──────────────────────────┐
  │ swarm-harness orchestrator│
  │  ├─ TeamSession (in-proc) │
  │  ├─ AgentInbox (memory)   │
  │  ├─ TaskRegistry (memory) │
  │  └─ workers (subprocess)  │
  └──────────────────────────┘

Ecosystem-integrated (--map --opentasks --inbox --git-cascade):
  ┌──────────────────────────┐         ┌─────────────┐
  │ swarm-harness orchestrator│ ◄─────► │ MAP server  │
  │  ├─ TeamSession           │         └─────────────┘
  │  ├─ AgentInbox (daemon)   │ ◄─────► .swarmkit/inbox/
  │  ├─ TaskRegistry (daemon) │ ◄─────► .opentasks/graph.jsonl
  │  ├─ git-cascade tracker   │ ◄─────► .git-cascade/tracker.db
  │  └─ workers (subprocess)  │
  └──────────────────────────┘
```

The orchestrator code is identical in both modes. The constructor wires either the in-memory implementations or the daemon-backed ones based on config.

---

## 5. Data model

### 5.1 `TeamSpec`

The unit-of-input for any topology. Subsumes today's `TaskPacket[]`.

```ts
interface TeamSpec {
  /** Unique name within this orchestrator. Used as MAP scope `swarm:<name>` and inbox namespace. */
  readonly name: string;

  /** Discriminator — picks the topology executor. */
  readonly topology: TopologyKind;

  /** The members. Each is roughly a TaskPacket + role. */
  readonly members: readonly MemberSpec[];

  /** Coordination rules — completion, aggregation, budget, branching. */
  readonly coordination: TeamCoordination;

  /** Optional: openteams template name, if this spec was loaded from one. */
  readonly templateName?: string;
}

type TopologyKind =
  | "fanout"        // N independent, no messaging
  | "pipeline"      // Sequential; output of N-1 → context of N
  | "coordinator"   // 1 root; root spawns peers via `agent` tool calls
  | "peer-team"     // N parallel, messaging enabled, distinct roles/prompts
  | "committee"     // N parallel, same prompt, aggregate via vote/judge
  | "critic-loop"   // 2 peers (executor + critic); loop until critic approves
```

### 5.2 `MemberSpec`

```ts
interface MemberSpec {
  /** Stable id within the team. Defaults to slugified role + index. */
  readonly id?: string;
  /** Required. Resolves via RoleRegistry to system-prompt suffix + allowedTools. */
  readonly role: string;
  /** The member's prompt. May reference team context (see §6.5). */
  readonly prompt: string;
  /** Optional per-member budget. Falls through to team aggregate budget. */
  readonly budget?: TaskBudget;
  /** Optional per-member branch policy. Defaults from coordination.defaultBranchPolicy. */
  readonly branchPolicy?: BranchPolicy;
  /** Optional per-member commit policy. */
  readonly commitPolicy?: CommitPolicy;
  /** Optional model override (defaults to orchestrator's model). */
  readonly model?: string;
}
```

### 5.3 `TeamCoordination`

```ts
interface TeamCoordination {
  /** When does the team finish? */
  readonly completion: CompletionRule;

  /** How are member outputs combined into one result? */
  readonly aggregator?: Aggregator;

  /** Aggregate token + cost cap across all members. Per-member budgets nest under this. */
  readonly aggregateBudget?: { maxTokens?: number; maxCostUsd?: number };

  /** Default branch policy applied to every member without one. */
  readonly defaultBranchPolicy?: BranchPolicy;

  /** Per-team messaging rules — who can talk to whom, signal vocabulary. Maps to openteams `communication` block. */
  readonly communication?: TeamCommunicationRules;
}

type CompletionRule =
  | { readonly kind: "all" }                        // wait for every member
  | { readonly kind: "any" }                        // first finishing wins; cancel others
  | { readonly kind: "majority"; readonly m: number } // M of N finish
  | { readonly kind: "deadline"; readonly ms: number }
  | { readonly kind: "until_signal"; readonly signal: string }; // emitted via send_message

type Aggregator =
  | { readonly kind: "concat"; readonly separator?: string }
  | { readonly kind: "last" }                       // last member's output (e.g. pipeline)
  | { readonly kind: "vote" }                       // majority winner; ties → first
  | { readonly kind: "judge"; readonly role: string } // spawn a judge member to synthesize
  | { readonly kind: "custom"; readonly fn: (results: MemberResult[]) => string };
```

Per Q4: aggregation can be agent-driven (`judge`) or code-driven (`vote`, `concat`, `custom`). Per the Q4 brainstorm answer ("rely on agent flexibility over more rigid output structures"), `judge` is the recommended default for committee/critic-loop topologies; `concat` and `last` cover the deterministic shapes.

### 5.4 openteams YAML compatibility

Per Q1, swarm-harness reads `team.yaml` natively. The mapping:

```yaml
# openteams team.yaml (compatible with cc-swarm)
name: feature-team
description: "Architect, executor, reviewer for one feature."
version: 1
roles: [architect, executor, reviewer]

topology:
  root: { role: architect }                  # → TopologyKind: "coordinator"
  spawn_rules:
    architect: [executor, reviewer]
    executor: []
    reviewer: []

communication:
  enforcement: permissive
  channels:
    workflow:
      signals: [DESIGN_DONE, IMPL_DONE, REVIEW_DONE]
  subscriptions:
    architect: [{ channel: workflow }]
  emissions:
    architect: [DESIGN_DONE]
    executor:  [IMPL_DONE]
    reviewer:  [REVIEW_DONE]

# Optional swarm-harness extensions (under x-swarm-harness namespace):
x-swarm-harness:
  topology: peer-team                         # override the default mapping
  coordination:
    completion: { kind: "all" }
    aggregator: { kind: "judge", role: reviewer }
    defaultBranchPolicy: { kind: "stream" }   # uses git-cascade adapter
```

**Mapping rules:**

- `topology.root` + non-trivial `spawn_rules` → `TopologyKind: "coordinator"` (root + model-driven spawning).
- `topology.root` + empty `spawn_rules` (root only) → single-agent run (no team).
- `topology.root` + flat `spawn_rules` (all roles spawned by root) is the cc-swarm shape; we treat it as `coordinator` unless `x-swarm-harness.topology` overrides.
- `communication.channels`/`subscriptions`/`emissions` → `TeamCommunicationRules`. Signals translate to a structured `send_message` content schema.
- Per-role prompts come from generated artifacts (cc-swarm uses `openteams generate all` to materialize them under `.swarm/.../agents/`); swarm-harness will use the openteams library directly to do the same generation in-process.
- `x-swarm-harness:` is the escape hatch for swarm-harness-specific overrides (extension key per YAML convention).

**Update to openteams package (Q1 follow-up):**

To make this work cleanly we likely need openteams to expose:

1. A pure programmatic API for resolving + parsing a template (without a CLI shell-out).
2. A pure programmatic API for materializing per-role prompts (without writing to disk; return strings).
3. A typed schema for the `topology`, `communication`, and `x-*` extension blocks so swarm-harness can validate and consume them safely.

Filed for openteams as a separate work item; doesn't block this design.

---

## 6. `TeamSession` primitive

The center of the new architecture. Owns one team's runtime.

### 6.1 Interface

```ts
interface TeamSession {
  readonly name: string;                              // unique per orchestrator
  readonly scope: string;                             // "swarm:<name>" — MAP scope
  readonly members: ReadonlyMap<AgentId, MemberInfo>;
  readonly roles: ReadonlyMap<string, AgentId[]>;     // role → member ids

  /** Spawn one new member into this team. */
  spawnMember(spec: MemberSpec): Promise<AgentHandle>;

  /** Spawn a batch in parallel. Used by code-driven topologies. */
  spawnAll(specs: readonly MemberSpec[]): Promise<AgentHandle[]>;

  /** Send a message scoped to this team. `*` and `role:x` resolve within team only. */
  send(from: AgentId, to: AgentId | "*" | `role:${string}`, content: string): Promise<SendResult>;

  /** Wait for completion per the team's CompletionRule. */
  await(rule: CompletionRule): Promise<TeamWaitResult>;

  /** Kill all members. Used on aborted runs, deadline expiry, `any`-completion cleanup. */
  kill(reason: string): Promise<void>;

  /** Lane events filtered to this team's scope. */
  events(): AsyncIterable<LaneEvent>;

  /** Cleanup all team-scoped resources (inbox queues, role index entries, branch locks). */
  dispose(): Promise<void>;
}

interface MemberInfo {
  readonly memberId: string;     // stable id from MemberSpec or generated
  readonly role: string;
  readonly agentId: AgentId;
  readonly handle: AgentHandle;
  readonly state: "spawning" | "running" | "idle" | "finished" | "failed";
}
```

### 6.2 Where it lives

New file: [`src/swarm/team-session.ts`](../src/swarm/team-session.ts). Constructor takes:

- The host (`StandaloneHost`) for spawning + emitting.
- The team name.
- The `RoleRegistry` for resolving roles.
- An optional `MemberAggregator` for aggregating results.

Today's `RoleIndex`, `AgentInbox`, branch-lock manager become **team-aware** — keyed by `(scope, agentId)` instead of global `agentId`. Backwards-compat: when no `TeamSession` is in play (e.g. `swarm-harness "..."`), the implicit team is `swarm:default` and the existing single-tenant semantics still apply.

### 6.3 Team-scoped messaging

The change: `*` and `role:<name>` now resolve **within the calling agent's team scope**.

```ts
// In src/swarm/standalone-host.ts (today's send method).
// Before:
recipients = [...this.depths.keys()].filter(/* exclude self + depth-0 */);

// After:
const senderScope = this.scopeOf(from);
recipients = this.scopeMembers(senderScope).filter(/* exclude self */);
```

Direct `agentId` addressing still works cross-scope (tools that *know* an agentId can reach it). Broadcasts are bounded.

### 6.4 Multi-team in one orchestrator

Multiple `TeamSession` instances can run concurrently in one orchestrator process. Each has its own scope; messaging doesn't cross. This is what unblocks scenarios like a top-level architect coordinating two parallel sub-teams.

For v0.4, one orchestrator runs **one team at a time**. Multi-team support comes with the coordinator-of-coordinators topology in v0.8+.

### 6.5 Team context exposure

Each member has these injected via env so the model can use them:

| Env var | Value |
|---|---|
| `SWARM_HARNESS_TEAM_NAME` | The team's `name` |
| `SWARM_HARNESS_TEAM_SCOPE` | `swarm:<name>` |
| `SWARM_HARNESS_MEMBER_ROLE` | This member's role |
| `SWARM_HARNESS_MEMBER_ID` | This member's `memberId` |

A new Tier 2 tool, `team_members()`, returns `[{memberId, role, agentId}]` filtered to the calling team. Helps the model decide who to message.

---

## 7. Long-lived worker model

### 7.1 Why

Today's worker spawns, runs one task, exits. Claude Code teams persist between turns — you send a message to a teammate and they're still there. swarm-harness teams need the same.

### 7.2 Worker lifecycle changes

Add states to the existing [`src/swarm/worker-lifecycle.ts`](../src/swarm/worker-lifecycle.ts):

```
spawning → ready → running → idle → running → … → finished
                            │
                            └─ optional: idle → finished (graceful drain)
                            └─ optional: idle → cancelled (team kill)
```

After a member finishes its current prompt, instead of exiting, it transitions to `idle` and waits for either:

- A new prompt via `worker.send("run", {prompt, ...})` IPC frame (push — Q3 default).
- A new task claimed from a shared queue (pull — opt-in via opentasks adapter).
- A graceful drain signal (`worker.send("drain")`) → finishes after current task → transitions to `finished`.

### 7.3 Idle state semantics

An idle worker:
- Holds its session (compaction state, cache, history).
- Holds its subprocess (no respawn cost).
- Continues to receive lane events, inbox messages, lifecycle pokes.
- Can answer `team_members()` queries.
- Can read its inbox if the model decides to (`check_inbox`).
- Reports usage / budget continuously.

### 7.4 Push protocol (default)

```
orchestrator → worker:  run({ prompt, taskId? })           // start a turn
worker       → orchestrator: lane events, tool calls
worker       → orchestrator: task_result({ ... })          // finished current
worker       transitions to idle
orchestrator (later) → worker: run({ prompt: "...", ... }) // reuse the worker
```

`AgentHandle` gains a `runMore(prompt)` method:

```ts
interface AgentHandle {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  wait(): Promise<AgentResult>;
  runMore(prompt: string, opts?: RunMoreOptions): Promise<AgentResult>;  // NEW
  drain(): Promise<void>;                                                // NEW
  kill(): Promise<void>;
  events(): AsyncIterable<LaneEvent>;
}
```

For backward compat, `wait()` on a long-lived handle resolves on the *first* terminal-or-idle transition (whichever comes first); subsequent `runMore` calls return a fresh result.

### 7.5 Pull protocol (opt-in)

When the opentasks adapter is enabled, idle workers can poll for unclaimed tasks within their team scope. Implementation: a `pull_next_task` IPC method routed to the orchestrator's TaskAPI; the orchestrator returns the highest-priority unclaimed task in this team's scope (or `null`). This is a stretch goal — punt to v0.5 unless a concrete need arises.

### 7.6 Resource cost

Long-lived workers cost more idle memory than spawn-per-task. Default policy: workers get drained automatically after `idleTimeoutMs` (configurable; default 10 minutes). The orchestrator can re-spawn a fresh member into the team on demand.

---

## 8. Topology catalog

Each topology is one file under `src/swarm/topologies/`. They share `TeamSession` and don't share state with each other.

### 8.1 `FanoutTopology`

Today's behavior. Independent tasks; no messaging; aggregate concat.

```
spawn N members in parallel → wait all → concat outputs → done
```

`coordination.completion` defaults to `all`. `coordination.aggregator` defaults to `concat`.

Migration: today's `Orchestrator.run(tasks)` becomes `new FanoutTopology(...).run(spec)`. CLI `swarm run tasks.jsonl` synthesizes a `TeamSpec` with `topology: "fanout"`.

### 8.2 `PipelineTopology`

Sequential. Each member's output becomes context for the next.

```
spawn member 0 → wait → take output → spawn member 1 with output as context → wait → ...
```

Default `aggregator: { kind: "last" }`.

Branch policy: members typically share one stream (each commits forward). Configurable via `defaultBranchPolicy`.

### 8.3 `CoordinatorTopology`

cc-swarm-style. Spawn root only. Root's prompt includes the topology and spawn rules. Root is given the `agent` tool and decides when to spawn peers.

```
spawn root member (long-lived) → root makes agent tool calls →
  orchestrator handles each as a member spawn into THIS team scope →
  root reads outputs via send_message / inbox / task_get →
  root finishes when satisfied → team.dispose()
```

This is where Q2's flexibility matters: peers spawned via `agent` tool calls from the root land in the same `TeamSession` (team scope, messaging enabled, branch lock shared) — not as orphan children of the root agent.

Implementation note: the `agent` tool gains a `team` parameter (`undefined` = root's own team; explicit team name = new sub-team). For coordinator topology, defaults to root's team.

### 8.4 `PeerTeamTopology`

The Claude Code teams shape. N parallel, distinct roles/prompts, peers can `send_message` each other freely within scope.

```
spawn N members in parallel → all members run with messaging available →
  members coordinate via send_message / role:x / check_inbox →
  team awaits per CompletionRule →
  aggregate per Aggregator
```

Most flexible. Most likely to surface coordination footguns. Default `completion: all`, `aggregator: concat`.

### 8.5 `CommitteeTopology`

Same prompt to N members; aggregate via vote or judge.

```
spawn N members in parallel, all with same prompt →
  wait all →
  if aggregator = vote: pick majority of structured outputs →
  if aggregator = judge: spawn an additional judge member with all outputs as context, take its verdict →
  return aggregate
```

Branch policy: each member should run in its own scratch (worktree-per-member); v0.7 git-cascade adapter makes this clean. For v0.4, members share branch but the topology warns about it.

### 8.6 `CriticLoopTopology`

Two peers; loop until critic emits an approval signal.

```
spawn executor + critic →
  executor runs prompt, posts result → critic reviews →
  if critic emits signal "APPROVED" (via send_message): break →
  else: critic posts feedback → executor re-runs with feedback context →
  repeat until budget exhausted or signal received
```

`completion: { kind: "until_signal", signal: "APPROVED" }`. `aggregator: { kind: "last" }` (executor's last output).

Per Q4 ("rely on agent flexibility over rigid output structures"): the approval signal is just a `send_message` whose content matches a configurable regex (default exact match `"APPROVED"`). No structured-output schema enforcement; the critic decides when it's done.

### 8.7 Custom topologies

The `Topology` interface is exported. Plugin-loaded custom topologies will work post-v0.5 once the plugin loader gains a topology hook. For v0.4, only built-ins ship.

---

## 8a. Engine-mode parity for team peers

Rewritten 2026-05-02 after spike verification. **All three engine modes can serve as team peers**, each via a distinct mechanism. The original draft of this section claimed framework-mode members couldn't be peers — that was wrong on the technical merits. Empirical evidence and per-mode protocols are in [docs/26-team-orchestration-spikes.md](26-team-orchestration-spikes.md).

### 8a.1 Three paths to peer participation

| Mode | Engine | Mechanism | Empirical status |
|---|---|---|---|
| **Transport** (default) | `ClaudeAgentSdkEngine` w/o `--framework`, `NativeEngine` | swarm-harness owns the loop; Tier 2 tools called natively via `ToolDispatcher`. | Already works ([src/swarm/spawn-integration.test.ts](../src/swarm/spawn-integration.test.ts)). |
| **`claude-agent-sdk` framework** | `ClaudeAgentSdkEngine` w/ `--framework claude-agent-sdk` | Anthropic Agent SDK owns the loop; swarm-harness Tier 2 tools registered via the SDK's `tools` parameter. The SDK calls them through `canUseTool` → swarm-harness's tool implementations → SwarmHost. **Drop the `framework-filter.ts` strip.** | **Track A GREEN** — 8/8 tests pass with strip dropped. See [docs/26 §Track A](26-team-orchestration-spikes.md#track-a--claude-agent-sdk-framework-mode-peer-parity). |
| **`codex-chatgpt` framework** | `CodexFrameworkEngine` w/ `--framework codex-chatgpt` | Codex App Server owns the loop; swarm-harness Tier 2 tools registered via `thread/start.dynamicTools`. Codex sends `item/tool/call` JSON-RPC requests; provider routes to `ToolDispatcher` and replies with `{contentItems, success}`. | **Track B GREEN** — full live round-trip captured at [test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl](../test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl). |

All three converge on the same `ToolDispatcher` in the worker process. Different wire formats, identical semantics. A `peer-team` topology with one member per engine mode works because every member dispatches the same `send_message` / `check_inbox` / `task_*` / `ask_user_question` operations through the same `SwarmHost`.

### 8a.2 What changes vs the v0.3 codebase

Implementation work in v0.4 (see [§13](#13-phased-delivery) for stage breakdown):

1. **Drop the `framework-filter.ts` strip** for team members. The strip was conservative and operates on a tool list that doesn't even contain its targets in the current root-orchestrator code path. Once the team layer mounts Tier 2 tools on the root, the strip would block what we want, so it goes.
2. **Wire `experimentalApi: true` + `dynamicTools` in `CodexAppServerProvider`** at thread start. New JSON-RPC request handler for `item/tool/call` routes to `ToolDispatcher` and formats responses as `DynamicToolCallResponse`.
3. **Fix three pre-existing defects** Track A surfaced:
   - `task_output` calls unsupported `task.get` IPC — add `task.get`/`list`/`create`/`update` IPC handlers in `StandaloneHost.handleWorkerRequest`.
   - Dispatcher doesn't try/catch around `tool.execute()` — wrap.
   - `task_stop` self-stop transport race — flush response before kill.

These three defects exist in v0.3 silently; teams expose them.

### 8a.3 Per-topology compatibility

With the three paths in place, every topology works for every engine mode. The constraint table in the original draft was wrong:

| Topology | Transport | claude-agent-sdk framework | codex-chatgpt framework |
|---|---|---|---|
| `Fanout` | ✅ | ✅ | ✅ |
| `Pipeline` | ✅ | ✅ (via shared task graph + send_message) | ✅ (DynamicToolCall registers task tools) |
| `Coordinator` | ✅ | ✅ (`agent` tool not stripped — was never in the strip list) | ✅ (DynamicToolCall registers `agent`) |
| `PeerTeam` | ✅ | ✅ | ✅ |
| `Committee` | ✅ | ✅ | ✅ |
| `CriticLoop` | ✅ | ✅ | ✅ |

Mixed-engine teams (one Claude member + one ChatGPT member in the same `peer-team`) work. The orchestrator doesn't care which engine produces which member's tool calls — it sees uniform Tier 2 dispatch through `SwarmHost`.

### 8a.4 Codex native multi-agent primitives — still not bridged

Codex App Server has protocol-level multi-agent events (visible in [test/fixtures/codex-app-server/](../test/fixtures/codex-app-server/)):

- `CollabAgentSpawnBegin/End` — Codex spawns sub-agent threads inside its own process.
- `CollabAgentInteractionBegin/End` — Direct agent-to-agent prompt-and-response within Codex.
- `CollabWaitingBegin/End` — Sender parks waiting for N receivers.
- `CollabCloseBegin/End` — Tear down a collaboration channel.
- `CollaborationMode` / `CollaborationModeMask` — Per-thread mode discriminators (`"default"` was observed in the captured trace).

We don't bridge them — the same reasoning still applies even though codex peers now work via `DynamicToolCall`:

1. **Different lifecycle.** Codex's multi-agent is intra-process and stateful (threads persist in one Codex binary). swarm-harness's is inter-process and ephemeral (each member is a subprocess). The mental models don't compose.
2. **Different addressing.** Codex uses internal `ThreadId`s opaque to swarm-harness; swarm-harness uses `AgentId` UUIDs. Translation across the boundary loses identity.
3. **swarm-harness's coordination layer is richer.** Role-addressed broadcast (`role:reviewer`), team-scoped messaging, opentasks-backed shared task graph, MAP scope federation, and git-cascade per-member worktrees have no counterpart in Codex's Collab events.
4. **DynamicToolCall is the right primitive.** It hosts swarm-harness Tier 2 tools cleanly — no impedance mismatch between Codex's intra-process model and swarm-harness's inter-process orchestration.

These remain in non-goals ([§1](#1-goal--non-goals)).

### 8a.5 What framework-mode users still get for single-agent use

Single-agent framework mode is fully supported and unchanged:

```bash
swarm-harness --framework claude-agent-sdk "..."                  # Claude Max via Agent SDK
swarm-harness --framework codex-chatgpt --model gpt-5.4 "..."     # ChatGPT Plus/Pro via Codex
```

These users get framework-owned permissioning, sandboxing, and tool surface. The change in v0.4 is that when these engines run as team members, they get swarm-harness's Tier 2 tools layered on top. Single-agent runs are not affected — `framework-filter` continues to apply when no team is in play, OR the strip is dropped uniformly with the understanding that Tier 2 tools no-op outside a team scope (TBD in §14.Q8).

### 8a.6 Trace evidence

For protocol verification:
- **Track A:** `test/spike-track-a.test.ts` (in spike worktree at `.claude/worktrees/agent-a835be9d41a404060`) — 8 cases, all passing. Reproduce: `SWARM_FRAMEWORK_FILTER_OFF=1 bunx vitest run test/spike-track-a.test.ts`.
- **Track B:** [test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl](../test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl) — 129 frames capturing the full live round-trip with `gpt-5.4`, ChatGPT Plus/Pro auth, ~1ms tool round-trip latency. The agent successfully invoked the registered `swarm_ping` tool and reported the result back.

---

## 9. Coordination

### 9.1 Messaging

| Address | Today | After v0.4 |
|---|---|---|
| `agentId` (direct) | Resolves anywhere in orchestrator | Same (team-cross addressing kept for tools that know an id) |
| `*` | Resolves to all live agents in orchestrator | **Resolves within sender's team scope only** |
| `role:<name>` | All agents with role across orchestrator | **All agents with role within sender's team scope** |

Backward compat: solo runs (no team) implicitly use `swarm:default` scope. Existing tests stay green because the implicit single team has the same semantics.

### 9.2 Shared task list

`TaskAPI` (today's `TaskRegistry`) gains a `scope` filter. `task_list` from a worker filters to the worker's team scope by default. Cross-scope listing is admin-only (orchestrator process; not exposed as a tool).

### 9.3 Aggregation

Per Q4, prefer agents over rigid structured outputs. Default aggregators ship in this priority:

1. `concat` — for fanout / peer-team where each member's output stands alone.
2. `last` — for pipeline / critic-loop where the final stage's output IS the result.
3. `judge` — for committee where N candidates need synthesis. The judge is an agent with tooling = `Read` + `StructuredOutput` (or whatever the user wants).
4. `vote` — escape hatch for cheap deterministic majority. Discouraged unless members are ranking 1–10 or similar.
5. `custom` — fully programmable via callback (test-friendly + power-user).

### 9.4 Completion

`CompletionRule` is interpreted by `TeamSession.await()`:

- `all` — wait every member to reach terminal state.
- `any` — first member's terminal result wins; others get killed; partial usage is recorded.
- `majority` — M of N members complete; rest are drained.
- `deadline` — wall clock cap; on expiry, drain in-flight, return partial.
- `until_signal` — listen for a `send_message` whose content matches the signal; on match, drain.

### 9.5 Failure semantics

- A single member's crash does NOT abort the team unless the topology says so.
- `FanoutTopology`/`PeerTeam`/`Committee`: failed members go to dead-letter; team completion still respects the rule (e.g. `all` waits for the rest).
- `Pipeline`: a failed stage halts the pipeline; remaining members never spawn; team result is failed.
- `Coordinator`: root's failure aborts the team.
- `CriticLoop`: executor failure → team fails; critic failure → executor's last output is taken.

### 9.6 Budget

`coordination.aggregateBudget` caps total tokens/cost across the whole team. Per-member budgets nest under it. On exceed, all in-flight members get killed and `swarm_budget_exceeded` lane event fires (already exists in [src/cli/swarm.ts:196](../src/cli/swarm.ts)).

---

## 10. Ecosystem adapters

Each adapter is one module. All four implement existing swarm-harness interfaces; toggling them on/off doesn't change worker code.

### 10.1 MAP — `src/swarm/adapters/map-adapter.ts` (v0.4)

**Connection:** in-process MAP client (per Q4). The orchestrator instantiates `AgentConnection` from `@multi-agent-protocol/sdk` at startup. One connection per team (scope = `swarm:<name>`).

**Event emission:** the existing `host.emit()` already produces typed lane events. The adapter subscribes to the lane-event stream and forwards relevant ones as MAP events:

| Lane event | MAP method |
|---|---|
| `worker_spawned` | `swarm.agent.spawned` |
| `worker_exited` (success) | `swarm.agent.completed` |
| `worker_exited` (failure) | `swarm.agent.failed` |
| `task_created` / `task_updated` / `task_completed` | `swarm.task.dispatched` / `swarm.task.updated` / `swarm.task.completed` |
| `message_sent` | `swarm.message.sent` |
| `branch_lock_acquired` / `branch_lock_released` | `swarm.branch.locked` / `swarm.branch.released` |

(Exact name mapping matches cc-swarm where overlap exists; new events use the same `swarm.*` namespace.)

**Inbound messages:** MAP can deliver messages to the team scope. Adapter subscribes; routes via `TeamSession.send()` to the appropriate member. Federation (cross-process / cross-machine) Just Works.

**Configuration:**

```jsonc
// .swarm-harness/settings.json
{
  "map": {
    "enabled": true,
    "url": "ws://localhost:8080",      // optional; default from $MAP_URL
    "scope": "swarm:my-team"           // optional; default = derived from team name
  }
}
```

Or per-invocation: `swarm team start --map ws://localhost:8080 ...`.

**Off by default.** When disabled, the orchestrator never imports the MAP SDK (lazy require). No runtime cost.

### 10.2 agent-inbox — pluggable `AgentInbox` (v0.6, Q5)

Per Q5, `AgentInbox` becomes an interface with two implementations:

```ts
interface InboxBackend {
  enqueue(scope: string, to: AgentId, msg: AgentMessage): Promise<number>;
  drain(scope: string, agent: AgentId, max: number): Promise<AgentMessage[]>;
  size(scope: string, agent: AgentId): number;
  discard(scope: string, agent: AgentId): Promise<AgentMessage[]>;
  // Future: read_thread, list_agents, federation hooks
}

class InMemoryInboxBackend implements InboxBackend { /* today's AgentInbox */ }
class AgentInboxBackend implements InboxBackend { /* delegates to agent-inbox MCP/daemon */ }
```

Wire protocol parity is the load-bearing piece. The agent-inbox tools cc-swarm uses (`check_inbox`, `send_message`, `read_thread`, `list_agents`) all map cleanly onto this interface. Threading + federation come for free when the backend flips.

**Open follow-up to agent-inbox:**

1. Document the wire schema as a stable contract (so swarm-harness's in-memory implementation stays compatible with the daemon).
2. Allow the daemon to be embedded as a library (no separate process required) — useful for swarm-harness standalone runs that still want threading + persistence.
3. Decide whether `read_thread` semantics (auto-from-reply-chain vs explicit tags) are part of the protocol or backend-specific.

### 10.3 opentasks — `OpenTasksTaskRegistry` (v0.5, Q6)

Per Q6, `TaskAPI` becomes pluggable:

```ts
class InMemoryTaskRegistry implements TaskAPI { /* today's TaskRegistry */ }
class OpenTasksTaskRegistry implements TaskAPI {
  // Delegates to opentasks daemon via JSON-RPC over Unix socket.
  // graph.create(...) → task_create
  // graph.update(...) → task_update
  // graph.query(...)  → task_list
  // tools.link(...)   → linkTasks (new method on TaskAPI)
}
```

When enabled, the orchestrator's TaskRegistry is backed by `.opentasks/graph.jsonl` instead of memory. Cross-system task graph (Claude Code native tasks, cc-swarm teams, swarm-harness teams) all federate through the same daemon.

**Configuration:**

```jsonc
{
  "opentasks": {
    "enabled": true,
    "socket": ".swarm/opentasks/daemon.sock"   // optional; auto-discovered
  }
}
```

The daemon does its own discovery walk; swarm-harness only needs to know `enabled: true` and call the client.

### 10.4 git-cascade — `BranchPolicy` adapter (v0.7, Q7)

git-cascade exposes `MultiAgentRepoTracker` with: `createStream`, `forkStream`, `mergeStream`, `syncWithParent`, `commitChanges`, `createWorktree`, `cascadeRebase`, plus MAP-compatible event emission already wired ([git-cascade/README.md:144](../references/git-cascade/README.md)).

**Integration shape:**

New `BranchPolicy` variants:

```ts
type BranchPolicy =
  | { kind: "none" }
  | { kind: "reuse"; branch: string }
  | { kind: "create"; from: string; name?: string }
  // NEW v0.7:
  | { kind: "stream"; baseStreamId?: string }    // fork from base or current; create stream + worktree
  | { kind: "fork"; parentStreamId: string }     // explicit fork from a sibling stream
```

**At spawn:**

For each member with a stream/fork policy, the orchestrator:

1. Calls `tracker.createStream({ name, agentId })` (or `forkStream`).
2. Calls `tracker.createWorktree({ agentId, path: <auto>, branch: stream/<id> })`.
3. Spawns the worker with `cwd = <worktree path>`.
4. The worker's `bash` / `write_file` / `edit_file` operate inside the worktree — fully isolated.

**At commit (per `CommitPolicy`):**

The worker's `commit` action calls `tracker.commitChanges` (instead of plain `git commit`). Change-Id trailers, audit log, conflict detection all kick in.

**At team merge:**

When a team finishes, an aggregator policy can call `tracker.mergeStream(...)` for each member's stream. Order + strategy configurable.

**At cascade rebase:**

A pipeline-of-streams (each stage forks from the previous) auto-cascades when an upstream stage gets new commits. `cascade.cascadeRebase` handles propagation.

**Event integration:**

git-cascade already emits MAP-compatible events (`x-cascade/stream.opened`, `.committed`, `.merged`, `.conflicted`, `.abandoned`). The MAP adapter forwards them with no translation. Synergy: enabling `--map` + `--git-cascade` gives full team-of-agents-on-branches observability for free.

**Default policies per topology:**

| Topology | Default `defaultBranchPolicy` |
|---|---|
| Fanout | `{ kind: "stream" }` (each task = own stream) |
| Pipeline | `{ kind: "stream" }` for stage 0; `{ kind: "fork", parent: <prev> }` for later stages |
| Coordinator | `{ kind: "stream" }` for root; spawned peers fork from root |
| PeerTeam | `{ kind: "fork", parent: <team-base-stream> }` for each peer |
| Committee | `{ kind: "stream" }` (each candidate gets own scratch) |
| CriticLoop | `{ kind: "stream" }` (executor); critic uses `kind: "none"` (read-only) |

These are defaults; spec-level overrides win.

---

## 11. CLI surface

### 11.1 Preserved (no behavior change)

```bash
swarm-harness "explain this codebase"           # single-agent, unchanged
swarm-harness swarm run tasks.jsonl --concurrency 5 --output out.jsonl
                                                # synthesizes Fanout TeamSpec; same flags work
```

### 11.2 New: openteams template entry

```bash
swarm-harness team start <template> [opts]      # resolve via openteams; spawn full team
swarm-harness team list                         # show running teams in this orchestrator
swarm-harness team stop <name>                  # graceful drain
swarm-harness team kill <name>                  # immediate kill
swarm-harness team send <name> <prompt>         # push a new prompt to a team (typically root)
```

`team start <template>` resolves `<template>` against:
1. Direct path (`./team.yaml` or absolute path).
2. Project `.openteams/templates/<template>/team.yaml`.
3. Global `~/.openteams/templates/<template>/team.yaml`.
4. openteams built-in registry.

(Same precedence as cc-swarm's `openteams.resolveTemplateName()`.)

### 11.3 New: direct topology entry

For users who don't want a YAML file:

```bash
swarm-harness topology fanout    --tasks tasks.jsonl
swarm-harness topology pipeline  --members 'architect:design.md' 'executor:implement' 'reviewer:approve'
swarm-harness topology committee --members 3 --prompt "Refactor X" --judge reviewer
swarm-harness topology critic-loop --executor build --critic security-reviewer --prompt "..."
swarm-harness topology coordinator --root architect --prompt "..."
swarm-harness topology peer-team --spec ./team-spec.json
```

### 11.4 New: ecosystem flags (additive on any of the above)

```bash
--map [URL]                # enable MAP adapter (default URL from $MAP_URL or settings)
--opentasks               # enable opentasks-backed TaskRegistry
--inbox                   # enable agent-inbox-backed AgentInbox
--git-cascade             # enable git-cascade-backed BranchPolicy
--ecosystem               # shorthand for all four
```

### 11.5 TUI: `/team` slash command

In the interactive REPL, `/team` opens an inline picker for templates / running teams. Pulled into a separate stage of v0.4 implementation.

---

## 12. Migration & compatibility

### 12.1 Backward compatibility

- `swarm run tasks.jsonl` keeps working; internally it builds a `TeamSpec{topology: "fanout"}`.
- `Orchestrator` class signature stays compatible; new methods added, none removed.
- `TaskPacket` shape unchanged. `MemberSpec` is a new sibling type that wraps `TaskPacket` semantics.
- `TaskRegistry`, `AgentInbox`, `RoleIndex` keep their public APIs; their implementations gain scope awareness internally.
- All existing tests pass without modification.

### 12.2 Forward compatibility

- New `TeamSpec` and topology files don't conflict with existing `tasks.jsonl` files; both schemas coexist.
- `team.yaml` (openteams) is read by swarm-harness without requiring cc-swarm; cc-swarm continues to work against the same files.
- ecosystem flags are off by default; nothing breaks if MAP/opentasks/agent-inbox/git-cascade aren't installed.

### 12.3 Doc 15 (parity-gaps) impact

The team orchestration layer closes the v0.4 audit items wholesale (Stage 4A teams, Stage 4B aggregate budget — already done, Stage 4C swarm watch, Stage 4D mock parity). Update doc 15 row A10 from "swarm-harness unique, don't regress" to "swarm-harness lead — full team primitives shipped via TeamSession + topology layer."

---

## 13. Phased delivery

Per Q8: v0.4 = minimum + MAP. Adapters layered after.

### v0.4 — Team primitives + MAP

**Goal:** ship the team model. swarm-harness teams behave like Claude Code teams (peers, scoped messaging, shared task list, named topologies). MAP observability matches cc-swarm.

| Stage | Scope | Effort |
|---|---|---|
| 4A | `TeamSession` primitive + scope-aware `RoleIndex`/`AgentInbox`/`TaskRegistry` | ~3d |
| 4B | `TeamSpec` / `MemberSpec` schema + zod validation | ~1d |
| 4C | Refactor `Orchestrator` to topology-pluggable; ship `FanoutTopology` (preserves today) | ~2d |
| 4D | Long-lived worker mode (`runMore`, `drain`, `idleTimeoutMs`) | ~3d |
| 4E | Topology executors: `Coordinator`, `PeerTeam`, `Pipeline` | ~4d |
| 4F | openteams YAML loader (in-process, library import) | ~3d (depends on openteams API additions) |
| 4G | Drop `framework-filter` strip + verify `claude-agent-sdk` peer parity (Track A close-out) | ~1d |
| 4H | Wire Codex `DynamicToolCall` for `codex-chatgpt` peers (Track B implementation) | ~4d |
| 4I | Fix 3 defects surfaced by Track A: `task.get`/`list`/`create`/`update` IPC handlers, dispatcher try/catch, `task_stop` self-stop transport race | ~1.5d |
| 4J | MAP adapter (in-process; lane-event → MAP forward) | ~3d |
| 4K | CLI: `team start`, `team send`, `topology`, `--map` | ~2d |
| 4L | Tests + doc updates (15, 21, this doc to "shipped") | ~2d |

**Total ~4 weeks.** Acceptance:
- `swarm-harness team start gsd` runs the cc-swarm gsd template against swarm-harness's own runtime, with peers messaging via team scope.
- A `peer-team` of 3 agents (one each in transport, `claude-agent-sdk`, and `codex-chatgpt` engine modes) can `send_message` each other and `task_create` shared tasks; orchestration succeeds.
- Empirical evidence: Track A test suite passes with strip dropped; Track B fixture replays as a golden-trace integration test against the new `DynamicToolCall` wiring.
- With `--map`, an external MAP server sees `swarm.agent.spawned` / `.completed` / `swarm.task.*` events tagged with the right scope.
- `task_output` works for sub-agent workers (regression test); dispatcher returns structured `error` results for thrown tools (regression test); `task_stop` of self does not hang the worker (regression test).
- Existing `swarm run tasks.jsonl` works unchanged; tests green; `--framework claude-agent-sdk` and `--framework codex-chatgpt` single-agent paths still work.

**Engine-mode parity:** v0.4 members can run in any of the three engine modes — `transport` (default), `--framework claude-agent-sdk`, `--framework codex-chatgpt`. All converge on the same `ToolDispatcher` and `SwarmHost` semantics ([§8a](#8a-engine-mode-parity-for-team-peers)).

### v0.5 — Topology long tail + opentasks

| Stage | Scope |
|---|---|
| 5A | `Committee` + `CriticLoop` topologies |
| 5B | `OpenTasksTaskRegistry` adapter (`--opentasks`) |
| 5C | Pull-protocol for long-lived workers (opt-in) |
| 5D | `swarm watch` multi-pane TUI (deferred from v0.4 plan) |
| 5E | Long-lived team daemon (`team start --detach`, `team send`/`list`/`stop`/`kill`/`logs`) — see [docs/28-v0.5-daemon-plan.md](28-v0.5-daemon-plan.md) |

### v0.6 — agent-inbox + threading

| Stage | Scope |
|---|---|
| 6A | `AgentInbox` interface refactor; `InMemoryInboxBackend` + `AgentInboxBackend` |
| 6B | Thread support in messaging (read_thread, send-with-thread-tag) |
| 6C | Federation prep — agent registry view, `agent@system` syntax parse |

### v0.7 — git-cascade

| Stage | Scope |
|---|---|
| 7A | `BranchPolicy` variants `stream` + `fork` |
| 7B | git-cascade adapter wires `createStream`/`createWorktree`/`commitChanges` into worker spawn + commit lifecycle |
| 7C | Cascade rebase on pipeline topologies |
| 7D | Default branch policies per topology (table in §10.4) |

### v0.8+ — long tail

- Custom topology plugins.
- Coordinator-of-coordinators (multi-team in one orchestrator).
- Federated teams via MAP scope subscription.
- Cron-scheduled team launches (PS3).

---

## 14. Open questions

To resolve before / during implementation. Lifted to a decision log as they close.

### v0.4.Q1 — Coordinator topology depth model — RESOLVED 2026-05-02

**Resolution:** flat siblings. All team members (including the coordinator root) are at the same depth under the orchestrator. `agent` tool gains `team?: "self" | "child"` parameter — `"self"` lands the spawn in the caller's team scope (peer), `"child"` lands it as a sub-agent (today's tree-spawn semantics, preserves backward compat). Default depends on topology: coordinator topology root → `"self"`; non-coordinator contexts → `"child"`.

**Linked:** Q10's team-scope peer-stop is a forced consequence — flat siblings have no ancestry between peers, so authorization must be team-scope-based. See [docs/27-v0.4-teams-implementation-plan.md](27-v0.4-teams-implementation-plan.md) §V0.4.Q1.

### v0.4.Q2 — How does a `peer-team` topology bootstrap N peers without a coordinator?

Code-driven: orchestrator reads spec, calls `team.spawnAll(specs)`, each member's prompt is the spec's prompt. But how do members know about each other to message?

- Each member's system prompt gets a "Your teammates:" section listing `[{role, memberId}]`.
- `team_members()` tool returns the list at runtime.

Both. System-prompt for awareness; tool for fresh state (e.g. after a member fails and is replaced).

### v0.4.Q3 — Failure / replacement policy for long-lived workers

If a member dies (subprocess crash) while idle, does the team replace it?

- (a) Replace silently (spawn a fresh worker with same role + memberId).
- (b) Fail the team.
- (c) Configurable per `coordination`.

**Lean:** (c), default = (a) for `peer-team` and `committee`, default = (b) for `pipeline` (replacement loses pipeline state).

### v0.4.Q4 — How does `team send <name> <prompt>` route?

A team's "inbox" needs an entry point. Options:

- (a) Send to the root member (if topology has one — coordinator).
- (b) Broadcast to `*`.
- (c) Route to a designated "lead" role (configurable).

**Lean:** (a) for coordinator/critic-loop/pipeline; (b) for fanout/peer-team/committee; configurable override via team spec's `entryPoint` field.

### v0.4.Q5 — Idle worker timeout & drain semantics

`idleTimeoutMs` default. cc-swarm uses 30 minutes for sidecar; swarm-harness workers hold more state (model, tools, MCP, plugins). Probably 10 minutes default; configurable per-team.

When timeout fires: graceful drain (worker exits cleanly, can be respawned on next push) — not abrupt kill.

### v0.4.Q6 — openteams library API additions

Need from openteams (file separately):

1. `parseTemplate(path | name): Promise<TeamConfig>` — pure, in-process, no codegen step.
2. `materializeRolePrompts(config): Record<role, string>` — return strings, no disk write.
3. Stable types for `topology`, `communication`, `x-*` extension blocks.

If these don't exist yet, swarm-harness can wrap openteams' CLI as a stop-gap (slower, requires Node), but the library API is the right destination.

### v0.4.Q7 — MAP scope conflicts

Two orchestrators running on the same host with the same team name → same scope. MAP server might or might not handle this. Safest: derive scope as `swarm:<teamName>:<orchestratorPid>` for default; let users override for explicit shared scopes.

### v0.4.Q8 — Codex as team substrate — RESOLVED 2026-05-02

**Resolution:** Codex peers ship in v0.4 via Codex App Server's `DynamicToolCall` mechanism. Track B spike GREEN; full live round-trip captured at [test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl](../test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl). The previously-considered alternatives (write a Codex TransportProvider; bridge `Collab*` events) are now both rejected: DynamicToolCall is the right primitive, requires no auth/protocol re-implementation, and works at ~1ms tool round-trip latency. See [§8a.1](#8a1-three-paths-to-peer-participation) and [docs/26 §Track B](26-team-orchestration-spikes.md#track-b--codex-app-server-dynamictoolcall-viability).

### v0.4.Q9 — Mixed-engine consultant pattern (now supplementary)

Originally proposed as the primary mechanism for using Codex from inside a team. With Q8 RESOLVED, codex-backed peers are first-class. The consultant pattern survives as a **supplementary feature** for the case where a transport member wants a one-shot synchronous delegation that does NOT join the team:

- A transport `architect` calls `agent({ prompt: "Critique this design", framework: "codex-chatgpt", wait: true })` and gets back the consultant's final text without that consultant ever entering the team scope.
- Use cases: subscription-quota offload to a different provider for one heavyweight call; capability-gap fill (need Codex's `apply_patch` from inside a non-codex team).

**Lean:** still ship in v0.4 as a small additive surface (~30 LOC change to `agent` tool's input schema). It complements Q8 — Q8 makes the codex peer model possible; Q9 makes one-shot codex delegation cheap and uniform. Decision deferrable to v0.5 if v0.4 scope is tight.

### v0.4.Q10 — Default peer-stop policy — RESOLVED 2026-05-02

**Resolution:** team-scope-allowed peer-stop. `task_stop.ts` checks `caller.scope === target.scope` first (allow), then falls through to ancestry check for cross-scope (allow if caller is ancestor). Forced by Q1's flat-siblings model — peers have no ancestry relationship between themselves. See [docs/27-v0.4-teams-implementation-plan.md](27-v0.4-teams-implementation-plan.md) §V0.4.Q10.

### v0.4.Q11 — Tool subset to register via Codex `DynamicToolCall` — RESOLVED 2026-05-02

**Resolution:** pragmatic 8 tools — `send_message`, `check_inbox`, `task_stop`, `task_output`, `ask_user_question`, `task_get`, `task_list`, `team_members` (new in v0.4). Skip `agent`, `task_create`, `task_update` (semantic clash with Codex's own product concepts; defer until a real use case forces clarity). See [docs/27-v0.4-teams-implementation-plan.md](27-v0.4-teams-implementation-plan.md) §V0.4.Q11.

---

## 15. Next steps

1. **Confirm direction.** This doc, in its current form, is the brainstormed shape. Areas to push back on before code: the topology catalog (§8), the long-lived worker model (§7), and the layering claim (§4.1).
2. **Lock the openteams library API.** §14.Q6. Without this, §10 + §5.4 are aspirational. File a separate issue against openteams for the three additions: `parseTemplate`, `materializeRolePrompts`, stable types for the `topology`/`communication`/`x-*` blocks.
3. **Lock v0.4.Q1 (depth model for coordinator topology).** Affects the `agent` tool change and the `TeamSession.spawnMember` semantics.
4. **Lock v0.4.Q10 (default peer-stop policy)** — recommend (a) team-scope-allowed; ~0.5d implementation in stage 4I alongside the other defect fixes.
5. **Lock v0.4.Q11 (Codex tool subset)** — recommend pragmatic 7 tools (5 coordination + 2 read-only task tools); confirm during stage 4H.
6. **Pre-work design lock.** Before stage 4A, draft a one-pager that nails:
   - The `TaskRegistry`/`AgentInbox`/`RoleIndex` scope-key migration (back-compat tests).
   - The `Orchestrator` → `Topology` refactor diff.
   - The IPC protocol additions (`runMore`, `drain` frames).
   - The new IPC handlers for `task.get`/`list`/`create`/`update` (Track A close-out).
7. **Spike artifact retention.** The Track A worktree (`.claude/worktrees/agent-a835be9d41a404060`) holds a passing test suite (`test/spike-track-a.test.ts`, 8 cases) that proves the engine-mode parity claims. Keep the worktree until stage 4G ships and ports those tests into the main suite. The Track B trace fixture ([test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl](../test/fixtures/codex-app-server/dynamic-tool-call-spike.jsonl)) becomes a golden-trace integration test under stage 4H.
8. **Tracking.** When v0.4 stages execute, mirror the doc 21 / doc 22 / doc 23 pattern: each stage gets a commit, this doc gets a "shipped" entry in §13, doc 15 gets the row update.

---

## 16. v0.4 close-out

Shipped 2026-05-02. 18 stage commits in `0bd0f20..<close-out>`.

Stage commits — see [docs/27 §13](27-v0.4-teams-implementation-plan.md#stage-breakdown) for the per-stage scope detail:

- pre-work — `0bd0f20` — design + spike findings + implementation plan
- 4A.1 — `929fae5` — data plumbing: scope on `SpawnRequest` + `TaskRecord`
- 4A.2 — `36c714c` — `RoleIndex` scope migration
- 4A.3 — `0393ab0` — `StandaloneHost` scope awareness
- 4A.4 — `e1234b8` — `TeamSession` primitive
- 4B   — `36a32a6` — `TeamSpec` / `MemberSpec` schema + zod validation
- 4C   — `4d8ada4` — refactor `Orchestrator` to topology-pluggable shell
- 4D   — `3ca2867` — long-lived worker mode (`runMore`, `drain`, idle/drained states)
- 4E.1 — `4433568` — `agent.team` parameter + `team_members` tool
- 4E.2 — `ae73212` — `PipelineTopology`
- 4E.3 — `8ed5bb5` — `PeerTeamTopology`
- 4E.4 — `9e4c3a7` — `CoordinatorTopology`
- 4F   — `47ab087` — openteams YAML loader + minimal `team start` CLI
- 4G   — `40d222b` — drop framework-filter strip + Track A close-out
- 4H   — `2d7f1f6` — Codex `DynamicToolCall` wiring for codex peer parity
- 4I   — `44b9390` — Track A defect fixes (task IPC handlers, dispatcher try/catch, self-stop race)
- 4J   — `f8a4343` — in-process MAP adapter
- 4K   — `a4defac` — broader CLI surface — topology subcommand + team stubs
- 4L   — `<this commit>` — docs flipped to shipped

Tests at v0.4: 149 files / 1692 passing, `tsc --noEmit` clean. Backward
compat preserved end-to-end — `swarm run tasks.jsonl` produces byte-
identical results.jsonl as v0.3; existing single-agent CLI paths
unaffected; `--framework claude-agent-sdk` and `--framework codex-
chatgpt` single-agent runs still work; v0.3 codex App Server
integration unchanged.

Multi-engine peer parity (the headline of v0.4): a peer-team can now
mix members across all three engine modes — transport (default),
`--framework claude-agent-sdk`, `--framework codex-chatgpt` — and
they all converge on the same `SwarmHost` semantics. Track A
defects closed; Track B's `DynamicToolCall` mechanism wired with the
8-tool subset per V0.4.Q11.

Deferred to later releases per [docs/27 §13](27-v0.4-teams-implementation-plan.md) phasing:

- `Committee` + `CriticLoop` topologies → v0.5
- opentasks adapter → v0.5
- Pull-protocol for long-lived workers → v0.5
- `swarm watch` multi-pane TUI → v0.5
- agent-inbox MCP integration → v0.6
- git-cascade `BranchPolicy` adapter → v0.7
- Long-lived team daemon (`team send`/`list`/`stop`/`kill` cross-process) → v0.5+

---

## 17. Implementation status (post-4M review fixes)

After v0.4 was tagged at `53d22e1` (stage 4L), a 3-reviewer code-review surfaced 3 BLOCKERs and 7 MAJORs. They were addressed across three sub-commits — `12f48ab` (4M.1), `21d0106` (4M.2), and `e2262fe` (4M.3). All 10 review-pass issues are closed. This section documents what's possible end-to-end, what's constrained, and what's deferred.

Final test posture after 4M.3: 149 files / 1704 passing. `tsc --noEmit` clean.

### 17.1 What's now possible

User-facing flows that work end-to-end as of 4M.3:

- **Run an openteams template** via `swarm-harness team start <template>` (resolves through the openteams CLI; template loader cleans up its tmpdir asynchronously per M7).
- **Run a custom topology from a JSON spec** via `swarm-harness topology <kind> --spec <path>` for any of the 4 shipped topology kinds.
- **Mixed-engine peer teams** across all 3 engine modes — a single team can mix transport peers (default), `--framework claude-agent-sdk` peers, and `--framework codex-chatgpt` peers, all converging on the same `SwarmHost` semantics.
- **All 4 shipped topologies:**
    - `Fanout` — broadcast a task list to a worker pool with role overlays, retry, dead-letter (extracted from the v0.3 orchestrator).
    - `Pipeline` — sequential stages, each member's output feeds the next.
    - `Coordinator` — root agent in StandaloneHost spawns and supervises peer agents.
    - `PeerTeam` — N peers in a shared scope with lateral messaging and shared task graph.
- **Live coordination primitives within a team:** `send_message`, `check_inbox`, `team_members`, `task_get` / `task_list` / `task_create` / `task_update` / `task_stop` / `task_output`, `ask_user_question` (Tier 2 set, all 10 tools registered for transport + claude-agent-sdk peers).
- **Long-lived workers** via `SpawnRequest.longLived` — workers transition correctly through `running → idle → prompt_accepted → running` cycles and can be resumed with `runMore` or terminated with `drain` (FSM transitions hardened in 4M.3).
- **External observability via MAP** — `--map [URL]` emits lane events to a remote observer; `--ecosystem` is a v0.4 shorthand for `--map`. MAP receives `worker_spawned` / `worker_exited` lifecycle events in production runs (B3 fix).
- **Backward compat:** `swarm run tasks.jsonl` produces byte-identical results.jsonl to v0.3; single-agent CLI paths unchanged; both `--framework` modes still work for single-agent runs.

### 17.2 Constrained / works with caveats

Things that exist but have known limitations:

- **Cross-process team management** — shipped in v0.5 (stages 5E.1–5E.7). `team start <template> --detach` forks a per-team daemon; `team list`, `team logs [--follow]`, `team stop <name>`, `team kill <name>` work against running daemons over a Unix socket under `${XDG_RUNTIME_DIR}/swarm-harness/teams/<name>/`. `team send` returns a structured "needs persistent-team support" error pointing at v0.6+ — pushing prompts into a long-running team requires the orchestrator to expose its active TeamSession.send surface (V0.5.Q6). See [docs/28-v0.5-daemon-plan.md](28-v0.5-daemon-plan.md) for the full design + signoff trail.
- **Worker-side `agent({team: "self"})`** — SHIPPED in 4M.7. WorkerHost gained scope awareness (reads `SWARM_HARNESS_TEAM_SCOPE` env, exposes `scopeOf`); the spawn IPC handler (4M.6) honors a caller-supplied `teamScope`. Closes the V0.4.Q1 follow-up. The B2 rejection added in 4M.1 is replaced by the unified scopeOf path. Both worker-side `team: "child"` (default child-spawn) and `team: "self"` (peer-spawn into caller's team) now work end-to-end at the unit level.
- **Mixed-engine consultant pattern** (V0.4.Q9) — **shipped end-to-end as of 4M.9** (2026-05-04). Live consultant smoke `scripts/smoke-codex-consultant.sh` PASS: Claude transport → agent tool → IPC spawn → Codex App Server → ChatGPT → reply round-trips correctly. Earlier 4M.8 live finding traced to a project-wide JSON Schema generation bug — every Tier 2 tool's `inputSchema` was effectively empty (`zod-to-json-schema` v3 silently emits `{$schema: "..."}` for zod v4 inputs), which OpenAI rejected at the first turn that registered Tier 2 tools as dynamicTools. 4M.9 switches all 25 callers to zod v4 native `z.toJSONSchema` and improves the codex-app-server error-notification fallback so missing-message errors expose the full payload instead of becoming "Unknown error".
- **Codex 8/10 tool subset** — codex peers register 8 of the 10 Tier 2 tools per V0.4.Q11. Skipped: `agent`, `task_create`, `task_update` (semantic clash with Codex's own product concepts). The set is additive — register more in v0.5 if dogfooding shows demand.
- **Single team per orchestrator** — v0.4 runs one team at a time per orchestrator process. Multi-team-in-one-orchestrator (coordinator-of-coordinators) is deferred to v0.8+ per §6.4.

### 17.3 Future work (not in v0.4)

Restated concisely from the §13 phasing roadmap:

- **v0.5:** Committee + CriticLoop topologies; opentasks adapter; pull-protocol for long-lived workers; `swarm watch` multi-pane TUI. **Long-lived team daemon shipped in 5E.1–5E.7** ([docs/28](28-v0.5-daemon-plan.md)).
- **v0.6:** agent-inbox MCP integration (threaded persistent messaging, federation).
- **v0.7:** git-cascade adapter (worktree-per-member, cascade rebase, branch streams).
- **v0.8+:** Coordinator-of-coordinators (multi-team in one orchestrator); MAP federation across orchestrators.
- **Deferred indefinitely:** Bridging Codex's native `Collab*` events; multi-thread Codex process pooling; worker-spawned peers via spawn IPC handler (V0.4.Q1 follow-up); `Codex TransportProvider` (only if a real user need surfaces).

### 17.4 Review-fix index (4M.1–4M.3)

| Issue | Type | Fixed in | What changed |
|---|---|---|---|
| B1 | BLOCKER | 4M.1 (`12f48ab`) | `message_sent` lane event payload now carries `content` (was `{from, to, correlationId?}` only); `until_signal` listener now sees real payloads. |
| B2 | BLOCKER | 4M.1 (`12f48ab`) | Worker-side `agent({team: "self"})` returns structured error pointing to v0.5+. |
| B3 | BLOCKER | 4M.2 (`21d0106`) | `StandaloneHost` emits `worker_spawned` / `worker_exited` lane events; MAP adapter receives lifecycle telemetry in production runs. |
| M1 | MAJOR | 4M.2 (`21d0106`) | `TeamSession` registers stable `memberId` via new `setMemberId` / `memberIdOf` accessors; `team_members` returns it instead of echoing `agentId`. |
| M2 | MAJOR | 4M.2 (`21d0106`) | `TeamSession.spawnAll` uses `Promise.allSettled` + cleanup on partial failure. |
| M3 | MAJOR | 4M.1 (`12f48ab`) | `team_aborted` payload standardized on `memberResults` (was `stagesCompleted` in some emit sites). |
| M4 | MAJOR | 4M.1 (`12f48ab`) | Long-lived worker uses `IPC_ERROR_CODES.INVALID_PARAMS` constant (was string literal). |
| M5 | MAJOR | 4M.3 (`e2262fe`) | Long-lived worker FSM transitions correctly: `running → idle → prompt_accepted → running` cycle (was stuck in `finished` / `failed` after first turn). |
| M6 | MAJOR | 4M.3 (`e2262fe`) | `run_more` listener attached once at top-level + frame buffer; no race window between `worker_idle` notify and listener re-attach. |
| M7 | MAJOR | 4M.1 (`12f48ab`) | openteams loader `await fs.rm` in finally with try/catch (was fire-and-forget). |

---

## Appendix A — File layout (target end-state)

```
src/swarm/
├── ancestry.ts                 (today)
├── dead-letter.ts              (today)
├── depth-limit.ts              (today)
├── events.ts                   (today)
├── host.ts                     (today)
├── inbox.ts                    (today; refactored to InboxBackend interface)
├── orchestrator.ts             (today; refactored to topology-pluggable shell)
├── permission-order.ts         (today)
├── policies.ts                 (today)
├── retry-policy.ts             (today)
├── role-index.ts               (today; scope-aware)
├── roles.ts                    (today)
├── standalone-host.ts          (today; scope-aware)
├── subprocess-spawner.ts       (today)
├── task-registry.ts            (today; refactored to TaskAPI interface)
├── typed-events.ts             (today)
├── worker-host.ts              (today)
├── worker-lifecycle.ts         (today; new idle/drain states)
├── worker-pool.ts              (today)
├── worker-state-file.ts        (today)
│
├── team-session.ts             (NEW v0.4 — Layer 3 primitive)
├── team-spec.ts                (NEW v0.4 — TeamSpec/MemberSpec types + zod)
├── topologies/
│   ├── index.ts                (NEW v0.4)
│   ├── fanout.ts               (NEW v0.4 — extracted from orchestrator.ts)
│   ├── pipeline.ts             (NEW v0.4)
│   ├── coordinator.ts          (NEW v0.4)
│   ├── peer-team.ts            (NEW v0.4)
│   ├── committee.ts            (NEW v0.5)
│   └── critic-loop.ts          (NEW v0.5)
├── adapters/
│   ├── map-adapter.ts          (NEW v0.4)
│   ├── opentasks-task-registry.ts  (NEW v0.5)
│   ├── agent-inbox-backend.ts  (NEW v0.6)
│   └── git-cascade-branch-policy.ts (NEW v0.7)
├── openteams/
│   ├── loader.ts               (NEW v0.4 — wraps openteams library)
│   └── mapping.ts              (NEW v0.4 — yaml → TeamSpec)
└── git/                        (today; some entries gain stream-aware variants in v0.7)
```

## Appendix B — Lane events added/changed by this design

| Event | Status | Payload |
|---|---|---|
| `team_started` | NEW | `{ teamName, scope, topology, memberCount }` |
| `team_member_spawned` | NEW | `{ teamName, role, memberId, agentId }` |
| `team_member_idle` | NEW | `{ teamName, memberId, agentId }` |
| `team_member_resumed` | NEW | `{ teamName, memberId, agentId, prompt: <truncated> }` |
| `team_member_drained` | NEW | `{ teamName, memberId, agentId, reason }` |
| `team_completed` | NEW | `{ teamName, scope, completion: "all" \| "any" \| ..., memberResults: count }` |
| `team_aborted` | NEW | `{ teamName, scope, reason }` |
| `team_signal_received` | NEW | `{ teamName, signal, fromAgentId }` |
| `worker_lifecycle_changed` | EXTEND | new transitions: `running → idle`, `idle → running`, `idle → finished` |

Each gains a typed variant under `TypedLaneEvent` (per the rolling-migration policy in [docs/15-parity-gaps.md A5](15-parity-gaps.md)).
